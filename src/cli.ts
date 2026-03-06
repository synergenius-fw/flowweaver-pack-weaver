#!/usr/bin/env node

import * as path from 'node:path';
import { runWorkflow } from './bot/runner.js';
import type { ExecutionEvent, WeaverConfig } from './bot/types.js';

const HELP = `
weaver - Autonomous workflow runner for Flow Weaver

Usage:
  weaver <file>                    Run a workflow file
  weaver run <file>                Same as above
  weaver --help                    Show this help

Options:
  -v, --verbose                    Show detailed execution info
  -n, --dry-run                    Preview without executing
  -p, --params <json>              Input parameters as JSON
  -c, --config <path>              Path to .weaver.json config
  --quiet                          Suppress progress output
  --version                        Show version

Examples:
  weaver my-workflow.ts
  weaver run pipeline.ts --verbose --params '{"env":"prod"}'
  weaver genesis-task.ts --config ./custom-weaver.json
`.trim();

function parseArgs(argv: string[]): {
  file?: string;
  verbose: boolean;
  dryRun: boolean;
  quiet: boolean;
  params?: Record<string, unknown>;
  configPath?: string;
  showHelp: boolean;
  showVersion: boolean;
} {
  const result = {
    file: undefined as string | undefined,
    verbose: false,
    dryRun: false,
    quiet: false,
    params: undefined as Record<string, unknown> | undefined,
    configPath: undefined as string | undefined,
    showHelp: false,
    showVersion: false,
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
    } else if (arg === 'run') {
      // skip, next arg is the file
    } else if (!arg.startsWith('-')) {
      result.file = arg;
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

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);

  if (opts.showHelp) {
    console.log(HELP);
    process.exit(0);
  }

  if (opts.showVersion) {
    // Read version from package.json at runtime
    try {
      const pkgPath = new URL('../package.json', import.meta.url);
      const { default: pkg } = await import(pkgPath.href, { with: { type: 'json' } });
      console.log(`weaver v${pkg.version}`);
    } catch {
      console.log('weaver (version unknown)');
    }
    process.exit(0);
  }

  if (!opts.file) {
    console.error('[weaver] No workflow file specified');
    console.error('Run "weaver --help" for usage');
    process.exit(1);
  }

  const filePath = path.resolve(opts.file);

  // Load config from file if specified
  let config: WeaverConfig | undefined;
  if (opts.configPath) {
    try {
      const { readFileSync } = await import('node:fs');
      config = JSON.parse(readFileSync(path.resolve(opts.configPath), 'utf-8'));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[weaver] Failed to read config: ${msg}`);
      process.exit(1);
    }
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
    }

    process.exit(result.success ? 0 : 1);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m[weaver] Fatal: ${msg}\x1b[0m`);
    process.exit(1);
  }
}

main();
