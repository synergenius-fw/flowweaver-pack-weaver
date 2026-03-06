#!/usr/bin/env node

import * as path from 'node:path';
import { runWorkflow } from './bot/runner.js';
import { RunStore } from './bot/run-store.js';
import { CostStore } from './bot/cost-store.js';
import { defaultRegistry, discoverProviders } from './bot/provider-registry.js';
import { WatchDaemon } from './bot/watch-daemon.js';
import { PipelineRunner } from './bot/pipeline-runner.js';
import { DashboardServer } from './bot/dashboard.js';
import { openBrowser } from './bot/utils.js';
import type { ExecutionEvent, WeaverConfig, RunRecord, RunOutcome, RunCostSummary, CostSummary, StageStatus, WorkflowResult } from './bot/types.js';

const HELP = `
weaver - Autonomous workflow runner for Flow Weaver

Usage:
  weaver <file>                    Run a workflow file
  weaver run <file>                Same as above
  weaver history                   List recent runs
  weaver history <id>              Show details of a specific run
  weaver costs                     Show cost summary
  weaver watch <file>               Watch file, re-run on change
  weaver cron "<schedule>" <file>   Run on cron schedule
  weaver pipeline <config.json>     Run multi-stage pipeline
  weaver dashboard [file]           Start live dashboard (optionally run file)
  weaver providers                  List available providers
  weaver --help                     Show this help

Options:
  -v, --verbose                    Show detailed execution info
  -n, --dry-run                    Preview without executing
  -p, --params <json>              Input parameters as JSON
  -c, --config <path>              Path to .weaver.json config
  --quiet                          Suppress progress output
  --version                        Show version
  --dashboard                      Enable live dashboard for run
  --port <number>                  Dashboard port (default 4242)
  --open                           Auto-open browser
  --approval <mode>                Override approval mode

Watch/Cron options:
  --cron "<schedule>"              Add cron trigger to watch mode
  --debounce <ms>                  File watch debounce (default 500)
  --log <path>                     Write output to log file

Pipeline options:
  --stage <id>                     Run single stage + its dependencies

History options:
  --limit <n>                      Number of entries (default: 20)
  --outcome <type>                 Filter: completed|failed|error|skipped
  --workflow <path>                Filter by workflow file
  --since <date>                   Show runs after date (ISO-8601)
  --json                           JSON output
  --prune                          Prune old entries (keep 500, 90 days)
  --clear                          Delete all history

Cost options:
  --since <duration|date>          Filter: 7d, 30d, or ISO-8601 date
  --model <name>                   Filter by model

Examples:
  weaver my-workflow.ts
  weaver run pipeline.ts --verbose --params '{"env":"prod"}'
  weaver watch my-workflow.ts --cron "*/5 * * * *"
  weaver pipeline deploy.json --stage test
  weaver history --outcome failed --limit 10
  weaver costs --since 7d
`.trim();

interface ParsedArgs {
  command: 'run' | 'history' | 'costs' | 'providers' | 'watch' | 'cron' | 'pipeline' | 'dashboard';
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
}

function parseArgs(argv: string[]): ParsedArgs {
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
      result.historyWorkflow = args[i];
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
      console.error('Run "weaver --help" for usage');
      process.exit(1);
    }
    i++;
  }

  return result;
}

function formatDuration(ms: number): string {
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

// --- History ---

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
  console.log('');
}

async function handleHistory(opts: ParsedArgs): Promise<void> {
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

// --- Costs ---

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

async function handleCosts(opts: ParsedArgs): Promise<void> {
  const store = new CostStore();
  const sinceTs = parseSince(opts.costsSince);
  const summary = store.summarize({ since: sinceTs, model: opts.costsModel });

  if (summary.totalRuns === 0) {
    console.log('No cost data found.');
    return;
  }

  console.log(formatCostTable(summary));
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

// --- Watch/Cron ---

async function handleWatch(opts: ParsedArgs): Promise<void> {
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

async function handleCron(opts: ParsedArgs): Promise<void> {
  if (!opts.cronSchedule) {
    console.error('[weaver] No cron schedule specified');
    console.error('Usage: weaver cron "*/5 * * * *" <file>');
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

// --- Pipeline ---

const STAGE_ICONS: Record<string, string> = {
  running: '\x1b[36m>\x1b[0m',
  completed: '\x1b[32m+\x1b[0m',
  failed: '\x1b[31mx\x1b[0m',
  skipped: '\x1b[33m-\x1b[0m',
  cancelled: '\x1b[33m~\x1b[0m',
};

async function handlePipeline(opts: ParsedArgs): Promise<void> {
  if (!opts.file) {
    console.error('[weaver] No pipeline config specified');
    console.error('Usage: weaver pipeline <config.json>');
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

// --- Dashboard ---

async function handleDashboard(opts: ParsedArgs): Promise<void> {
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

// --- Providers ---

async function handleProviders(): Promise<void> {
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

// --- Main ---

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);

  // Recover orphaned runs from previous crashes
  try {
    const store = new RunStore();
    const orphans = store.checkOrphans();
    for (const orphan of orphans) {
      console.error(`[weaver] Recovered orphaned run ${orphan.id.slice(0, 8)} (${orphan.workflowFile}) killed at PID ${orphan.pid}`);
    }
  } catch { /* non-fatal */ }

  if (opts.showHelp) {
    console.log(HELP);
    process.exit(0);
  }

  if (opts.showVersion) {
    try {
      const pkgPath = new URL('../package.json', import.meta.url);
      const { default: pkg } = await import(pkgPath.href, { with: { type: 'json' } });
      console.log(`weaver v${pkg.version}`);
    } catch {
      console.log('weaver (version unknown)');
    }
    process.exit(0);
  }

  if (opts.command === 'history') {
    await handleHistory(opts);
    process.exit(0);
  }

  if (opts.command === 'costs') {
    await handleCosts(opts);
    process.exit(0);
  }

  if (opts.command === 'providers') {
    await handleProviders();
    process.exit(0);
  }

  if (opts.command === 'watch') {
    await handleWatch(opts);
    process.exit(0);
  }

  if (opts.command === 'cron') {
    await handleCron(opts);
    process.exit(0);
  }

  if (opts.command === 'pipeline') {
    await handlePipeline(opts);
    return;
  }

  if (opts.command === 'dashboard' || opts.dashboard) {
    await handleDashboard(opts);
    return;
  }

  if (!opts.file) {
    console.error('[weaver] No workflow file specified');
    console.error('Run "weaver --help" for usage');
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
        console.log(`\x1b[32mWeaver: ${result.outcome}\x1b[0m (${elapsed})`);
      } else {
        console.log(`\x1b[31mWeaver: ${result.outcome}\x1b[0m (${elapsed})`);
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

main();
