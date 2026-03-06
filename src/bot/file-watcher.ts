import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';

export interface FileWatcherOptions {
  filePath: string;
  debounceMs?: number;
  pollingIntervalMs?: number;
}

export class FileWatcher extends EventEmitter {
  private filePath: string;
  private debounceMs: number;
  private pollingIntervalMs: number;
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMtime: number = 0;
  private stopped = false;

  constructor(options: FileWatcherOptions) {
    super();
    this.filePath = options.filePath;
    this.debounceMs = options.debounceMs ?? 500;
    this.pollingIntervalMs = options.pollingIntervalMs ?? 2000;
  }

  start(): void {
    this.stopped = false;
    this.lastMtime = this.getMtime();
    this.attachFsWatch();
  }

  stop(): void {
    this.stopped = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private attachFsWatch(): void {
    try {
      this.watcher = fs.watch(this.filePath, () => this.onFsEvent());
      this.watcher.on('error', () => this.switchToPolling());
    } catch {
      this.switchToPolling();
    }
  }

  private switchToPolling(): void {
    if (this.stopped) return;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollTimer) return;

    this.pollTimer = setInterval(() => {
      if (this.stopped) return;
      const mtime = this.getMtime();
      if (mtime > this.lastMtime) {
        this.lastMtime = mtime;
        this.emit('change');
      }

      // Try to re-attach fs.watch
      if (!this.watcher && fs.existsSync(this.filePath)) {
        try {
          this.watcher = fs.watch(this.filePath, () => this.onFsEvent());
          this.watcher.on('error', () => this.switchToPolling());
          if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
          }
        } catch {
          // Stay in polling mode
        }
      }
    }, this.pollingIntervalMs);
  }

  private onFsEvent(): void {
    if (this.stopped) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      const mtime = this.getMtime();
      if (mtime > this.lastMtime) {
        this.lastMtime = mtime;
        this.emit('change');
      }
    }, this.debounceMs);
  }

  private getMtime(): number {
    try {
      return fs.statSync(this.filePath).mtimeMs;
    } catch {
      return 0;
    }
  }
}
