import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runWorkflow } from './bot/runner.js';
import { RunStore } from './bot/run-store.js';
import { CostStore } from './bot/cost-store.js';
import { defaultRegistry, discoverProviders } from './bot/provider-registry.js';
import { WatchDaemon } from './bot/watch-daemon.js';
import { PipelineRunner } from './bot/pipeline-runner.js';
import { DashboardServer } from './bot/dashboard.js';
import { openBrowser } from './bot/utils.js';
import type { ExecutionEvent, WeaverConfig, RunRecord, RunOutcome, RunCostSummary, CostSummary, StageStatus, WorkflowResult, AuditEvent } from './bot/types.js';
import { AuditStore } from './bot/audit-store.js';

export interface ParsedArgs {
  command: 'run' | 'history' | 'costs' | 'providers' | 'watch' | 'cron' | 'pipeline' | 'dashboard' | 'eject' | 'bot' | 'session' | 'steer' | 'queue' | 'status' | 'genesis' | 'audit' | 'init';
  file?: string;
  verbose: boolean;
  dryRun: boolean;
  quiet: boolean;
  params?: Record<string, unknown>;
  configPath?: string;
  showHelp: boolean;
  showVersion: boolean;
  // history
  historyId?: string;
  historyLimit: number;
  historyOutcome?: string;
  historyWorkflow?: string;
  historySince?: string;
  historyJson: boolean;
  historyPrune: boolean;
  historyClear: boolean;
  // costs
  costsSince?: string;
  costsModel?: string;
  // watch/cron
  cronSchedule?: string;
  debounceMs: number;
  logFile?: string;
  // pipeline
  pipelineStage?: string;
  // dashboard
  dashboard: boolean;
  dashboardPort: number;
  dashboardOpen: boolean;
  // approval override
  approvalMode?: string;
  // bot
  botTask?: string;
  botFile?: string;
  botTemplate?: string;
  botBatch?: number;
  autoApprove: boolean;
  // genesis
  genesisInit: boolean;
  genesisWatch: boolean;
  // eject
  ejectWorkflow?: string;
  // session scheduling
  sessionContinuous: boolean;
  sessionUntil?: string;
  sessionMaxTasks?: number;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    command: 'run',
    file: undefined,
    verbose: false,
    dryRun: false,
    quiet: false,
    params: undefined,
    configPath: undefined,
    showHelp: false,
    showVersion: false,
    historyLimit: 20,
    historyJson: false,
    historyPrune: false,
    historyClear: false,
    debounceMs: 500,
    dashboard: false,
    dashboardPort: 4242,
    dashboardOpen: false,
    autoApprove: false,
    genesisInit: false,
    genesisWatch: false,
    sessionContinuous: false,
  };

  const args = argv.slice(2);
  let i = 0;

  while (i < args.length) {
    const arg = args[i]!;

    if (arg === '--help' || arg === '-h') {
      result.showHelp = true;
    } else if (arg === '--version') {
      result.showVersion = true;
    } else if (arg === '--verbose' || arg === '-v') {
      result.verbose = true;
    } else if (arg === '--dry-run' || arg === '-n') {
      result.dryRun = true;
    } else if (arg === '--quiet') {
      result.quiet = true;
    } else if ((arg === '--params' || arg === '-p') && i + 1 < args.length) {
      i++;
      try {
        result.params = JSON.parse(args[i]!);
      } catch {
        console.error(`[weaver] Invalid JSON for --params: ${args[i]}`);
        process.exit(1);
      }
    } else if ((arg === '--config' || arg === '-c') && i + 1 < args.length) {
      i++;
      result.configPath = args[i];
    } else if (arg === '--limit' && i + 1 < args.length) {
      i++;
      result.historyLimit = parseInt(args[i]!, 10) || 20;
    } else if (arg === '--outcome' && i + 1 < args.length) {
      i++;
      result.historyOutcome = args[i];
    } else if (arg === '--workflow' && i + 1 < args.length) {
      i++;
      if (result.command === 'eject') {
        result.ejectWorkflow = args[i];
      } else {
        result.historyWorkflow = args[i];
      }
    } else if (arg === '--since' && i + 1 < args.length) {
      i++;
      if (result.command === 'costs') {
        result.costsSince = args[i];
      } else {
        result.historySince = args[i];
      }
    } else if (arg === '--model' && i + 1 < args.length) {
      i++;
      result.costsModel = args[i];
    } else if (arg === '--json') {
      result.historyJson = true;
    } else if (arg === '--prune') {
      result.historyPrune = true;
    } else if (arg === '--clear') {
      result.historyClear = true;
    } else if (arg === 'history') {
      result.command = 'history';
    } else if (arg === 'costs') {
      result.command = 'costs';
    } else if (arg === 'providers') {
      result.command = 'providers';
    } else if (arg === 'eject') {
      result.command = 'eject';
    } else if (arg === 'watch') {
      result.command = 'watch';
    } else if (arg === 'cron') {
      result.command = 'cron';
      // Next arg is the schedule
      if (i + 1 < args.length && !args[i + 1]!.startsWith('-')) {
        i++;
        result.cronSchedule = args[i];
      }
    } else if (arg === 'pipeline') {
      result.command = 'pipeline';
    } else if (arg === '--cron' && i + 1 < args.length) {
      i++;
      result.cronSchedule = args[i];
    } else if (arg === '--debounce' && i + 1 < args.length) {
      i++;
      result.debounceMs = parseInt(args[i]!, 10) || 500;
    } else if (arg === '--log' && i + 1 < args.length) {
      i++;
      result.logFile = args[i];
    } else if (arg === '--stage' && i + 1 < args.length) {
      i++;
      result.pipelineStage = args[i];
    } else if (arg === '--dashboard') {
      result.dashboard = true;
    } else if (arg === '--port' && i + 1 < args.length) {
      i++;
      result.dashboardPort = parseInt(args[i]!, 10) || 4242;
    } else if (arg === '--open') {
      result.dashboardOpen = true;
    } else if (arg === '--approval' && i + 1 < args.length) {
      i++;
      result.approvalMode = args[i];
    } else if (arg === 'dashboard') {
      result.command = 'dashboard';
      result.dashboard = true;
    } else if (arg === 'bot') {
      result.command = 'bot';
      // Next non-flag arg is the task string
      if (i + 1 < args.length && !args[i + 1]!.startsWith('-')) {
        i++;
        result.botTask = args[i];
      }
    } else if (arg === 'session') {
      result.command = 'session';
    } else if (arg === 'status') {
      result.command = 'status';
    } else if (arg === 'steer') {
      result.command = 'steer';
      // Next arg is the subcommand
      if (i + 1 < args.length && !args[i + 1]!.startsWith('-')) {
        i++;
        result.botTask = args[i];
        // Next arg after redirect/queue is payload
        if ((args[i] === 'redirect' || args[i] === 'queue') && i + 1 < args.length && !args[i + 1]!.startsWith('-')) {
          i++;
          result.botFile = args[i];
        }
      }
    } else if (arg === 'queue') {
      result.command = 'queue';
      // Next arg is action (add/list/clear/remove)
      if (i + 1 < args.length && !args[i + 1]!.startsWith('-')) {
        i++;
        result.botTask = args[i];
        // Next arg is task/id
        if (i + 1 < args.length && !args[i + 1]!.startsWith('-')) {
          i++;
          result.botFile = args[i];
        }
      }
    } else if (arg === '--file' && i + 1 < args.length) {
      i++;
      result.botFile = args[i];
    } else if (arg === '--template' && i + 1 < args.length) {
      i++;
      result.botTemplate = args[i];
    } else if (arg === '--batch' && i + 1 < args.length) {
      i++;
      result.botBatch = parseInt(args[i]!, 10) || undefined;
    } else if (arg === '--auto-approve') {
      result.autoApprove = true;
    } else if (arg === 'audit') {
      result.command = 'audit';
      // Next non-flag arg is the runId
      if (i + 1 < args.length && !args[i + 1]!.startsWith('-')) {
        i++;
        result.historyId = args[i];
      }
    } else if (arg === 'genesis') {
      result.command = 'genesis';
    } else if (arg === 'init') {
      result.command = 'init';
    } else if (arg === '--init') {
      result.genesisInit = true;
    } else if (arg === '--watch') {
      result.genesisWatch = true;
    } else if (arg === '--continuous') {
      result.sessionContinuous = true;
    } else if (arg === '--until' && i + 1 < args.length) {
      i++;
      result.sessionUntil = args[i];
    } else if (arg === '--max-tasks' && i + 1 < args.length) {
      i++;
      result.sessionMaxTasks = parseInt(args[i]!, 10) || undefined;
    } else if (arg === '--project-dir' && i + 1 < args.length) {
      i++;
      result.file = args[i];
    } else if (arg === 'run') {
      // skip, next arg is the file
    } else if (!arg.startsWith('-')) {
      if (result.command === 'history' && !result.file) {
        result.historyId = arg;
      } else {
        result.file = arg;
      }
    } else {
      console.error(`[weaver] Unknown option: ${arg}`);
      console.error('Run "flow-weaver weaver --help" for usage');
      process.exit(1);
    }
    i++;
  }

  return result;
}

