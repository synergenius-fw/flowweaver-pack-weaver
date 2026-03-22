import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseCron } from '../src/bot/cron-parser.js';
import { CronScheduler } from '../src/bot/cron-scheduler.js';

// ---------------------------------------------------------------------------
// Tests for cron-scheduler.ts
// Focus: lifecycle, tick emission, timer leak on double-start
// ---------------------------------------------------------------------------

describe('CronScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // Basic lifecycle
  // =========================================================================
  describe('start and stop', () => {
    it('emits tick at the next matching minute', async () => {
      // Schedule for every minute: "* * * * *"
      const parsed = parseCron('* * * * *');
      const scheduler = new CronScheduler(parsed);
      const ticks: number[] = [];
      scheduler.on('tick', () => ticks.push(Date.now()));

      scheduler.start();

      // Advance 2 minutes — should get at least 1 tick
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

      scheduler.stop();
      expect(ticks.length).toBeGreaterThanOrEqual(1);
    });

    it('stop prevents further ticks', async () => {
      const parsed = parseCron('* * * * *');
      const scheduler = new CronScheduler(parsed);
      const ticks: number[] = [];
      scheduler.on('tick', () => ticks.push(Date.now()));

      scheduler.start();

      // Get one tick
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      const countAfterFirst = ticks.length;
      expect(countAfterFirst).toBeGreaterThanOrEqual(1);

      scheduler.stop();

      // Advance more — should get no additional ticks
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(ticks.length).toBe(countAfterFirst);
    });

    it('stop is safe to call when not started', () => {
      const parsed = parseCron('* * * * *');
      const scheduler = new CronScheduler(parsed);
      expect(() => scheduler.stop()).not.toThrow();
    });

    it('stop is safe to call multiple times', async () => {
      const parsed = parseCron('* * * * *');
      const scheduler = new CronScheduler(parsed);
      scheduler.start();
      scheduler.stop();
      expect(() => scheduler.stop()).not.toThrow();
    });
  });

  // =========================================================================
  // Tick emission
  // =========================================================================
  describe('tick emission', () => {
    it('emits multiple ticks over time', async () => {
      const parsed = parseCron('* * * * *');
      const scheduler = new CronScheduler(parsed);
      const ticks: number[] = [];
      scheduler.on('tick', () => ticks.push(Date.now()));

      scheduler.start();

      // Advance 5 minutes
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      scheduler.stop();

      // Should have gotten multiple ticks (one per minute)
      expect(ticks.length).toBeGreaterThanOrEqual(3);
    });
  });

  // =========================================================================
  // TIMER LEAK BUG: double-start
  // =========================================================================
  describe('double-start timer leak', () => {
    it('calling start() twice does NOT cause duplicate ticks', async () => {
      const parsed = parseCron('* * * * *');
      const scheduler = new CronScheduler(parsed);
      const ticks: number[] = [];
      scheduler.on('tick', () => ticks.push(Date.now()));

      // Start twice — the bug: two timer chains run concurrently
      scheduler.start();
      scheduler.start();

      // Advance exactly 2 minutes
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      scheduler.stop();

      // With the bug: we'd get ~4 ticks (2 per chain)
      // With the fix: we'd get ~2 ticks (1 chain only)
      // Allow some slack but should NOT be doubled
      expect(ticks.length).toBeLessThanOrEqual(2);
    });

    it('stop() after double-start kills ALL timers', async () => {
      const parsed = parseCron('* * * * *');
      const scheduler = new CronScheduler(parsed);
      const ticks: number[] = [];
      scheduler.on('tick', () => ticks.push(Date.now()));

      scheduler.start();
      scheduler.start();
      scheduler.stop();

      // Advance time — should get zero ticks after stop
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(ticks.length).toBe(0);
    });
  });

  // =========================================================================
  // Long delay chaining (MAX_TIMEOUT boundary)
  // =========================================================================
  describe('long delay chaining', () => {
    it('handles delays longer than MAX_TIMEOUT via chaining', async () => {
      // Schedule for a specific minute far in the future won't work with
      // fake timers easily, but we can test that the scheduler doesn't
      // throw when set up with a restrictive cron
      const parsed = parseCron('0 0 1 1 *'); // Jan 1 at midnight only
      const scheduler = new CronScheduler(parsed);
      const ticks: number[] = [];
      scheduler.on('tick', () => ticks.push(Date.now()));

      scheduler.start();

      // Advance a small amount — should not tick (next match is far away)
      await vi.advanceTimersByTimeAsync(60 * 1000);
      scheduler.stop();

      expect(ticks.length).toBe(0);
    });
  });

  // =========================================================================
  // Restart after stop
  // =========================================================================
  describe('restart after stop', () => {
    it('can be restarted after being stopped', async () => {
      const parsed = parseCron('* * * * *');
      const scheduler = new CronScheduler(parsed);
      const ticks: number[] = [];
      scheduler.on('tick', () => ticks.push(Date.now()));

      scheduler.start();
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      scheduler.stop();
      const countAfterStop = ticks.length;

      // Restart
      scheduler.start();
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      scheduler.stop();

      expect(ticks.length).toBeGreaterThan(countAfterStop);
    });
  });
});
