import { EventEmitter } from 'node:events';
import type { ParsedCron } from './types.js';
import { nextMatch } from './cron-parser.js';

const MAX_TIMEOUT = 2_147_483_647; // ~24.8 days (2^31 - 1)

export class CronScheduler extends EventEmitter {
  private parsed: ParsedCron;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(parsed: ParsedCron) {
    super();
    this.parsed = parsed;
  }

  start(): void {
    this.stop();
    this.stopped = false;
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;

    const now = new Date();
    const next = nextMatch(this.parsed, now);
    const delayMs = next.getTime() - Date.now();

    if (delayMs > MAX_TIMEOUT) {
      // Chain intermediate timeouts for very long delays
      this.timer = setTimeout(() => this.scheduleNext(), MAX_TIMEOUT);
    } else {
      this.timer = setTimeout(() => {
        if (this.stopped) return;
        this.emit('tick');
        this.scheduleNext();
      }, Math.max(delayMs, 0));
    }
  }
}