// --- Formatting helpers ---

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const STATUS_ICONS: Record<string, string> = {
  'node-start': '\x1b[36m>\x1b[0m',
  'node-complete': '\x1b[32m+\x1b[0m',
  'node-error': '\x1b[31mx\x1b[0m',
};

const OUTCOME_COLORS: Record<string, string> = {
  completed: '\x1b[32m',
  failed: '\x1b[31m',
  error: '\x1b[31m',
  skipped: '\x1b[33m',
};
const RESET = '\x1b[0m';

const STAGE_ICONS: Record<string, string> = {
  running: '\x1b[36m>\x1b[0m',
  completed: '\x1b[32m+\x1b[0m',
  failed: '\x1b[31mx\x1b[0m',
  skipped: '\x1b[33m-\x1b[0m',
  cancelled: '\x1b[33m~\x1b[0m',
};

function printRunTable(records: RunRecord[]): void {
  console.log(
    'ID'.padEnd(10) +
    'OUTCOME'.padEnd(12) +
    'DURATION'.padEnd(10) +
    'WORKFLOW'.padEnd(24) +
    'STARTED',
  );

  for (const r of records) {
    const id = r.id.slice(0, 8);
    const color = OUTCOME_COLORS[r.outcome] ?? '';
    const outcome = `${color}${r.outcome}${RESET}`;
    const duration = formatDuration(r.durationMs);
    const workflow = path.basename(r.workflowFile);
    const started = r.startedAt.replace('T', ' ').slice(0, 16);

    console.log(
      id.padEnd(10) +
      outcome.padEnd(12 + color.length + RESET.length) +
      duration.padEnd(10) +
      (workflow.length > 22 ? workflow.slice(0, 21) + '~' : workflow).padEnd(24) +
      started,
    );
  }
}

function printRunDetail(r: RunRecord): void {
  const outcomeColor = r.success ? '\x1b[32m' : '\x1b[31m';

  console.log(`\nRun ${r.id}\n`);
  console.log(`  Workflow:       ${r.workflowFile}`);
  if (r.functionName) console.log(`  Function:       ${r.functionName}`);
  console.log(`  Outcome:        ${outcomeColor}${r.outcome}${RESET} (${r.success ? 'success' : 'failure'})`);
  console.log(`  Started:        ${r.startedAt}`);
  console.log(`  Finished:       ${r.finishedAt}`);
  console.log(`  Duration:       ${formatDuration(r.durationMs)}`);
  if (r.executionTime !== undefined) {
    console.log(`  Execution time: ${formatDuration(r.executionTime)}`);
  }
  if (r.provider) console.log(`  Provider:       ${r.provider}`);
  console.log(`  Dry run:        ${r.dryRun ? 'yes' : 'no'}`);
  console.log(`  Summary:        ${r.summary}`);
  if (r.params) {
    console.log(`  Params:         ${JSON.stringify(r.params)}`);
  }
  if (r.stepLog && r.stepLog.length > 0) {
    console.log(`\n  Steps (${r.stepLog.length}):`);
    for (const entry of r.stepLog) {
      const icon = entry.status === 'ok' ? '\x1b[32m+\x1b[0m' : entry.status === 'blocked' ? '\x1b[33m⚠\x1b[0m' : '\x1b[31m✗\x1b[0m';
      const detail = entry.detail ? ` — ${entry.detail}` : '';
      console.log(`    ${icon} ${entry.step}${detail}`);
    }
  }
  console.log('');
}

function parseSince(spec?: string): number | undefined {
  if (!spec) return undefined;
  const match = spec.match(/^(\d+)([dhm])$/);
  if (match) {
    const n = parseInt(match[1]!, 10);
    const unit = match[2];
    const ms = unit === 'd' ? n * 86_400_000 : unit === 'h' ? n * 3_600_000 : n * 60_000;
    return Date.now() - ms;
  }
  const ts = new Date(spec).getTime();
  return isNaN(ts) ? undefined : ts;
}

function formatCostTable(summary: CostSummary): string {
  const lines: string[] = [];
  lines.push(`Weaver Cost Summary (${summary.totalRuns} runs)`);
  lines.push(`Total: ~$${summary.totalCost.toFixed(4)}`);
  lines.push(`Tokens: ${summary.totalInputTokens.toLocaleString()} in / ${summary.totalOutputTokens.toLocaleString()} out`);

  const models = Object.entries(summary.byModel);
  if (models.length > 0) {
    lines.push('');
    lines.push('By model:');
    for (const [model, data] of models) {
      lines.push(`  ${model}: ${data.runs} runs, ~$${data.cost.toFixed(4)}, ${data.inputTokens.toLocaleString()} in / ${data.outputTokens.toLocaleString()} out`);
    }
  }

  return lines.join('\n');
}

function formatRunCost(cost: RunCostSummary): string {
  const inp = cost.totalInputTokens.toLocaleString();
  const out = cost.totalOutputTokens.toLocaleString();
  const usd = cost.totalCost < 0.01
    ? `$${cost.totalCost.toFixed(4)}`
    : `$${cost.totalCost.toFixed(2)}`;
  return `tokens: ${inp} in / ${out} out | cost: ~${usd} (${cost.model})`;
}

