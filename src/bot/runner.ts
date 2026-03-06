import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ApprovalMode,
  BotConfig,
  BotNotifyConfig,
  ExecutionEvent,
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
import type { NotificationErrorHandler } from './notifications.js';

function resolveApproval(
  approval: BotConfig['approval'],
): { mode: ApprovalMode; timeoutSeconds: number; webhookUrl?: string } {
  if (!approval || approval === 'auto') {
    return { mode: 'auto', timeoutSeconds: 300 };
  }
  if (typeof approval === 'string') {
    return { mode: approval, timeoutSeconds: 300 };
  }
  return {
    mode: approval.mode,
    timeoutSeconds: approval.timeoutSeconds ?? 300,
    webhookUrl: approval.webhookUrl,
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

  const dir = path.dirname(filePath);
  const localConfig = path.join(dir, '.weaver.json');
  if (fs.existsSync(localConfig)) {
    return JSON.parse(fs.readFileSync(localConfig, 'utf-8'));
  }

  const cwdConfig = path.join(process.cwd(), '.weaver.json');
  if (fs.existsSync(cwdConfig)) {
    return JSON.parse(fs.readFileSync(cwdConfig, 'utf-8'));
  }

  return { provider: 'auto' };
}

function buildSummary(result: unknown): string {
  if (!result || typeof result !== 'object') return String(result);

  const r = result as Record<string, unknown>;
  if (typeof r.summary === 'string') return r.summary;

  // Build a meaningful summary from whatever the workflow returned
  const parts: string[] = [];
  for (const [key, value] of Object.entries(r)) {
    if (key === 'onSuccess' || key === 'onFailure') continue;
    if (value === null || value === undefined) continue;
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    parts.push(`${key}: ${str.length > 100 ? str.slice(0, 100) + '...' : str}`);
  }
  return parts.length > 0 ? parts.join(', ') : 'completed';
}

export async function runWorkflow(
  filePath: string,
  options?: {
    params?: Record<string, unknown>;
    verbose?: boolean;
    dryRun?: boolean;
    config?: WeaverConfig;
    onEvent?: (event: ExecutionEvent) => void;
    onNotificationError?: NotificationErrorHandler;
  },
): Promise<WorkflowResult> {
  const absPath = path.resolve(filePath);
  const verbose = options?.verbose ?? false;

  if (!fs.existsSync(absPath)) {
    throw new Error(`Workflow file not found: ${absPath}`);
  }

  const config = resolveWeaverConfig(absPath, options?.config);
  const providerConfig = resolveProviderConfig(config.provider);
  const approvalConfig = resolveApproval(config.approval);
  const notifyConfigs = resolveNotify(config.notify);

  const provider = createProvider(providerConfig);
  const channels = notifyConfigs.map(
    (c) => new WebhookNotificationChannel(c, options?.onNotificationError),
  );
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

  await notifier({
    type: 'workflow-start',
    workflowFile: absPath,
    projectDir,
  });

  const botChannel = new BotAgentChannel(provider, {
    approvalMode: approvalConfig.mode,
    approvalTimeoutSeconds: approvalConfig.timeoutSeconds,
    approvalWebhookUrl: approvalConfig.webhookUrl,
    notifier,
    context: { projectDir, workflowFile: absPath },
  });

  try {
    const mod = '@synergenius/flow-weaver/executor';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executeWorkflowFromFile } = await (import(mod) as Promise<any>);

    if (options?.dryRun) {
      if (verbose) console.log('[weaver] Dry run, skipping execution');
      return { success: true, summary: 'Dry run', outcome: 'skipped' };
    }

    // Forward trace events as ExecutionEvents
    const onTraceEvent = options?.onEvent
      ? (traceEvent: { type: string; timestamp: number; data?: Record<string, unknown> }) => {
          if (traceEvent.type !== 'STATUS_CHANGED' || !traceEvent.data) return;
          const nodeId = traceEvent.data.id as string | undefined;
          const status = traceEvent.data.status as string | undefined;
          if (!nodeId || !status) return;

          let eventType: ExecutionEvent['type'] | null = null;
          if (status === 'RUNNING') eventType = 'node-start';
          else if (status === 'SUCCEEDED') eventType = 'node-complete';
          else if (status === 'FAILED') eventType = 'node-error';

          if (eventType) {
            options.onEvent!({
              type: eventType,
              nodeId,
              nodeType: traceEvent.data.nodeTypeName as string | undefined,
              timestamp: traceEvent.timestamp,
              error: traceEvent.data.error as string | undefined,
            });
          }
        }
      : undefined;

    const execResult = await executeWorkflowFromFile(
      absPath,
      options?.params ?? {},
      {
        agentChannel: botChannel,
        includeTrace: !!onTraceEvent,
        production: !onTraceEvent,
        onEvent: onTraceEvent,
      },
    );

    const result = execResult.result as Record<string, unknown> | null;
    const success = (result?.onSuccess as boolean) ?? false;
    const summary = buildSummary(result);
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
