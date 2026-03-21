import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WeaverContext } from '../src/bot/types.js';
import { weaverAbortTask } from '../src/node-types/abort-task.js';

function makeCtx(overrides: Partial<WeaverContext> = {}): string {
  const ctx: WeaverContext = {
    env: {
      projectDir: '/proj',
      config: { provider: 'auto' as const },
      providerType: 'anthropic' as const,
      providerInfo: { type: 'anthropic' as const, apiKey: 'key' },
    },
    taskJson: '{}',
    hasTask: true,
    ...overrides,
  };
  return JSON.stringify(ctx);
}

describe('weaverAbortTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  describe('result shape', () => {
    it('sets success=false in resultJson', () => {
      const result = weaverAbortTask(makeCtx({ rejectionReason: 'too risky' }));
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      const r = JSON.parse(ctx.resultJson!);
      expect(r.success).toBe(false);
    });

    it('sets outcome to "aborted"', () => {
      const result = weaverAbortTask(makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      const r = JSON.parse(ctx.resultJson!);
      expect(r.outcome).toBe('aborted');
    });

    it('includes rejectionReason in summary', () => {
      const result = weaverAbortTask(makeCtx({ rejectionReason: 'budget exceeded' }));
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      const r = JSON.parse(ctx.resultJson!);
      expect(r.summary).toContain('budget exceeded');
    });

    it('uses "no reason given" as fallback when rejectionReason is absent', () => {
      const result = weaverAbortTask(makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      const r = JSON.parse(ctx.resultJson!);
      expect(r.summary).toContain('no reason given');
    });

    it('summary starts with "Task aborted:"', () => {
      const result = weaverAbortTask(makeCtx({ rejectionReason: 'denied' }));
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      const r = JSON.parse(ctx.resultJson!);
      expect(r.summary).toMatch(/^Task aborted:/);
    });

    it('sets filesModified to empty array', () => {
      const result = weaverAbortTask(makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      const r = JSON.parse(ctx.resultJson!);
      expect(r.filesModified).toEqual([]);
    });

    it('sets filesCreated to empty array', () => {
      const result = weaverAbortTask(makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      const r = JSON.parse(ctx.resultJson!);
      expect(r.filesCreated).toEqual([]);
    });
  });

  describe('task instruction pass-through', () => {
    it('includes task instruction in result when present', () => {
      const taskJson = JSON.stringify({ instruction: 'add retry logic' });
      const result = weaverAbortTask(makeCtx({ taskJson }));
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      const r = JSON.parse(ctx.resultJson!);
      expect(r.instruction).toBe('add retry logic');
    });

    it('sets instruction to undefined when taskJson has no instruction', () => {
      const result = weaverAbortTask(makeCtx({ taskJson: '{}' }));
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      const r = JSON.parse(ctx.resultJson!);
      expect(r.instruction).toBeUndefined();
    });

    it('handles missing taskJson without throwing', () => {
      const input = makeCtx({ taskJson: undefined });
      expect(() => weaverAbortTask(input)).not.toThrow();
    });
  });

  describe('ctx mutations', () => {
    it('sets ctx.filesModified to "[]"', () => {
      const result = weaverAbortTask(makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(ctx.filesModified).toBe('[]');
    });

    it('sets ctx.resultJson to a valid JSON string', () => {
      const result = weaverAbortTask(makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(() => JSON.parse(ctx.resultJson!)).not.toThrow();
    });

    it('preserves env on ctx', () => {
      const result = weaverAbortTask(makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(ctx.env.projectDir).toBe('/proj');
    });

    it('returns an object with only ctx key', () => {
      const result = weaverAbortTask(makeCtx());
      expect(Object.keys(result)).toEqual(['ctx']);
    });
  });

  describe('logging', () => {
    it('logs a yellow abort message', () => {
      weaverAbortTask(makeCtx({ rejectionReason: 'risk too high' }));
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('risk too high'),
      );
    });

    it('logs exactly once', () => {
      weaverAbortTask(makeCtx());
      expect(vi.mocked(console.log)).toHaveBeenCalledTimes(1);
    });

    it('log includes "aborted"', () => {
      weaverAbortTask(makeCtx());
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('aborted'),
      );
    });
  });

  describe('return value', () => {
    it('returns a valid JSON string as ctx', () => {
      const result = weaverAbortTask(makeCtx());
      expect(() => JSON.parse(result.ctx)).not.toThrow();
    });
  });
});
