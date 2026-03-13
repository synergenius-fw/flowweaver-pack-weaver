import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ApprovalMode,
  AuditEventCallback,
  BotConfig,
  BotNotifyConfig,
  ExecutionEvent,
  RunOutcome,
  WeaverConfig,
  WorkflowResult,
} from './types.js';
import { initAuditLogger, auditEmit, teardownAuditLogger } from './audit-logger.js';
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
import { RunStore } from './run-store.js';
import { CostTracker } from './cost-tracker.js';
import { CostStore } from './cost-store.js';

function resolveApproval(
  approval: BotConfig['approval'],
): { mode: ApprovalMode; timeoutSeconds: number; webhookUrl?: string; webOpen?: boolean } {
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
    webOpen: approval.webOpen,
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
    return parseConfigFile(localConfig);
  }

  const cwdConfig = path.join(process.cwd(), '.weaver.json');
  if (fs.existsSync(cwdConfig)) {
    return parseConfigFile(cwdConfig);
  }

  return { provider: 'auto' };
}

function parseConfigFile(configPath: string): WeaverConfig {
  const content = fs.readFileSync(configPath, 'utf-8');
  try {
    return JSON.parse(content) as WeaverConfig;
  } catch {
    throw new Error(
      `Invalid JSON in config file: ${configPath}\n` +
      `  Fix the file or delete it to use defaults.`,
    );
  }
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
    onAuditEvent?: AuditEventCallback;
    onNotificationError?: NotificationErrorHandler;
    dashboardServer?: import('./dashboard.js').DashboardServer;
  },
): Promise<WorkflowResult> {
  const absPath = path.resolve(filePath);
  const verbose = options?.verbose ?? false;

  let store: RunStore | null = null;
  try { store = new RunStore(); } catch { /* non-fatal */ }
  const runId = RunStore.newId();
  const startedAt = new Date().toISOString();
  initAuditLogger(runId, options?.onAuditEvent);

  // Mark run as in-progress so abrupt kills leave a trace
  try { store?.markRunning(runId, absPath); } catch { /* non-fatal */ }

  if (!fs.existsSync(absPath)) {
    throw new Error(`Workflow file not found: ${absPath}`);
  }

  const config = resolveWeaverConfig(absPath, options?.config);
  const providerConfig = resolveProviderConfig(config.provider);
  const approvalConfig = resolveApproval(config.approval);
  const notifyConfigs = resolveNotify(config.notify);

  const provider = await createProvider(providerConfig);

  const costTracker = new CostTracker(providerConfig.model ?? 'unknown', providerConfig.name);
  provider.onUsage = (step, model, usage) => costTracker.track(step, model, usage);
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

  auditEmit('run-start', { workflowFile: absPath, provider: providerConfig.name, projectDir });

  await notifier({
    type: 'workflow-start',
    workflowFile: absPath,
    projectDir,
  });

  const botChannel = new BotAgentChannel(provider, {
    approvalMode: approvalConfig.mode,
    approvalTimeoutSeconds: approvalConfig.timeoutSeconds,
    approvalWebhookUrl: approvalConfig.webhookUrl,
    approvalWebOpen: approvalConfig.webOpen,
    dashboardServer: options?.dashboardServer,
    notifier,
    context: { projectDir, workflowFile: absPath },
  });

  try {
    const mod = '@synergenius/flow-weaver/executor';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executeWorkflowFromFile } = await (import(mod) as Promise<any>);

    if (options?.dryRun) {
      if (verbose) console.log('[weaver] Dry run, skipping execution');
      const dryResult: WorkflowResult = { success: true, summary: 'Dry run', outcome: 'skipped' };
      recordRun(store, { id: runId, workflowFile: absPath, startedAt, success: true, outcome: 'skipped', summary: 'Dry run', dryRun: true, provider: providerConfig.name, params: options?.params }, verbose);
      return dryResult;
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

    const costSummary = costTracker.hasEntries() ? costTracker.getRunSummary() : undefined;
    persistCost(costSummary, absPath, providerConfig.name, verbose);
    recordRun(store, {
      id: runId, workflowFile: absPath, startedAt, success, outcome: outcome as RunOutcome, summary,
      functionName: execResult.functionName, executionTime: execResult.executionTime,
      dryRun: false, provider: providerConfig.name, params: options?.params,
    }, verbose);

    auditEmit('run-complete', { success, outcome, summary });

    return {
      success,
      summary,
      outcome,
      functionName: execResult.functionName,
      executionTime: execResult.executionTime,
      cost: costSummary,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);

    await notifier({
      type: 'error',
      workflowFile: absPath,
      projectDir,
      error: msg,
    });

    const costSummary = costTracker.hasEntries() ? costTracker.getRunSummary() : undefined;
    persistCost(costSummary, absPath, providerConfig.name, verbose);
    recordRun(store, {
      id: runId, workflowFile: absPath, startedAt, success: false, outcome: 'error', summary: msg,
      dryRun: options?.dryRun ?? false, provider: providerConfig.name, params: options?.params,
    }, verbose);

    auditEmit('run-complete', { success: false, error: msg });

    return { success: false, summary: msg, outcome: 'error', cost: costSummary };
  } finally {
    teardownAuditLogger();
  }
}

function recordRun(
  store: RunStore | null,
  data: {
    id: string; workflowFile: string; startedAt: string; success: boolean;
    outcome: RunOutcome; summary: string; functionName?: string;
    executionTime?: number; dryRun: boolean; provider?: string;
    params?: Record<string, unknown>;
  },
  verbose: boolean,
): void {
  if (!store) return;
  const finishedAt = new Date().toISOString();
  try {
    store.append({
      ...data,
      finishedAt,
      durationMs: new Date(finishedAt).getTime() - new Date(data.startedAt).getTime(),
    });
    store.clearRunning(data.id);
  } catch (err) {
    if (verbose) console.error(`[weaver] Failed to record run history: ${err}`);
  }
}

function persistCost(
  costSummary: import('./types.js').RunCostSummary | undefined,
  workflowFile: string,
  provider: string,
  verbose: boolean,
): void {
  if (!costSummary || costSummary.totalInputTokens === 0) return;
  try {
    new CostStore().append({
      timestamp: Date.now(),
      workflowFile,
      provider,
      model: costSummary.model,
      inputTokens: costSummary.totalInputTokens,
      outputTokens: costSummary.totalOutputTokens,
      estimatedCost: costSummary.totalCost,
      steps: costSummary.entries.length,
    });
  } catch (err) {
    if (verbose) console.error(`[weaver] Failed to persist cost data: ${err}`);
  }
}
