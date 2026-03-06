import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TriggerSource, WatchDaemonOptions, WatchDaemonState, WorkflowResult, ExecutionEvent } from './types.js';
import { runWorkflow } from './runner.js';
import { parseCron } from './cron-parser.js';
import { FileWatcher } from './file-watcher.js';
import { CronScheduler } from './cron-scheduler.js';

export class WatchDaemon {
  private options: WatchDaemonOptions;
  private fileWatcher: FileWatcher | null = null;
  private cronScheduler: CronScheduler | null = null;
  private logStream: fs.WriteStream | null = null;
  private state: WatchDaemonState;
  private stopping = false;
  private forceExit = false;

  constructor(options: WatchDaemonOptions) {
    this.options = options;
    this.state = {
      running: false,
      lastRun: null,
      lastTrigger: null,
      lastResult: null,
      runCount: 0,
      errorCount: 0,
      startedAt: new Date(),
      queued: false,
    };
  }

  async start(): Promise<void> {
    const absPath = path.resolve(this.options.filePath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`Workflow file not found: ${absPath}`);
    }

    if (this.options.logFile) {
      this.logStream = fs.createWriteStream(this.options.logFile, { flags: 'a' });
    }

    this.log(`Watching ${absPath}`);

    if (this.options.watchFile) {
      this.fileWatcher = new FileWatcher({
        filePath: absPath,
        debounceMs: this.options.debounceMs,
      });
      this.fileWatcher.on('change', () => this.onTrigger('file-change'));
      this.fileWatcher.start();
      this.log('File watcher started');
    }

    if (this.options.cron) {
      const parsed = parseCron(this.options.cron);
      this.cronScheduler = new CronScheduler(parsed);
      this.cronScheduler.on('tick', () => this.onTrigger('cron'));
      this.cronScheduler.start();
      this.log(`Cron scheduler started: ${this.options.cron}`);
    }

    this.setupSignalHandlers();

    // Keep alive
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (this.forceExit) {
          clearInterval(check);
          resolve();
        }
      }, 500);
    });

    this.cleanup();
  }

  private onTrigger(source: TriggerSource): void {
    if (this.stopping) return;

    if (this.state.running) {
      this.state.queued = true;
      this.log(`Run in progress, queuing trigger (${source})`);
      return;
    }

    this.executeRun(source);
  }

  private async executeRun(source: TriggerSource): Promise<void> {
    this.state.running = true;
    this.state.queued = false;
    const runNum = this.state.runCount + 1;

    this.log(`\nRun #${runNum} triggered by ${source}`);

    const onEvent = this.options.quiet
      ? undefined
      : (event: ExecutionEvent) => {
          if (event.type === 'node-complete') {
            this.log(`  + ${event.nodeId}${event.nodeType ? ` (${event.nodeType})` : ''}`);
          } else if (event.type === 'node-error') {
            this.log(`  x ${event.nodeId}: ${event.error ?? 'unknown error'}`);
          }
        };

    try {
      const result = await runWorkflow(path.resolve(this.options.filePath), {
        params: this.options.params,
        verbose: this.options.verbose,
        config: this.options.config,
        onEvent,
      });

      this.state.lastResult = result;
      this.state.runCount++;
      this.state.lastRun = new Date();
      this.state.lastTrigger = source;

      if (!result.success) this.state.errorCount++;

      const statusColor = result.success ? '\x1b[32m' : '\x1b[31m';
      this.log(`${statusColor}Run #${runNum}: ${result.outcome}\x1b[0m - ${result.summary}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.state.errorCount++;
      this.state.runCount++;
      this.state.lastRun = new Date();
      this.log(`\x1b[31mRun #${runNum}: fatal error\x1b[0m - ${msg}`);
    }

    this.state.running = false;

    if (this.state.queued && !this.stopping) {
      this.executeRun(source);
    }
  }

  private setupSignalHandlers(): void {
    const handler = () => {
      if (this.stopping) {
        // Second signal: force exit after 2s
        this.log('\nForce exit in 2s...');
        setTimeout(() => {
          this.forceExit = true;
        }, 2000);
        return;
      }

      this.stopping = true;
      this.log('\nStopping daemon...');

      if (this.fileWatcher) this.fileWatcher.stop();
      if (this.cronScheduler) this.cronScheduler.stop();

      if (this.state.running) {
        this.log('Waiting for current run to finish (30s timeout, Ctrl+C to force)...');
        const timeout = setTimeout(() => {
          this.forceExit = true;
        }, 30_000);

        const check = setInterval(() => {
          if (!this.state.running) {
            clearTimeout(timeout);
            clearInterval(check);
            this.printSummary();
            this.forceExit = true;
          }
        }, 500);
      } else {
        this.printSummary();
        this.forceExit = true;
      }
    };

    process.on('SIGINT', handler);
    process.on('SIGTERM', handler);
  }

  private printSummary(): void {
    const uptime = Date.now() - this.state.startedAt.getTime();
    const uptimeStr = uptime < 60_000
      ? `${(uptime / 1000).toFixed(0)}s`
      : `${(uptime / 60_000).toFixed(1)}m`;

    this.log(`\nDaemon summary: ${this.state.runCount} runs, ${this.state.errorCount} errors, uptime ${uptimeStr}`);
  }

  private log(msg: string): void {
    const ts = new Date().toISOString().slice(11, 19);
    const line = `[${ts}] ${msg}`;
    console.log(line);
    if (this.logStream) {
      this.logStream.write(line + '\n');
    }
  }

  private cleanup(): void {
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }
  }
}
