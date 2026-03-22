import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CostTracker, MODEL_PRICING } from '../src/bot/cost-tracker.js';
import type { TokenUsage } from '../src/bot/types.js';

describe('CostTracker', () => {
  describe('estimateCost (static)', () => {
    it('returns 0 for unknown model', () => {
      const usage: TokenUsage = { inputTokens: 1000, outputTokens: 500 };
      expect(CostTracker.estimateCost('unknown-model-xyz', usage)).toBe(0);
    });

    it('calculates cost for claude-sonnet-4-6 with no cache tokens', () => {
      const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
      // input: 1M * 3/1M = 3, output: 1M * 15/1M = 15
      expect(CostTracker.estimateCost('claude-sonnet-4-6', usage)).toBe(18);
    });

    it('calculates cost for haiku model (cheaper tier)', () => {
      const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
      // input: 1M * 0.8/1M = 0.8, output: 1M * 4/1M = 4
      expect(CostTracker.estimateCost('claude-haiku-4-5', usage)).toBe(4.8);
    });

    it('calculates cost for opus model (expensive tier)', () => {
      const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
      // input: 1M * 15/1M = 15, output: 1M * 75/1M = 75
      expect(CostTracker.estimateCost('claude-opus-4-6', usage)).toBe(90);
    });

    it('includes cacheReadInputTokens in cost calculation', () => {
      const usage: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 1_000_000,
      };
      // cacheRead: 1M * 0.3/1M = 0.3
      expect(CostTracker.estimateCost('claude-sonnet-4-6', usage)).toBeCloseTo(0.3);
    });

    it('includes cacheCreationInputTokens in cost calculation', () => {
      const usage: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 1_000_000,
      };
      // cacheCreation: 1M * 3.75/1M = 3.75
      expect(CostTracker.estimateCost('claude-sonnet-4-6', usage)).toBeCloseTo(3.75);
    });

    it('handles all token types together', () => {
      const usage: TokenUsage = {
        inputTokens: 500_000,
        outputTokens: 200_000,
        cacheReadInputTokens: 300_000,
        cacheCreationInputTokens: 100_000,
      };
      // input: 0.5M * 3 = 1.5, output: 0.2M * 15 = 3.0
      // cacheRead: 0.3M * 0.3 = 0.09, cacheCreation: 0.1M * 3.75 = 0.375
      const expected = 1.5 + 3.0 + 0.09 + 0.375;
      expect(CostTracker.estimateCost('claude-sonnet-4-6', usage)).toBeCloseTo(expected);
    });

    it('returns 0 for zero tokens on known model', () => {
      const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
      expect(CostTracker.estimateCost('claude-sonnet-4-6', usage)).toBe(0);
    });

    it('treats undefined cache tokens as 0', () => {
      const usage: TokenUsage = { inputTokens: 100, outputTokens: 100 };
      // No cacheReadInputTokens or cacheCreationInputTokens -- should not throw
      const cost = CostTracker.estimateCost('claude-sonnet-4-6', usage);
      expect(cost).toBeGreaterThan(0);
      // input: 100 * 3/1M + output: 100 * 15/1M
      expect(cost).toBeCloseTo((100 * 3 + 100 * 15) / 1_000_000);
    });
  });

  describe('track', () => {
    it('records an entry with correct fields', () => {
      const tracker = new CostTracker('claude-sonnet-4-6', 'anthropic');
      const usage: TokenUsage = { inputTokens: 1000, outputTokens: 500 };

      vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
      tracker.track('step-1', 'claude-sonnet-4-6', usage);

      const summary = tracker.getRunSummary();
      expect(summary.entries).toHaveLength(1);
      expect(summary.entries[0]).toEqual({
        step: 'step-1',
        model: 'claude-sonnet-4-6',
        usage,
        estimatedCost: CostTracker.estimateCost('claude-sonnet-4-6', usage),
        timestamp: 1700000000000,
      });

      vi.restoreAllMocks();
    });

    it('accumulates multiple entries', () => {
      const tracker = new CostTracker('claude-sonnet-4-6', 'anthropic');
      tracker.track('a', 'claude-sonnet-4-6', { inputTokens: 100, outputTokens: 50 });
      tracker.track('b', 'claude-haiku-4-5', { inputTokens: 200, outputTokens: 100 });
      tracker.track('c', 'claude-opus-4-6', { inputTokens: 300, outputTokens: 150 });

      expect(tracker.getRunSummary().entries).toHaveLength(3);
    });
  });

  describe('getRunSummary', () => {
    it('returns defaults when no entries tracked', () => {
      const tracker = new CostTracker('claude-sonnet-4-6', 'anthropic');
      const summary = tracker.getRunSummary();

      expect(summary.totalInputTokens).toBe(0);
      expect(summary.totalOutputTokens).toBe(0);
      expect(summary.totalCost).toBe(0);
      expect(summary.model).toBe('claude-sonnet-4-6');
      expect(summary.provider).toBe('anthropic');
      expect(summary.entries).toEqual([]);
    });

    it('aggregates tokens and cost across entries', () => {
      const tracker = new CostTracker('claude-sonnet-4-6', 'anthropic');
      tracker.track('a', 'claude-sonnet-4-6', { inputTokens: 1000, outputTokens: 500 });
      tracker.track('b', 'claude-sonnet-4-6', { inputTokens: 2000, outputTokens: 1000 });

      const summary = tracker.getRunSummary();
      expect(summary.totalInputTokens).toBe(3000);
      expect(summary.totalOutputTokens).toBe(1500);
      expect(summary.totalCost).toBeGreaterThan(0);
    });

    it('uses first entry model when entries exist', () => {
      const tracker = new CostTracker('default-model', 'anthropic');
      tracker.track('a', 'claude-haiku-4-5', { inputTokens: 100, outputTokens: 50 });

      expect(tracker.getRunSummary().model).toBe('claude-haiku-4-5');
    });

    it('returns a copy of entries (not the internal array)', () => {
      const tracker = new CostTracker('claude-sonnet-4-6', 'anthropic');
      tracker.track('a', 'claude-sonnet-4-6', { inputTokens: 100, outputTokens: 50 });

      const entries1 = tracker.getRunSummary().entries;
      const entries2 = tracker.getRunSummary().entries;
      expect(entries1).not.toBe(entries2);
      expect(entries1).toEqual(entries2);
    });
  });

  describe('hasEntries', () => {
    it('returns false when empty', () => {
      const tracker = new CostTracker('claude-sonnet-4-6', 'anthropic');
      expect(tracker.hasEntries()).toBe(false);
    });

    it('returns true after tracking', () => {
      const tracker = new CostTracker('claude-sonnet-4-6', 'anthropic');
      tracker.track('a', 'claude-sonnet-4-6', { inputTokens: 100, outputTokens: 50 });
      expect(tracker.hasEntries()).toBe(true);
    });
  });

  describe('MODEL_PRICING', () => {
    it('has pricing for all 7 known models', () => {
      expect(Object.keys(MODEL_PRICING)).toHaveLength(7);
    });

    it('all models have inputPer1M and outputPer1M', () => {
      for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
        expect(pricing.inputPer1M, `${model} missing inputPer1M`).toBeGreaterThan(0);
        expect(pricing.outputPer1M, `${model} missing outputPer1M`).toBeGreaterThan(0);
      }
    });

    it('all models have cache pricing defined', () => {
      for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
        expect(pricing.cacheReadPer1M, `${model} missing cacheReadPer1M`).toBeDefined();
        expect(pricing.cacheCreationPer1M, `${model} missing cacheCreationPer1M`).toBeDefined();
      }
    });
  });
});