async function loadConfig(configPath?: string): Promise<WeaverConfig | undefined> {
  if (!configPath) return undefined;
  try {
    const { readFileSync } = await import('node:fs');
    return JSON.parse(readFileSync(path.resolve(configPath), 'utf-8'));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[weaver] Failed to read config: ${msg}`);
    process.exit(1);
  }
}

// --- Handlers ---

export async function handleHistory(opts: ParsedArgs): Promise<void> {
  const store = new RunStore();

  if (opts.historyClear) {
    const deleted = store.clear();
    console.log(deleted ? 'History cleared.' : 'No history to clear.');
    return;
  }

  if (opts.historyPrune) {
    const pruned = store.prune({ maxRecords: 500, maxAgeDays: 90 });
    console.log(`Pruned ${pruned} record(s).`);
    return;
  }

  if (opts.historyId) {
    const record = store.get(opts.historyId);
    if (!record) {
      console.error(`[weaver] No run found matching "${opts.historyId}"`);
      process.exit(1);
    }
    if (opts.historyJson) {
      console.log(JSON.stringify(record, null, 2));
    } else {
      printRunDetail(record);
    }
    return;
  }

  const records = store.list({
    outcome: opts.historyOutcome as RunOutcome | undefined,
    workflowFile: opts.historyWorkflow ? path.resolve(opts.historyWorkflow) : undefined,
    since: opts.historySince,
    limit: opts.historyLimit,
  });

  if (records.length === 0) {
    console.log('No runs recorded yet.');
    return;
  }

  if (opts.historyJson) {
    console.log(JSON.stringify(records, null, 2));
  } else {
    printRunTable(records);
  }
}

export async function handleCosts(opts: ParsedArgs): Promise<void> {
  const store = new CostStore();
  const sinceTs = parseSince(opts.costsSince);
  const summary = store.summarize({ since: sinceTs, model: opts.costsModel });

  if (summary.totalRuns === 0) {
    if (opts.historyJson) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log('No cost data found.');
    }
    return;
  }

  if (opts.historyJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(formatCostTable(summary));
  }
}

export async function handleWatch(opts: ParsedArgs): Promise<void> {
  if (!opts.file) {
    console.error('[weaver] No workflow file specified for watch');
    process.exit(1);
  }

  const config = await loadConfig(opts.configPath);

  const daemon = new WatchDaemon({
    filePath: path.resolve(opts.file),
    watchFile: true,
    cron: opts.cronSchedule,
    debounceMs: opts.debounceMs,
    logFile: opts.logFile,
    verbose: opts.verbose,
    params: opts.params,
    config,
    quiet: opts.quiet,
  });

  await daemon.start();
}

export async function handleCron(opts: ParsedArgs): Promise<void> {
  if (!opts.cronSchedule) {
    console.error('[weaver] No cron schedule specified');
    console.error('Usage: flow-weaver weaver cron "*/5 * * * *" <file>');
    process.exit(1);
  }
  if (!opts.file) {
    console.error('[weaver] No workflow file specified for cron');
    process.exit(1);
  }

  const config = await loadConfig(opts.configPath);

  const daemon = new WatchDaemon({
    filePath: path.resolve(opts.file),
    watchFile: false,
    cron: opts.cronSchedule,
    debounceMs: opts.debounceMs,
    logFile: opts.logFile,
    verbose: opts.verbose,
    params: opts.params,
    config,
    quiet: opts.quiet,
  });

  await daemon.start();
}

export async function handlePipeline(opts: ParsedArgs): Promise<void> {
  if (!opts.file) {
    console.error('[weaver] No pipeline config specified');
    console.error('Usage: flow-weaver weaver pipeline <config.json>');
    process.exit(1);
  }

  let config;
  try {
    config = PipelineRunner.load(opts.file);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m[weaver] Pipeline config error: ${msg}\x1b[0m`);
    process.exit(1);
  }
  const runner = new PipelineRunner();

  if (!opts.quiet) {
    console.log(`Pipeline: ${config.name}`);
    console.log(`  ${config.stages.length} stages\n`);
  }

  const stageTimings = new Map<string, number>();

  const onStageEvent = opts.quiet
    ? undefined
    : (stageId: string, status: StageStatus, result?: WorkflowResult) => {
        const icon = STAGE_ICONS[status] ?? ' ';
        const stage = config.stages.find((s) => s.id === stageId);
        const label = stage?.label ?? stageId;

        if (status === 'running') {
          stageTimings.set(stageId, Date.now());
          if (opts.verbose) {
            console.log(`  ${icon} ${label}`);
          }
        } else {
          const start = stageTimings.get(stageId);
          const dur = start ? ` (${formatDuration(Date.now() - start)})` : '';
          console.log(`  ${icon} ${label}${dur}`);
        }
      };

  const weaverConfig = await loadConfig(opts.configPath);

  try {
    const pipelineResult = await runner.run(config, {
      verbose: opts.verbose,
      dryRun: opts.dryRun,
      config: weaverConfig,
      stage: opts.pipelineStage,
      onStageEvent,
      onNotificationError: (channel, _event, error) => {
        console.error(`[weaver] Notification error (${channel}): ${error}`);
      },
    });

    if (!opts.quiet) {
      const elapsed = formatDuration(pipelineResult.durationMs);
      const color = pipelineResult.success ? '\x1b[32m' : '\x1b[31m';
      console.log(`\n${color}Pipeline: ${pipelineResult.outcome}\x1b[0m (${elapsed})`);
    }

    process.exit(pipelineResult.success ? 0 : 1);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m[weaver] Pipeline error: ${msg}\x1b[0m`);
    process.exit(1);
  }
}

export async function handleDashboard(opts: ParsedArgs): Promise<void> {
  const dashboard = new DashboardServer({ port: opts.dashboardPort });
  const port = await dashboard.start();
  const url = dashboard.getUrl();
  console.log(`[weaver] Dashboard: ${url}`);

  if (opts.dashboardOpen) openBrowser(url);

  if (!opts.file) {
    // Dashboard-only mode: view history, wait for SIGINT
    console.log('[weaver] Dashboard running (Ctrl+C to stop)');
    await new Promise<void>((resolve) => {
      process.on('SIGINT', () => { dashboard.stop().then(resolve); });
      process.on('SIGTERM', () => { dashboard.stop().then(resolve); });
    });
    return;
  }

  // Run workflow with live dashboard
  const config = await loadConfig(opts.configPath);
  if (opts.approvalMode) {
    const cfg = config ?? { provider: 'auto' as const };
    cfg.approval = { mode: opts.approvalMode as 'web', webOpen: opts.dashboardOpen };
  }

  dashboard.broadcastWorkflowStart(path.resolve(opts.file));

  const nodeTimings = new Map<string, number>();
  const onEvent = (event: ExecutionEvent) => {
    dashboard.broadcastExecution(event);

    if (opts.quiet) return;
    const icon = STATUS_ICONS[event.type] ?? ' ';
    const label = event.nodeType ? `${event.nodeId} (${event.nodeType})` : event.nodeId;

    if (event.type === 'node-start') {
      nodeTimings.set(event.nodeId, event.timestamp);
      if (opts.verbose) console.log(`  ${icon} ${label}`);
    } else if (event.type === 'node-complete') {
      const start = nodeTimings.get(event.nodeId);
      const dur = start ? ` ${formatDuration(event.timestamp - start)}` : '';
      console.log(`  ${icon} ${label}${dur}`);
    } else if (event.type === 'node-error') {
      console.log(`  ${icon} ${label}: ${event.error ?? 'unknown error'}`);
    }
  };

  const startTime = Date.now();

  try {
    const result = await runWorkflow(path.resolve(opts.file), {
      params: opts.params,
      verbose: opts.verbose,
      dryRun: opts.dryRun,
      config,
      onEvent,
      dashboardServer: dashboard,
      onNotificationError: (channel, _event, error) => {
        console.error(`[weaver] Notification error (${channel}): ${error}`);
      },
    });

    dashboard.broadcastWorkflowComplete(result.summary, result.success);

    const elapsed = formatDuration(Date.now() - startTime);
    if (!opts.quiet) {
      console.log('');
      const color = result.success ? '\x1b[32m' : '\x1b[31m';
      console.log(`${color}Weaver: ${result.outcome}\x1b[0m (${elapsed})`);
      console.log(`  ${result.summary}`);
      if (result.cost && result.cost.totalInputTokens > 0) {
        console.log(`  ${formatRunCost(result.cost)}`);
      }
    }

    // Keep alive for 5 minutes after completion
    console.log(`[weaver] Dashboard at ${url} (5min keep-alive, Ctrl+C to stop)`);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 300_000);
      const handler = () => { clearTimeout(timer); resolve(); };
      process.on('SIGINT', handler);
      process.on('SIGTERM', handler);
    });

    await dashboard.stop();
    process.exit(result.success ? 0 : 1);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    dashboard.broadcastWorkflowError(msg);
    console.error(`\x1b[31m[weaver] Fatal: ${msg}\x1b[0m`);
    await dashboard.stop();
    process.exit(1);
  }
}

export async function handleProviders(): Promise<void> {
  await discoverProviders(defaultRegistry);
  const providers = defaultRegistry.list();

  if (providers.length === 0) {
    console.log('No providers found.');
    return;
  }

  console.log('Available providers:\n');
  for (const { name, metadata } of providers) {
    const tag = `[${metadata.source}]`;
    console.log(`  ${name}  ${tag}`);
    if (metadata.description) {
      console.log(`    ${metadata.description}`);
    }
    if (metadata.requiredEnvVars && metadata.requiredEnvVars.length > 0) {
      const present = metadata.requiredEnvVars.every((v) => process.env[v]);
      const status = present ? '\x1b[32mset\x1b[0m' : '\x1b[33mnot set\x1b[0m';
      console.log(`    env: ${metadata.requiredEnvVars.join(', ')} (${status})`);
    }
    if (metadata.detectCliCommand) {
      console.log(`    cli: ${metadata.detectCliCommand}`);
    }
    console.log('');
  }
}

// --- Workflow map for eject and resolution ---

const MANAGED_WORKFLOWS: Record<string, string> = {
  bot: 'weaver-bot',
  batch: 'weaver-bot-batch',
  genesis: 'genesis-task',
};

/** Deduplicate import lines: collapse multiple imports from the same module. */
function deduplicateImports(source: string): string {
  const lines = source.split('\n');
  const importMap = new Map<string, Set<string>>();
  const nonImportLines: string[] = [];
  let pastImports = false;

  for (const line of lines) {
    const importMatch = line.match(/^import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/);
    if (importMatch && !pastImports) {
      const isType = line.trimStart().startsWith('import type');
      const names = importMatch[1]!.split(',').map((s) => s.trim()).filter(Boolean);
      const mod = importMatch[2]!;
      const key = isType ? `type:${mod}` : mod;
      if (!importMap.has(key)) importMap.set(key, new Set());
      for (const n of names) importMap.get(key)!.add(n);
    } else {
      if (line.trim() !== '' && !line.match(/^import\s/)) pastImports = true;
      nonImportLines.push(line);
    }
  }

  const dedupedImports: string[] = [];
  for (const [key, names] of importMap) {
    const isType = key.startsWith('type:');
    const mod = isType ? key.slice(5) : key;
    const keyword = isType ? 'import type' : 'import';
    dedupedImports.push(`${keyword} { ${[...names].join(', ')} } from '${mod}';`);
  }

  return [...dedupedImports, ...nonImportLines].join('\n');
}

/** Rewrite node-type source: ../bot/*.js → package barrel, deduplicate. */
function rewriteNodeTypeImports(source: string): string {
  const rewritten = source
    .replace(/from\s+['"]\.\.\/bot\/[^'"]+['"]/g, "from '@synergenius/flow-weaver-pack-weaver/bot'");
  return deduplicateImports(rewritten);
}

/** Rewrite workflow source: ../node-types/ → ./node-types/ (local ejected), ../bot/ → package barrel. */
function rewriteWorkflowImports(source: string): string {
  const rewritten = source
    .replace(/from\s+['"]\.\.\/node-types\//g, "from './node-types/")
    .replace(/from\s+['"]\.\.\/bot\/[^'"]+['"]/g, "from '@synergenius/flow-weaver-pack-weaver/bot'");
  return deduplicateImports(rewritten);
}

/** Read a managed workflow source from the pack. */
function readPackWorkflowSource(packRoot: URL, workflowBaseName: string): string {
  const candidates = [
    new URL(`src/workflows/${workflowBaseName}.ts`, packRoot),
    new URL(`dist/workflows/${workflowBaseName}.ts`, packRoot),
    new URL(`dist/workflows/${workflowBaseName}.js`, packRoot),
  ];

  for (const candidate of candidates) {
    try {
      return fs.readFileSync(candidate, 'utf-8');
    } catch { /* try next */ }
  }

  throw new Error(`Could not find managed workflow: ${workflowBaseName}`);
}

export interface EjectResult {
  workflow: string;
  file: string;
  nodeTypes: string[];
  botFiles?: string[];
}

/**
 * Read a pack source file, trying src/ then dist/.
 */
function readPackFile(packRoot: URL, relativePath: string): string {
  const srcCandidate = new URL(`src/${relativePath}`, packRoot);
  const distCandidate = new URL(`dist/${relativePath}`, packRoot);
  try {
    return fs.readFileSync(srcCandidate, 'utf-8');
  } catch {
    return fs.readFileSync(distCandidate, 'utf-8');
  }
}

/**
 * Collect bot utility files transitively imported by node-type files.
 * Traces `from '../bot/<file>.js'` and `from './<file>.js'` within bot/.
 */
function collectBotDeps(packRoot: URL, ntFiles: string[]): string[] {
  const visited = new Set<string>();
  const queue: string[] = [];

  // Seed from node-type files: look for ../bot/ imports
  for (const ntFile of ntFiles) {
    let ntSource: string;
    try { ntSource = readPackFile(packRoot, `node-types/${ntFile}`); } catch { continue; }
    const botImportRegex = /from\s+['"]\.\.\/bot\/([^'"]+)['"]/g;
    let m;
    while ((m = botImportRegex.exec(ntSource)) !== null) {
      const botFile = m[1]!.replace(/\.js$/, '.ts');
      if (!visited.has(botFile)) {
        visited.add(botFile);
        queue.push(botFile);
      }
    }
  }

  // Always include types.ts
  if (!visited.has('types.ts')) {
    visited.add('types.ts');
    queue.push('types.ts');
  }

  // Trace transitive deps within bot/
  while (queue.length > 0) {
    const botFile = queue.shift()!;
    let botSource: string;
    try { botSource = readPackFile(packRoot, `bot/${botFile}`); } catch { continue; }
    const localImportRegex = /from\s+['"]\.\/([^'"]+)['"]/g;
    let m;
    while ((m = localImportRegex.exec(botSource)) !== null) {
      const dep = m[1]!.replace(/\.js$/, '.ts');
      if (!visited.has(dep)) {
        visited.add(dep);
        queue.push(dep);
      }
    }
  }

  return [...visited];
}

/**
 * Eject workflow + node-type files into a destination directory.
 *
 * When `standalone` is true, bot utility files are also ejected so the
 * workflows run without the pack installed. Import paths in workflows
 * are rewritten from `../node-types/` to `./node-types/`, and `../bot/`
 * imports in node-type files remain as-is (pointing to the local `bot/`
 * directory).
 *
 * When `standalone` is false (default), bot imports are rewritten to
 * the package barrel (`@synergenius/flow-weaver-pack-weaver/bot`).
 */
export function ejectWorkflows(opts: {
  destDir: string;
  workflows?: string[];
  force?: boolean;
  standalone?: boolean;
}): EjectResult[] {
  const packRoot = new URL('..', import.meta.url);
  const workflowKeys = opts.workflows ?? Object.keys(MANAGED_WORKFLOWS);
  const standalone = opts.standalone === true;
  const results: EjectResult[] = [];
  const allNtFiles: string[] = [];

  for (const key of workflowKeys) {
    const baseName = MANAGED_WORKFLOWS[key];
    if (!baseName) continue;

    const source = readPackWorkflowSource(packRoot, baseName);

    // In standalone mode, only rewrite ../node-types/ to ./node-types/
    // and keep ../bot/ as-is (local bot/ dir). Otherwise use package barrel.
    let rewritten: string;
    if (standalone) {
      rewritten = source.replace(/from\s+['"]\.\.\/node-types\//g, "from './node-types/");
    } else {
      rewritten = rewriteWorkflowImports(source);
    }

    const wfFile = `${baseName}.ts`;
    const wfPath = path.join(opts.destDir, wfFile);

    // Collect node-type files referenced by the workflow
    const ntImportRegex = /from\s+['"]\.\.\/node-types\/([^'"]+)['"]/g;
    const ntFiles: string[] = [];
    let ntMatch;
    while ((ntMatch = ntImportRegex.exec(source)) !== null) {
      const ntFile = ntMatch[1]!.replace(/\.js$/, '.ts');
      if (!ntFiles.includes(ntFile)) ntFiles.push(ntFile);
      if (!allNtFiles.includes(ntFile)) allNtFiles.push(ntFile);
    }

    // Write workflow (skip if exists and not forced)
    let exists = false;
    try { fs.statSync(wfPath); exists = true; } catch {}
    if (!exists || opts.force) {
      fs.mkdirSync(path.join(opts.destDir, 'node-types'), { recursive: true });
      fs.writeFileSync(wfPath, rewritten, 'utf-8');

      // Eject each referenced node-type file
      for (const ntFile of ntFiles) {
        const ntSrcCandidates = [
          new URL(`src/node-types/${ntFile}`, packRoot),
          new URL(`dist/node-types/${ntFile}`, packRoot),
        ];
        for (const candidate of ntSrcCandidates) {
          try {
            const ntSource = fs.readFileSync(candidate, 'utf-8');
            // In standalone mode, keep ../bot/ as-is (local). Otherwise rewrite to barrel.
            const ntRewritten = standalone ? ntSource : rewriteNodeTypeImports(ntSource);
            fs.writeFileSync(path.join(opts.destDir, 'node-types', ntFile), ntRewritten, 'utf-8');
            break;
          } catch { /* try next */ }
        }
      }
    }

    results.push({ workflow: key, file: wfFile, nodeTypes: ntFiles });
  }

  // In standalone mode, eject bot utility files
  if (standalone) {
    const botFiles = collectBotDeps(packRoot, allNtFiles);
    fs.mkdirSync(path.join(opts.destDir, 'bot'), { recursive: true });
    for (const botFile of botFiles) {
      const destPath = path.join(opts.destDir, 'bot', botFile);
      let exists = false;
      try { fs.statSync(destPath); exists = true; } catch {}
      if (!exists || opts.force) {
        try {
          const botSource = readPackFile(packRoot, `bot/${botFile}`);
          fs.writeFileSync(destPath, botSource, 'utf-8');
        } catch {
          // File not found in pack, skip
        }
      }
    }
    // Attach bot files to results
    for (const r of results) {
      r.botFiles = botFiles;
    }
  }

  return results;
}

/**
 * Resolve a managed workflow path. Checks for a local ejected override first,
 * then falls back to the pack's own source or dist.
 */
function resolveWorkflowPath(workflowKey: string, cwd: string): string {
  const baseName = MANAGED_WORKFLOWS[workflowKey];
  if (!baseName) throw new Error(`Unknown workflow: ${workflowKey}`);

  // Check for ejected override
  const metaPath = path.join(cwd, '.weaver-meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      if (meta.ejected && meta.workflowFiles?.[workflowKey]) {
        const localPath = path.resolve(cwd, meta.workflowFiles[workflowKey]);
        if (fs.existsSync(localPath)) {
          return localPath;
        }
      }
    } catch { /* fall through to pack */ }
  }

  // Fall back to pack's managed workflow
  const packRoot = new URL('..', import.meta.url);
  try {
    const srcPath = fileURLToPath(new URL(`src/workflows/${baseName}.ts`, packRoot));
    if (fs.existsSync(srcPath)) return srcPath;
  } catch { /* ignore */ }

  return fileURLToPath(new URL(`dist/workflows/${baseName}.js`, packRoot));
}

export async function handleEject(opts: ParsedArgs): Promise<void> {
  if (opts.ejectWorkflow && !MANAGED_WORKFLOWS[opts.ejectWorkflow]) {
    console.error(`[weaver] Unknown workflow: ${opts.ejectWorkflow}`);
    console.error(`[weaver] Available: ${Object.keys(MANAGED_WORKFLOWS).join(', ')}`);
    process.exit(1);
    return;
  }

  const destDir = process.cwd();
  const workflows = opts.ejectWorkflow ? [opts.ejectWorkflow] : undefined;

  let results: EjectResult[];
  try {
    results = ejectWorkflows({ destDir, workflows, force: true, standalone: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[weaver] ${msg}`);
    process.exit(1);
    return;
  }

  for (const r of results) {
    console.log(`[weaver] Ejected ${r.workflow} → ${path.resolve(destDir, r.file)} (${r.nodeTypes.length} node types)`);
  }

  // Read pack version
  const packRoot = new URL('..', import.meta.url);
  let packVersion = 'unknown';
  try {
    const pkgPath = new URL('package.json', packRoot);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    packVersion = pkg.version;
  } catch { /* ignore */ }

  // Write/update .weaver-meta.json (merge with existing if present)
  const metaPath = path.resolve(destDir, '.weaver-meta.json');
  let existingMeta: Record<string, unknown> = {};
  try {
    existingMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  } catch { /* start fresh */ }

  const existingWorkflows = (existingMeta.workflowFiles as Record<string, string>) ?? {};
  const ejectedFiles: Record<string, string> = {};
  for (const r of results) ejectedFiles[r.workflow] = r.file;

  const meta = {
    ejected: true,
    packVersion,
    workflowFiles: { ...existingWorkflows, ...ejectedFiles },
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8');

  console.log(`[weaver] Metadata written to ${metaPath}`);
  console.log('[weaver] You can now customize the ejected workflow(s) freely.');
  console.log('[weaver] The bot will use local files when available.');
}

export async function handleRun(opts: ParsedArgs): Promise<void> {
  if (!opts.file) {
    console.error('[weaver] No workflow file specified');
    console.error('Run "flow-weaver weaver --help" for usage');
    process.exit(1);
  }

  const filePath = path.resolve(opts.file);
  const config = await loadConfig(opts.configPath);

  // Apply --approval override
  if (opts.approvalMode && config) {
    config.approval = { mode: opts.approvalMode as 'web' };
  }

  const nodeTimings = new Map<string, number>();

  const onEvent = opts.quiet
    ? undefined
    : (event: ExecutionEvent) => {
        const icon = STATUS_ICONS[event.type] ?? ' ';
        const label = event.nodeType
          ? `${event.nodeId} (${event.nodeType})`
          : event.nodeId;

        if (event.type === 'node-start') {
          nodeTimings.set(event.nodeId, event.timestamp);
          if (opts.verbose) {
            console.log(`  ${icon} ${label}`);
          }
        } else if (event.type === 'node-complete') {
          const start = nodeTimings.get(event.nodeId);
          const dur = start ? ` ${formatDuration(event.timestamp - start)}` : '';
          console.log(`  ${icon} ${label}${dur}`);
        } else if (event.type === 'node-error') {
          console.log(`  ${icon} ${label}: ${event.error ?? 'unknown error'}`);
        }
      };

  const startTime = Date.now();

  try {
    const result = await runWorkflow(filePath, {
      params: opts.params,
      verbose: opts.verbose,
      dryRun: opts.dryRun,
      config,
      onEvent,
      onNotificationError: (channel, _event, error) => {
        console.error(`[weaver] Notification error (${channel}): ${error}`);
      },
    });

    const elapsed = formatDuration(Date.now() - startTime);

    if (!opts.quiet) {
      console.log('');
      if (result.success) {
        console.log(`\x1b[32mBot: ${result.outcome}\x1b[0m (${elapsed})`);
      } else {
        console.log(`\x1b[31mBot: ${result.outcome}\x1b[0m (${elapsed})`);
      }
      console.log(`  ${result.summary}`);

      if (result.cost && result.cost.totalInputTokens > 0) {
        console.log(`  ${formatRunCost(result.cost)}`);
      }
    }

    process.exit(result.success ? 0 : 1);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m[weaver] Fatal: ${msg}\x1b[0m`);
    process.exit(1);
  }
}

export async function handleBot(opts: ParsedArgs): Promise<void> {
  if (!opts.botTask) {
    console.error('[weaver] No task specified');
    console.error('Usage: flow-weaver weaver bot "Create a workflow that..."');
    process.exit(1);
  }

  const task = {
    instruction: opts.botTask,
    mode: opts.botFile ? 'modify' : 'create',
    targets: opts.botFile ? [opts.botFile] : undefined,
    options: {
      template: opts.botTemplate,
      batchCount: opts.botBatch,
      dryRun: opts.dryRun,
      autoApprove: opts.autoApprove,
    },
  };

  // Use the batch workflow if --batch specified
  const workflowKey = opts.botBatch ? 'batch' : 'bot';
  const workflowPath = resolveWorkflowPath(workflowKey, opts.file ?? process.cwd());

  const config = await loadConfig(opts.configPath);
  const nodeTimings = new Map<string, number>();

  // Start dashboard if requested
  let dashboard: DashboardServer | null = null;
  if (opts.dashboard) {
    dashboard = new DashboardServer({ port: opts.dashboardPort ?? 4242 });
    const port = await dashboard.start();
    console.log(`[weaver] Dashboard: http://127.0.0.1:${port}`);
    openBrowser(`http://127.0.0.1:${port}`);
    dashboard.broadcastWorkflowStart(workflowPath);
  }

  const onEvent = opts.quiet
    ? undefined
    : (event: ExecutionEvent) => {
        const icon = STATUS_ICONS[event.type] ?? ' ';
        const label = event.nodeType ? `${event.nodeId} (${event.nodeType})` : event.nodeId;

        if (dashboard) dashboard.broadcastExecution(event);

        if (event.type === 'node-start') {
          nodeTimings.set(event.nodeId, event.timestamp);
          if (opts.verbose) console.log(`  ${icon} ${label}`);
        } else if (event.type === 'node-complete') {
          const start = nodeTimings.get(event.nodeId);
          const dur = start ? ` ${formatDuration(event.timestamp - start)}` : '';
          console.log(`  ${icon} ${label}${dur}`);
        } else if (event.type === 'node-error') {
          console.log(`  ${icon} ${label}: ${event.error ?? 'unknown error'}`);
        }
      };

  const startTime = Date.now();
  if (!opts.quiet) {
    console.log(`[weaver] Bot: ${opts.botTask.slice(0, 80)}`);
  }

  try {
    const result = await runWorkflow(workflowPath, {
      params: { taskJson: JSON.stringify(task), projectDir: opts.file ?? process.cwd() },
      verbose: opts.verbose,
      dryRun: opts.dryRun,
      config,
      onEvent,
      onNotificationError: (channel, _event, error) => {
        console.error(`[weaver] Notification error (${channel}): ${error}`);
      },
    });

    const elapsed = formatDuration(Date.now() - startTime);
    if (!opts.quiet) {
      const color = result.success ? '\x1b[32m' : '\x1b[31m';
      console.log(`\n${color}Bot: ${result.outcome}\x1b[0m (${elapsed})`);
      console.log(`  ${result.summary}`);
    }

    if (dashboard) {
      dashboard.broadcastWorkflowComplete(result.summary ?? '', result.success);
      await dashboard.stop();
    }

    process.exit(result.success ? 0 : 1);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m[weaver] Fatal: ${msg}\x1b[0m`);
    if (dashboard) {
      dashboard.broadcastWorkflowError(msg);
      await dashboard.stop();
    }
    process.exit(1);
  }
}

export async function handleSession(opts: ParsedArgs): Promise<void> {
  const workflowPath = resolveWorkflowPath('bot', opts.file ?? process.cwd());
  const config = await loadConfig(opts.configPath);
  const projectDir = opts.file ?? process.cwd();

  // Parse --until HH:MM into a deadline timestamp
  let deadline: number | undefined;
  if (opts.sessionUntil) {
    const match = opts.sessionUntil.match(/^(\d{1,2}):(\d{2})$/);
    if (match) {
      const now = new Date();
      const target = new Date(now);
      target.setHours(parseInt(match[1]!, 10), parseInt(match[2]!, 10), 0, 0);
      if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1); // next day
      deadline = target.getTime();
      if (!opts.quiet) console.log(`[weaver] Session deadline: ${target.toLocaleTimeString()}`);
    }
  }

  const maxTasks = opts.sessionMaxTasks ?? Infinity;
  const continuous = opts.sessionContinuous || !!opts.sessionUntil || maxTasks < Infinity;

  // Crash recovery: reset orphaned "running" tasks on session start
  if (continuous) {
    const { TaskQueue } = await import('./bot/task-queue.js');
    const recoveryQueue = new TaskQueue();
    const recovered = await recoveryQueue.recoverOrphans();
    if (recovered > 0 && !opts.quiet) {
      console.log(`[weaver] Recovered ${recovered} orphaned task(s) from previous crash.`);
    }
  }

  // Clean stale fw-exec-* cache files — these are temp compiled workflows
  // that persist across dev:install and can contain outdated generated code.
  try {
    const { execSync: execSyncClean } = await import('node:child_process');
    const staleOutput = execSyncClean(`find "${projectDir}" -name "fw-exec-*" -type f`, { encoding: 'utf-8', timeout: 5000 }).trim();
    if (staleOutput) {
      const staleFiles = staleOutput.split('\n').filter(Boolean);
      for (const f of staleFiles) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
      if (!opts.quiet) console.log(`[weaver] Cleaned ${staleFiles.length} stale cache file(s).`);
    }
  } catch {
    // cleanup failed — non-fatal
  }

  if (!opts.quiet) {
    console.log('[weaver] Starting bot session (Ctrl+C to stop)');
    if (continuous) console.log('[weaver] Continuous mode — polling queue for tasks');
    console.log('[weaver] Add tasks with: flow-weaver weaver queue add "task"');
  }

  // Single-run mode (backwards compatible)
  if (!continuous) {
    try {
      const result = await runWorkflow(workflowPath, {
        params: { projectDir },
        verbose: opts.verbose,
        dryRun: opts.dryRun,
        config,
      });
      if (!opts.quiet) {
        const color = result.success ? '\x1b[32m' : '\x1b[31m';
        console.log(`${color}Session: ${result.outcome}\x1b[0m`);
      }
      process.exit(result.success ? 0 : 1);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\x1b[31m[weaver] Fatal: ${msg}\x1b[0m`);
      process.exit(1);
    }
    return;
  }

  // Continuous mode: loop until deadline/maxTasks/interrupt
  const { TaskQueue } = await import('./bot/task-queue.js');
  const queue = new TaskQueue();
  let taskCount = 0;
  let interrupted = false;

  process.on('SIGINT', () => { interrupted = true; });
  process.on('SIGTERM', () => { interrupted = true; });

  while (taskCount < maxTasks && !interrupted) {
    if (deadline && Date.now() >= deadline) {
      if (!opts.quiet) console.log('[weaver] Deadline reached, stopping session.');
      break;
    }

    const task = await queue.next();
    if (!task) {
      // No pending tasks — wait and retry
      await new Promise(r => setTimeout(r, 5_000));
      continue;
    }

    taskCount++;
    if (!opts.quiet) console.log(`\x1b[36m[weaver] Task ${taskCount}/${maxTasks === Infinity ? '∞' : maxTasks}: ${(task.instruction ?? task.id).slice(0, 60)}\x1b[0m`);

    await queue.markRunning(task.id);
    try {
      const result = await runWorkflow(workflowPath, {
        params: { projectDir, taskJson: JSON.stringify(task) },
        verbose: opts.verbose,
        dryRun: opts.dryRun,
        config,
      });

      if (result.success) {
        await queue.markComplete(task.id);
      } else {
        await queue.markFailed(task.id);
      }

      if (!opts.quiet) {
        const color = result.success ? '\x1b[32m' : '\x1b[31m';
        console.log(`${color}[weaver] Task ${task.id.slice(0, 8)}: ${result.outcome}\x1b[0m`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\x1b[31m[weaver] Task ${task.id.slice(0, 8)} error: ${msg}\x1b[0m`);
      await queue.markFailed(task.id);
    }
  }

  if (!opts.quiet) {
    console.log(`[weaver] Session complete: ${taskCount} task${taskCount === 1 ? '' : 's'} processed.`);
  }
}

export async function handleSteer(opts: ParsedArgs): Promise<void> {
  const { SteeringController } = await import('./bot/steering.js');
  const controller = new SteeringController();

  const subcommand = opts.botTask;
  if (!subcommand || !['pause', 'resume', 'cancel', 'redirect', 'queue'].includes(subcommand)) {
    console.error('[weaver] Usage: flow-weaver weaver steer <pause|resume|cancel|redirect|queue> [payload]');
    process.exit(1);
  }

  const command = {
    command: subcommand as 'pause' | 'resume' | 'cancel' | 'redirect' | 'queue',
    payload: opts.botFile,
    timestamp: Date.now(),
  };

  await controller.write(command);
  console.log(`[weaver] Steering command sent: ${subcommand}${opts.botFile ? ' "' + opts.botFile + '"' : ''}`);
}

export async function handleQueue(opts: ParsedArgs): Promise<void> {
  const { TaskQueue } = await import('./bot/task-queue.js');
  const queue = new TaskQueue();

  const action = opts.botTask;
  if (!action || !['add', 'list', 'clear', 'remove', 'retry'].includes(action)) {
    console.error('[weaver] Usage: flow-weaver weaver queue <add|list|clear|remove|retry> [task|id]');
    process.exit(1);
  }

  switch (action) {
    case 'add': {
      const instruction = opts.botFile;
      if (!instruction) {
        console.error('[weaver] Usage: flow-weaver weaver queue add "task instruction"');
        process.exit(1);
      }
      const id = await queue.add({ instruction, priority: 0 });
      console.log(`[weaver] Task added: ${id}`);
      break;
    }
    case 'list': {
      const tasks = await queue.list();
      if (opts.historyJson) {
        console.log(JSON.stringify(tasks, null, 2));
      } else if (tasks.length === 0) {
        console.log('No tasks in queue.');
      } else {
        console.log('ID'.padEnd(10) + 'STATUS'.padEnd(12) + 'PRIORITY'.padEnd(10) + 'INSTRUCTION');
        for (const t of tasks) {
          console.log(t.id.padEnd(10) + t.status.padEnd(12) + String(t.priority).padEnd(10) + t.instruction.slice(0, 60));
        }
      }
      break;
    }
    case 'clear': {
      const count = await queue.clear();
      console.log(`Cleared ${count} task(s).`);
      break;
    }
    case 'remove': {
      const id = opts.botFile;
      if (!id) {
        console.error('[weaver] Usage: flow-weaver weaver queue remove <id>');
        process.exit(1);
      }
      const removed = await queue.remove(id);
      console.log(removed ? `Removed task ${id}.` : `No task found with id "${id}".`);
      break;
    }
    case 'retry': {
      const id = opts.botFile;
      if (id) {
        // Retry a specific task
        const retried = await queue.retry(id);
        console.log(retried ? `Task ${id} reset to pending.` : `No failed/running task found with id "${id}".`);
      } else {
        // Retry all failed tasks
        const count = await queue.retryAll();
        console.log(`Reset ${count} failed task(s) to pending.`);
      }
      break;
    }
  }
}

export async function handleStatus(opts: ParsedArgs): Promise<void> {
  const store = new RunStore();
  const { TaskQueue } = await import('./bot/task-queue.js');
  const queue = new TaskQueue();

  const orphans = store.checkOrphans();
  const recentRuns = store.list({ limit: 5 });
  const tasks = await queue.list();
  const pending = tasks.filter(t => t.status === 'pending').length;
  const running = tasks.filter(t => t.status === 'running').length;
  const completed = tasks.filter(t => t.status === 'completed').length;
  const failed = tasks.filter(t => t.status === 'failed').length;

  if (opts.historyJson) {
    console.log(JSON.stringify({
      queue: { pending, running, completed, failed, total: tasks.length },
      orphanedRuns: orphans.length,
      recentRuns: recentRuns.map(r => ({
        id: r.id, outcome: r.outcome, summary: r.summary,
        startedAt: r.startedAt, durationMs: r.durationMs,
      })),
    }, null, 2));
    return;
  }

  console.log('\n\x1b[1mWeaver Status\x1b[0m\n');
  console.log(`  Queue:  ${pending} pending, ${running} running, ${completed} completed, ${failed} failed`);
  if (orphans.length > 0) {
    console.log(`  \x1b[33mOrphaned runs: ${orphans.length} (recovered)\x1b[0m`);
  }

  if (recentRuns.length > 0) {
    console.log(`\n  Recent runs:`);
    for (const r of recentRuns) {
      const icon = r.success ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
      console.log(`    ${icon} ${r.id.slice(0, 8)} ${r.outcome.padEnd(9)} ${formatDuration(r.durationMs).padEnd(8)} ${r.summary.slice(0, 60)}`);
    }
  } else {
    console.log('\n  No recent runs.');
  }
  console.log('');
}

export async function handleGenesis(opts: ParsedArgs): Promise<void> {
  const projectDir = opts.file ?? process.cwd();

  if (opts.genesisInit) {
    const { GenesisStore } = await import('./bot/genesis-store.js');
    const store = new GenesisStore(projectDir);
    store.ensureDirs();
    const config = store.loadConfig();
    console.log('[weaver] Created .genesis/config.json');
    console.log('[weaver] Set "targetWorkflow" to the workflow you want Genesis to evolve');
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  const workflowPath = resolveWorkflowPath('genesis', projectDir);

  const config = await loadConfig(opts.configPath);

  if (opts.genesisWatch) {
    const { GenesisStore } = await import('./bot/genesis-store.js');
    const store = new GenesisStore(projectDir);
    const gConfig = store.loadConfig();
    const maxCycles = gConfig.maxCyclesPerRun;

    if (!opts.quiet) console.log(`[weaver] Bot genesis watch: up to ${maxCycles} cycles`);

    for (let i = 0; i < maxCycles; i++) {
      if (!opts.quiet) console.log(`\n[weaver] Bot genesis cycle ${i + 1}/${maxCycles}`);
      const result = await runWorkflow(workflowPath, {
        params: { projectDir },
        verbose: opts.verbose,
        dryRun: opts.dryRun,
        config,
      });

      if (!result.success) {
        if (!opts.quiet) console.log(`\x1b[33m[weaver] Cycle ${i + 1} ended: ${result.summary}\x1b[0m`);
      }

      if (i < maxCycles - 1) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    return;
  }

  // Single cycle
  if (!opts.quiet) console.log('[weaver] Bot genesis: running cycle');

  const result = await runWorkflow(workflowPath, {
    params: { projectDir },
    verbose: opts.verbose,
    dryRun: opts.dryRun,
    config,
  });

  if (!opts.quiet) {
    const color = result.success ? '\x1b[32m' : '\x1b[33m';
    console.log(`${color}Bot genesis: ${result.summary}\x1b[0m`);
  }

  process.exit(result.success ? 0 : 1);
}

export async function handleAudit(opts: ParsedArgs): Promise<void> {
  const store = new AuditStore();

  if (opts.historyClear) {
    const deleted = store.clear();
    console.log(deleted ? 'Audit log cleared.' : 'No audit log to clear.');
    return;
  }

  if (opts.historyId) {
    const events = store.queryByRun(opts.historyId);
    if (events.length === 0) {
      // Try prefix match
      const recent = store.queryRecent(1000);
      const matched = recent.filter((e) => e.runId.startsWith(opts.historyId!));
      if (matched.length === 0) {
        console.error(`[weaver] No audit events found for "${opts.historyId}"`);
        process.exit(1);
      }
      printAuditEvents(matched, opts.historyJson);
      return;
    }
    printAuditEvents(events, opts.historyJson);
    return;
  }

  const events = store.queryRecent(opts.historyLimit);
  if (events.length === 0) {
    console.log('No audit events recorded yet.');
    return;
  }

  if (opts.historyJson) {
    console.log(JSON.stringify(events, null, 2));
    return;
  }

  // Group by runId
  const byRun = new Map<string, AuditEvent[]>();
  for (const e of events) {
    if (!byRun.has(e.runId)) byRun.set(e.runId, []);
    byRun.get(e.runId)!.push(e);
  }

  for (const [runId, runEvents] of byRun) {
    console.log(`\n\x1b[1mRun ${runId.slice(0, 8)}\x1b[0m`);
    for (const e of runEvents) {
      const time = e.timestamp.replace('T', ' ').slice(11, 19);
      const dataStr = e.data ? ' ' + JSON.stringify(e.data) : '';
      console.log(`  ${time} ${e.type}${dataStr}`);
    }
  }
  console.log('');
}

function printAuditEvents(events: AuditEvent[], json: boolean): void {
  if (json) {
    console.log(JSON.stringify(events, null, 2));
    return;
  }

  for (const e of events) {
    const time = e.timestamp.replace('T', ' ').slice(0, 19);
    const dataStr = e.data ? ' ' + JSON.stringify(e.data) : '';
    console.log(`${time} [${e.type}]${dataStr}`);
  }
}

// --- Help ---

const COMMAND_HELP: Record<string, string> = {
  run:       'run <workflow.ts>              Execute a workflow with AI agent channel',
  bot:       'bot "task description"         Create or modify a workflow from a task',
  init:      'init                           Create a .weaver.json config file',
  history:   'history [id] [--limit N]       Show execution history',
  costs:     'costs [--since 7d]             Show AI token usage and costs',
  providers: 'providers                      List available AI providers',
  watch:     'watch <workflow.ts>            Re-run on file changes',
  cron:      'cron "*/5 * * * *" <file>      Schedule workflow execution',
  pipeline:  'pipeline <config.json>         Run multi-stage pipeline',
  dashboard: 'dashboard <file> [--port N]    Start live execution dashboard',
  session:   'session                        Start continuous task queue processing',
  queue:     'queue <add|list|clear> [task]  Manage task queue',
  steer:     'steer <pause|resume|cancel>    Control a running session',
  genesis:   'genesis [--init] [--watch]     Run self-evolution cycle',
  eject:     'eject [--workflow bot|genesis]  Export managed workflows',
  audit:     'audit [runId] [--limit N]      View audit log',
};

export function printHelp(command?: string): void {
  if (command && command !== 'help' && COMMAND_HELP[command]) {
    console.log(`\nUsage: flow-weaver weaver ${COMMAND_HELP[command]}\n`);
    printCommandHelp(command);
    return;
  }

  console.log(`
Weaver — AI-powered workflow automation for Flow Weaver

Usage: flow-weaver weaver <command> [options]

Commands:
  ${Object.values(COMMAND_HELP).join('\n  ')}

Global options:
  -h, --help          Show help
  -v, --verbose       Show detailed output
  -n, --dry-run       Preview without executing
  --quiet             Suppress output
  -p, --params <json> Input parameters as JSON
  -c, --config <path> Path to .weaver.json config
  --approval <mode>   Override approval mode (auto|prompt|web|timeout-auto)

Quick start:
  flow-weaver weaver init                              # create .weaver.json
  flow-weaver weaver providers                         # check available AI providers
  flow-weaver weaver bot "Create a hello world workflow"  # create your first workflow
`);
}

function printCommandHelp(command: string): void {
  const help: Record<string, string> = {
    run: `Options:
  --dashboard         Enable live dashboard
  --port <n>          Dashboard port (default: 4242)`,
    bot: `Options:
  --file <path>       Target file for modification (switches to modify mode)
  --template <name>   Use a template for scaffolding
  --batch <n>         Process multiple tasks
  --auto-approve      Skip approval gate
  --dashboard         Enable live dashboard`,
    history: `Options:
  --limit <n>         Number of records (default: 20)
  --outcome <type>    Filter: completed, failed, error, skipped
  --workflow <path>   Filter by workflow file
  --since <range>     Time range: 7d, 2h, or ISO date
  --json              Output as JSON
  --prune             Remove old records
  --clear             Delete all history`,
    costs: `Options:
  --since <range>     Time range: 7d, 30d, or ISO date
  --model <name>      Filter by model`,
    genesis: `Options:
  --init              Initialize .genesis/config.json
  --watch             Run multiple evolution cycles
  --project-dir <p>   Project directory`,
    watch: `Options:
  --debounce <ms>     Debounce interval (default: 500)
  --log <path>        Log file for daemon output`,
    pipeline: `Options:
  --stage <id>        Run a specific stage only`,
    queue: `Actions:
  add "task"          Add task to queue
  list                Show queue contents
  clear               Remove all tasks
  remove <id>         Remove a specific task`,
    steer: `Commands:
  pause               Pause current execution
  resume              Resume paused execution
  cancel              Cancel current execution
  redirect "task"     Switch to a different task
  queue "task"        Add task to queue from steer`,
  };

  if (help[command]) {
    console.log(help[command]);
    console.log('');
  }
}

// --- Init ---

export async function handleInit(opts: ParsedArgs): Promise<void> {
  const dir = opts.file ? path.resolve(opts.file) : process.cwd();
  const configPath = path.join(dir, '.weaver.json');

  if (fs.existsSync(configPath)) {
    console.log(`[weaver] Config already exists: ${configPath}`);
    console.log('  Edit it directly or delete it to regenerate.');
    return;
  }

  // Detect best available provider
  let provider: string = 'auto';
  try {
    if (process.env.ANTHROPIC_API_KEY) {
      provider = 'anthropic';
    } else {
      const { execFileSync } = await import('node:child_process');
      try {
        execFileSync('claude', ['--version'], { stdio: 'pipe' });
        provider = 'claude-cli';
      } catch {
        try {
          execFileSync('copilot', ['--version'], { stdio: 'pipe' });
          provider = 'copilot-cli';
        } catch {
          // Stay with auto
        }
      }
    }
  } catch {
    // Stay with auto
  }

  const config = {
    provider: provider === 'auto' ? 'auto' : { name: provider },
    approval: 'auto',
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

  console.log(`\x1b[32m✓\x1b[0m Created ${configPath}`);
  console.log(`  Provider: ${provider}`);
  console.log('');
  console.log('Next steps:');
  console.log('  flow-weaver weaver providers              # verify provider detection');
  console.log('  flow-weaver weaver bot "Create a ..."     # create your first workflow');
}
