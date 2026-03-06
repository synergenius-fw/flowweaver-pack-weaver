import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  BotConfig,
  BotNotifyConfig,
  WeaverConfig,
  WorkflowResult,
} from './types.js';
import {
  createProvider,
  resolveProviderConfig,
} from './agent-provider.js';
import { BotAgentChannel } from './bot-agent-channel.js';
import {
  WebhookNotificationChannel,
  createNotifier,
} from './notifications.js';

function resolveApproval(
  approval: BotConfig['approval'],
): { mode: 'auto' | 'timeout-auto'; timeoutSeconds: number } {
  if (!approval || approval === 'auto') {
    return { mode: 'auto', timeoutSeconds: 300 };
  }
  if (approval === 'timeout-auto') {
    return { mode: 'timeout-auto', timeoutSeconds: 300 };
  }
  return {
    mode: approval.mode,
    timeoutSeconds: approval.timeoutSeconds ?? 300,
  };
}

function resolveNotify(
  notify: BotConfig['notify'],
): BotNotifyConfig[] {
  if (!notify) return [];
  return Array.isArray(notify) ? notify : [notify];
}

function resolveWeaverConfig(
  filePath: string,
  explicit?: WeaverConfig,
): WeaverConfig {
  if (explicit) return explicit;

  // Check .weaver.json next to the workflow file
  const dir = path.dirname(filePath);
  const localConfig = path.join(dir, '.weaver.json');
  if (fs.existsSync(localConfig)) {
    return JSON.parse(fs.readFileSync(localConfig, 'utf-8'));
  }

  // Check .weaver.json in cwd
  const cwdConfig = path.join(process.cwd(), '.weaver.json');
  if (fs.existsSync(cwdConfig)) {
    return JSON.parse(fs.readFileSync(cwdConfig, 'utf-8'));
  }

  // No config file found: fall back to auto-detection
  return { provider: 'auto' };
}

// ============================================================
// Generic workflow runner
// ============================================================

export async function runWorkflow(
  filePath: string,
  options?: {
    params?: Record<string, unknown>;
    verbose?: boolean;
    dryRun?: boolean;
    config?: WeaverConfig;
  },
): Promise<WorkflowResult> {
  const absPath = path.resolve(filePath);
  const verbose = options?.verbose ?? false;

  if (!fs.existsSync(absPath)) {
    throw new Error(`Workflow file not found: ${absPath}`);
  }

  // Resolve config
  const config = resolveWeaverConfig(absPath, options?.config);

  // Create provider and notification channels
  const providerConfig = resolveProviderConfig(config.provider);
  const approvalConfig = resolveApproval(config.approval);
  const notifyConfigs = resolveNotify(config.notify);

  const provider = createProvider(providerConfig);
  const channels = notifyConfigs.map((c) => new WebhookNotificationChannel(c));
  const notifier = createNotifier(channels);

  const projectDir = path.dirname(absPath);

  if (verbose) {
    console.log(`[weaver] Workflow: ${absPath}`);
    const providerLabel = providerConfig.model
      ? `${providerConfig.name} (${providerConfig.model})`
      : providerConfig.name;
    console.log(`[weaver] Provider: ${providerLabel}`);
    console.log(`[weaver] Approval: ${approvalConfig.mode}`);
    console.log(`[weaver] Notifications: ${channels.length} channel(s)`);
  }

  // Notify start
  await notifier({
    type: 'workflow-start',
    workflowFile: absPath,
    projectDir,
  });

  const botChannel = new BotAgentChannel(provider, {
    approvalMode: approvalConfig.mode,
    approvalTimeoutSeconds: approvalConfig.timeoutSeconds,
    notifier,
    context: { projectDir, workflowFile: absPath },
  });

  try {
    const mod = '@synergenius/flow-weaver/executor';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executeWorkflowFromFile } = await (import(mod) as Promise<any>);

    if (options?.dryRun) {
      console.log('[weaver] Dry run, skipping execution');
      return { success: true, summary: 'Dry run', outcome: 'skipped' };
    }

    const execResult = await executeWorkflowFromFile(
      absPath,
      options?.params ?? {},
      {
        agentChannel: botChannel,
        includeTrace: false,
        production: true,
      },
    );

    const result = execResult.result as {
      onSuccess?: boolean;
      summary?: string;
    } | null;

    const success = result?.onSuccess ?? false;
    const summary = result?.summary ?? 'No summary';
    const outcome = success ? 'completed' : 'failed';

    await notifier({
      type: 'workflow-complete',
      workflowFile: absPath,
      projectDir,
      summary,
      outcome,
    });

    return {
      success,
      summary,
      outcome,
      functionName: execResult.functionName,
      executionTime: execResult.executionTime,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);

    await notifier({
      type: 'error',
      workflowFile: absPath,
      projectDir,
      error: msg,
    });

    return { success: false, summary: msg, outcome: 'error' };
  }
}

