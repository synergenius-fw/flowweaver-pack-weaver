/**
 * Tests for the Steering Engine — time-based and event-based nudges
 * that guide the assistant's behavior during long-running operations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SteeringEngine, type Steer } from '../src/bot/steering-engine.js';

describe('SteeringEngine', () => {
  let now: number;

  beforeEach(() => {
    now = Date.now();
    vi.useFakeTimers({ now });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('time-based triggers', () => {
    it('fires a time trigger after the specified duration', () => {
      const engine = new SteeringEngine([{
        id: 'check-5m',
        trigger: { type: 'time', afterMs: 300_000 },
        message: 'Check your direction.',
        intensity: 'gentle',
        once: true,
      }]);

      // Before 5 min — no steer
      vi.advanceTimersByTime(299_000);
      expect(engine.check()).toBeNull();

      // After 5 min — fires
      vi.advanceTimersByTime(2_000);
      const messages = engine.check();
      expect(messages).not.toBeNull();
      expect(messages).toContain('Check your direction.');
    });

    it('once: true fires only once', () => {
      const engine = new SteeringEngine([{
        id: 'once-steer',
        trigger: { type: 'time', afterMs: 1000 },
        message: 'Fire once.',
        intensity: 'gentle',
        once: true,
      }]);

      vi.advanceTimersByTime(2000);
      expect(engine.check()).not.toBeNull();
      expect(engine.check()).toBeNull(); // second call — already fired
    });

    it('once: false fires every check after threshold', () => {
      const engine = new SteeringEngine([{
        id: 'repeat-steer',
        trigger: { type: 'time', afterMs: 1000 },
        message: 'Keep going.',
        intensity: 'gentle',
        once: false,
      }]);

      vi.advanceTimersByTime(2000);
      expect(engine.check()).not.toBeNull();
      expect(engine.check()).not.toBeNull(); // fires again
    });

    it('returns null before any trigger fires', () => {
      const engine = new SteeringEngine([{
        id: 'late',
        trigger: { type: 'time', afterMs: 600_000 },
        message: 'Late steer.',
        intensity: 'urgent',
        once: true,
      }]);

      expect(engine.check()).toBeNull();
    });

    it('fires multiple time steers in priority order (earliest first)', () => {
      const engine = new SteeringEngine([
        { id: 'late', trigger: { type: 'time', afterMs: 20_000 }, message: 'Late.', intensity: 'urgent', once: true },
        { id: 'early', trigger: { type: 'time', afterMs: 5_000 }, message: 'Early.', intensity: 'gentle', once: true },
      ]);

      vi.advanceTimersByTime(25_000);
      const msg = engine.check();
      // Both should fire, but the most recent (highest intensity) should be included
      expect(msg).toContain('Late.');
    });
  });

  describe('event-based triggers', () => {
    it('fires after the specified event count', () => {
      const engine = new SteeringEngine([{
        id: 'errors',
        trigger: { type: 'event', event: 'tool_error', count: 3 },
        message: 'Too many errors.',
        intensity: 'firm',
        once: true,
      }]);

      engine.recordEvent('tool_error');
      expect(engine.check()).toBeNull();
      engine.recordEvent('tool_error');
      expect(engine.check()).toBeNull();
      engine.recordEvent('tool_error'); // 3rd
      expect(engine.check()).not.toBeNull();
    });

    it('fires on first occurrence when count is 1 (default)', () => {
      const engine = new SteeringEngine([{
        id: 'test-fail',
        trigger: { type: 'event', event: 'test_fail' },
        message: 'Tests failed.',
        intensity: 'gentle',
        once: false,
      }]);

      engine.recordEvent('test_fail');
      expect(engine.check()).toContain('Tests failed.');
    });

    it('does not fire for different events', () => {
      const engine = new SteeringEngine([{
        id: 'only-errors',
        trigger: { type: 'event', event: 'tool_error', count: 1 },
        message: 'Error!',
        intensity: 'firm',
        once: true,
      }]);

      engine.recordEvent('tool_success');
      engine.recordEvent('file_write');
      expect(engine.check()).toBeNull();
    });

    it('once: true fires only once even with more events', () => {
      const engine = new SteeringEngine([{
        id: 'once-event',
        trigger: { type: 'event', event: 'test_fail', count: 1 },
        message: 'Failed.',
        intensity: 'firm',
        once: true,
      }]);

      engine.recordEvent('test_fail');
      expect(engine.check()).not.toBeNull();
      engine.recordEvent('test_fail');
      expect(engine.check()).toBeNull();
    });

    it('once: false re-fires after more events', () => {
      const engine = new SteeringEngine([{
        id: 'repeat-event',
        trigger: { type: 'event', event: 'test_fail', count: 2 },
        message: 'Failed again.',
        intensity: 'firm',
        once: false,
      }]);

      engine.recordEvent('test_fail');
      engine.recordEvent('test_fail');
      expect(engine.check()).not.toBeNull();
      // Clear pending, then trigger 2 more
      engine.recordEvent('test_fail');
      engine.recordEvent('test_fail');
      expect(engine.check()).not.toBeNull();
    });
  });

  describe('intensity formatting', () => {
    it('gentle uses [CONTEXT NOTE] prefix', () => {
      const engine = new SteeringEngine([{
        id: 'g', trigger: { type: 'time', afterMs: 0 }, message: 'Be gentle.', intensity: 'gentle', once: true,
      }]);
      vi.advanceTimersByTime(1);
      expect(engine.check()).toContain('[CONTEXT NOTE]');
    });

    it('firm uses [STEER] prefix', () => {
      const engine = new SteeringEngine([{
        id: 'f', trigger: { type: 'time', afterMs: 0 }, message: 'Be firm.', intensity: 'firm', once: true,
      }]);
      vi.advanceTimersByTime(1);
      expect(engine.check()).toContain('[STEER]');
    });

    it('urgent uses [URGENT STEER] prefix', () => {
      const engine = new SteeringEngine([{
        id: 'u', trigger: { type: 'time', afterMs: 0 }, message: 'Stop now.', intensity: 'urgent', once: true,
      }]);
      vi.advanceTimersByTime(1);
      expect(engine.check()).toContain('[URGENT STEER]');
    });
  });

  describe('getPendingMessages', () => {
    it('returns all triggered messages and clears them', () => {
      const engine = new SteeringEngine([
        { id: 'a', trigger: { type: 'time', afterMs: 0 }, message: 'A', intensity: 'gentle', once: true },
        { id: 'b', trigger: { type: 'time', afterMs: 0 }, message: 'B', intensity: 'firm', once: true },
      ]);
      vi.advanceTimersByTime(1);
      engine.check(); // populates pending queue
      const msgs = engine.getPendingMessages();
      expect(msgs).toHaveLength(2);
      expect(engine.getPendingMessages()).toHaveLength(0);
    });
  });

  describe('reset', () => {
    it('resets all state for a new cycle', () => {
      const engine = new SteeringEngine([{
        id: 'r', trigger: { type: 'time', afterMs: 1000 }, message: 'Reset me.', intensity: 'gentle', once: true,
      }]);
      vi.advanceTimersByTime(2000);
      expect(engine.check()).not.toBeNull();
      engine.reset();
      // After reset, the timer restarts — should not fire immediately
      expect(engine.check()).toBeNull();
      vi.advanceTimersByTime(2000);
      expect(engine.check()).not.toBeNull(); // fires again after reset
    });
  });

  describe('hasHardStop', () => {
    it('returns true when urgent steer with STOP in message fires', () => {
      const engine = new SteeringEngine([{
        id: 'stop', trigger: { type: 'time', afterMs: 60_000 }, message: 'STOP. Time is up.', intensity: 'urgent', once: true,
      }]);
      expect(engine.hasHardStop()).toBe(false);
      vi.advanceTimersByTime(61_000);
      engine.check(); // process triggers
      expect(engine.hasHardStop()).toBe(true);
    });
  });
});
