/**
 * Steering Engine — time-based and event-based nudges that guide the
 * assistant's behavior during long-running operations.
 *
 * Steers are injected into the system prompt when conditions are met.
 * They're guidance, not hard stops (except urgent + "STOP" which triggers hasHardStop).
 */

export interface TimeTrigger {
  type: 'time';
  afterMs: number;
}

export interface EventTrigger {
  type: 'event';
  event: string;
  count?: number; // default 1
}

export interface Steer {
  id: string;
  trigger: TimeTrigger | EventTrigger;
  message: string;
  intensity: 'gentle' | 'firm' | 'urgent';
  once: boolean;
}

const INTENSITY_PREFIX: Record<string, string> = {
  gentle: '[CONTEXT NOTE]',
  firm: '[STEER]',
  urgent: '[URGENT STEER]',
};

export class SteeringEngine {
  private readonly steers: Steer[];
  private startTime: number;
  private eventCounts = new Map<string, number>();
  private firedOnce = new Set<string>();
  private pendingMessages: string[] = [];
  private hardStopTriggered = false;
  // Track last event count when an event steer fired (for once: false repeat logic)
  private eventSteerLastFired = new Map<string, number>();

  constructor(steers: Steer[]) {
    this.steers = steers;
    this.startTime = Date.now();
  }

  /**
   * Check all steers and return the highest-priority triggered message,
   * or null if nothing fired.
   */
  check(): string | null {
    const triggered: string[] = [];
    const elapsed = Date.now() - this.startTime;

    for (const steer of this.steers) {
      if (steer.once && this.firedOnce.has(steer.id)) continue;

      let shouldFire = false;

      if (steer.trigger.type === 'time') {
        shouldFire = elapsed >= steer.trigger.afterMs;
      } else if (steer.trigger.type === 'event') {
        const count = this.eventCounts.get(steer.trigger.event) ?? 0;
        const threshold = steer.trigger.count ?? 1;

        if (steer.once) {
          shouldFire = count >= threshold;
        } else {
          // For repeat steers, fire every time we cross another threshold
          const lastFired = this.eventSteerLastFired.get(steer.id) ?? 0;
          shouldFire = count >= threshold && count > lastFired;
          if (shouldFire) {
            this.eventSteerLastFired.set(steer.id, count);
          }
        }
      }

      if (shouldFire) {
        const prefix = INTENSITY_PREFIX[steer.intensity] ?? '[STEER]';
        const formatted = `${prefix} ${steer.message}`;
        triggered.push(formatted);

        if (steer.once) this.firedOnce.add(steer.id);

        if (steer.intensity === 'urgent' && steer.message.includes('STOP')) {
          this.hardStopTriggered = true;
        }
      }
    }

    if (triggered.length === 0) return null;

    // Add each triggered message individually to pending
    this.pendingMessages.push(...triggered);

    // Return combined for inline use
    return triggered.join('\n\n');
  }

  /**
   * Record an event occurrence. May trigger event-based steers on next check().
   */
  recordEvent(event: string): void {
    this.eventCounts.set(event, (this.eventCounts.get(event) ?? 0) + 1);
  }

  /**
   * Get all pending messages since last call and clear the queue.
   */
  getPendingMessages(): string[] {
    const msgs = [...this.pendingMessages];
    this.pendingMessages = [];
    return msgs;
  }

  /**
   * Reset all state for a new cycle. Restarts the timer.
   */
  reset(): void {
    this.startTime = Date.now();
    this.eventCounts.clear();
    this.firedOnce.clear();
    this.pendingMessages = [];
    this.hardStopTriggered = false;
    this.eventSteerLastFired.clear();
  }

  /**
   * Returns true if an urgent steer with "STOP" in the message has fired.
   */
  hasHardStop(): boolean {
    return this.hardStopTriggered;
  }
}

/**
 * Default steers that ship with every assistant session.
 */
export const DEFAULT_STEERS: Steer[] = [
  {
    id: 'direction-check',
    trigger: { type: 'time', afterMs: 300_000 },
    message: "You've been working for 5 minutes. Take a step back — are you sure this is the right approach? If not, pivot now.",
    intensity: 'gentle',
    once: true,
  },
  {
    id: 'wrap-up',
    trigger: { type: 'time', afterMs: 1_200_000 },
    message: '20 minutes in. Focus on finishing your current change. If tests pass, commit. If not, fix only what\'s broken.',
    intensity: 'firm',
    once: true,
  },
  {
    id: 'final-warning',
    trigger: { type: 'time', afterMs: 2_700_000 },
    message: "45 minutes. Commit what works now. Revert anything that doesn't pass tests. Time is almost up.",
    intensity: 'urgent',
    once: true,
  },
  {
    id: 'hard-stop',
    trigger: { type: 'time', afterMs: 3_600_000 },
    message: 'STOP. 60 minutes reached. Commit passing work or revert everything.',
    intensity: 'urgent',
    once: true,
  },
  {
    id: 'repeated-errors',
    trigger: { type: 'event', event: 'tool_error', count: 3 },
    message: "You've hit 3 tool errors. Stop and reconsider your approach. Read the error messages carefully.",
    intensity: 'firm',
    once: false,
  },
  {
    id: 'test-failure-reflect',
    trigger: { type: 'event', event: 'test_fail' },
    message: "Tests failed. Don't just retry — think about WHY they failed. Read the error output carefully before making changes.",
    intensity: 'gentle',
    once: false,
  },
  {
    id: 'write-blocked',
    trigger: { type: 'event', event: 'file_write_blocked', count: 2 },
    message: "File writes are being blocked. You're probably using the wrong path. Use paths relative to the project directory, not absolute paths.",
    intensity: 'firm',
    once: true,
  },
];

/**
 * Additional steers for the improve loop.
 */
export const IMPROVE_STEERS: Steer[] = [
  {
    id: 'improve-focus',
    trigger: { type: 'time', afterMs: 120_000 },
    message: "2 minutes in. If you haven't started writing code yet, you're over-analyzing. Pick the simplest fix and start writing.",
    intensity: 'gentle',
    once: true,
  },
  {
    id: 'improve-commit-ready',
    trigger: { type: 'event', event: 'test_pass' },
    message: 'Tests pass. Commit your changes now unless you have a specific reason to keep going.',
    intensity: 'firm',
    once: false,
  },
];

/**
 * Load steers from .weaver-steers.json, merged with defaults.
 */
export function loadSteers(projectDir: string, extras: Steer[] = []): Steer[] {
  const base = [...DEFAULT_STEERS, ...extras];

  try {
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const configPath = path.join(projectDir, '.weaver-steers.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const userSteers: Steer[] = config.steers ?? [];
      // User steers override defaults by ID
      const userIds = new Set(userSteers.map(s => s.id));
      return [...base.filter(s => !userIds.has(s.id)), ...userSteers];
    }
  } catch { /* config not available */ }

  return base;
}
