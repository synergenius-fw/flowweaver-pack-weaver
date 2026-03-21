import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WeaverEnv, GenesisConfig, GenesisContext } from '../src/bot/types.js';

vi.mock('../src/bot/ai-client.js', () => ({
  callAI: vi.fn(),
  parseJsonResponse: vi.fn(),
}));

const { MockGenesisStore } = vi.hoisted(() => {
  const MockGenesisStore = vi.fn(function (this: { loadSnapshot: ReturnType<typeof vi.fn> }) {
    this.loadSnapshot = vi.fn().mockReturnValue(null);
  }) as any;
  return { MockGenesisStore };
});

vi.mock('../src/bot/genesis-store.js', () => ({
  GenesisStore: MockGenesisStore,
}));

vi.mock('../src/bot/genesis-prompt-context.js', () => ({
  getGenesisSystemPrompt: vi.fn().mockResolvedValue('system prompt'),
  getOperationExamples: vi.fn().mockReturnValue('examples'),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, writeFileSync: vi.fn() };
});

import { callAI, parseJsonResponse } from '../src/bot/ai-client.js';
import { genesisApplyRetry } from '../src/node-types/genesis-apply-retry.js';

const mockCallAI = vi.mocked(callAI);
const mockParseJsonResponse = vi.mocked(parseJsonResponse);

const BASE_ENV: WeaverEnv = {
  projectDir: '/test',
  config: { provider: 'auto' as const },
  providerType: 'anthropic' as const,
  providerInfo: { type: 'anthropic' as const, apiKey: 'key' },
};

const BASE_CONFIG: GenesisConfig = {
  intent: 'Improve workflow',
  focus: [],
  constraints: [],
  approvalThreshold: 'MINOR',
  budgetPerCycle: 3,
  stabilize: false,
  targetWorkflow: 'src/workflows/my-workflow.ts',
  maxCyclesPerRun: 10,
};

function makeCtx(overrides: Partial<GenesisContext> = {}): string {
  const ctx: GenesisContext = {
    env: BASE_ENV,
    genesisConfigJson: JSON.stringify(BASE_CONFIG),
    cycleId: 'cycle-001',
    proposalJson: JSON.stringify({ operations: [], summary: 'test' }),
    snapshotPath: '/test/.genesis/snapshots/snap-001.ts',
    ...overrides,
  };
  return JSON.stringify(ctx);
}

function makeAttempt(outcomes: Array<{ success: boolean; applyResultJson?: string; error?: string }>) {
  let callCount = 0;
  return vi.fn().mockImplementation(async (_start: boolean, attemptCtxJson: string) => {
    const outcome = outcomes[callCount] ?? outcomes[outcomes.length - 1];
    callCount++;
    const childCtx = JSON.parse(attemptCtxJson) as GenesisContext;
    childCtx.applyResultJson = outcome.applyResultJson ?? JSON.stringify({ applied: 1, failed: 0, errors: [] });
    childCtx.error = outcome.error ?? '';
    return {
      success: outcome.success,
      failure: !outcome.success,
      attemptCtx: JSON.stringify(childCtx),
    };
  });
}

describe('genesisApplyRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('dry-run (execute=false)', () => {
    it('returns onSuccess=true without calling attempt', async () => {
      const attempt = makeAttempt([{ success: true }]);
      const result = await genesisApplyRetry(false, makeCtx(), attempt);
      expect(result.onSuccess).toBe(true);
      expect(result.onFailure).toBe(false);
      expect(attempt).not.toHaveBeenCalled();
    });

    it('applyResultJson has applied=0, failed=0, errors=[]', async () => {
      const attempt = makeAttempt([{ success: true }]);
      const result = await genesisApplyRetry(false, makeCtx(), attempt);
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      const r = JSON.parse(ctx.applyResultJson!);
      expect(r.applied).toBe(0);
      expect(r.failed).toBe(0);
      expect(r.errors).toEqual([]);
    });

    it('ctx.error is empty string', async () => {
      const attempt = makeAttempt([{ success: true }]);
      const result = await genesisApplyRetry(false, makeCtx(), attempt);
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.error).toBe('');
    });
  });

  describe('first attempt succeeds', () => {
    it('returns onSuccess=true', async () => {
      const attempt = makeAttempt([{ success: true }]);
      const result = await genesisApplyRetry(true, makeCtx(), attempt);
      expect(result.onSuccess).toBe(true);
      expect(result.onFailure).toBe(false);
    });

    it('attempt is called exactly once', async () => {
      const attempt = makeAttempt([{ success: true }]);
      await genesisApplyRetry(true, makeCtx(), attempt);
      expect(attempt).toHaveBeenCalledOnce();
    });

    it('ctx has applyResultJson from child', async () => {
      const childResult = JSON.stringify({ applied: 3, failed: 0, errors: [] });
      const attempt = makeAttempt([{ success: true, applyResultJson: childResult }]);
      const result = await genesisApplyRetry(true, makeCtx(), attempt);
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.applyResultJson).toBe(childResult);
    });

    it('ctx.error is empty string on success', async () => {
      const attempt = makeAttempt([{ success: true }]);
      const result = await genesisApplyRetry(true, makeCtx(), attempt);
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.error).toBe('');
    });
  });

  describe('retry on failure — second attempt succeeds', () => {
    it('returns onSuccess=true', async () => {
      const attempt = makeAttempt([
        { success: false, error: 'compile error' },
        { success: true },
      ]);
      mockCallAI.mockResolvedValue('{}');
      mockParseJsonResponse.mockReturnValue({ operations: [], summary: 'revised' });

      const result = await genesisApplyRetry(true, makeCtx(), attempt);
      expect(result.onSuccess).toBe(true);
      expect(result.onFailure).toBe(false);
    });

    it('attempt is called twice', async () => {
      const attempt = makeAttempt([
        { success: false, error: 'error' },
        { success: true },
      ]);
      mockCallAI.mockResolvedValue('{}');
      mockParseJsonResponse.mockReturnValue({ operations: [], summary: 'revised' });

      await genesisApplyRetry(true, makeCtx(), attempt);
      expect(attempt).toHaveBeenCalledTimes(2);
    });

    it('calls callAI once to revise proposal between attempts', async () => {
      const attempt = makeAttempt([
        { success: false, error: 'oops' },
        { success: true },
      ]);
      mockCallAI.mockResolvedValue('{}');
      mockParseJsonResponse.mockReturnValue({ operations: [], summary: 'ok' });

      await genesisApplyRetry(true, makeCtx(), attempt);
      expect(mockCallAI).toHaveBeenCalledOnce();
    });
  });

  describe('all attempts fail', () => {
    it('returns onFailure=true after 3 attempts', async () => {
      const attempt = makeAttempt([{ success: false, error: 'fail' }]);
      mockCallAI.mockResolvedValue('{}');
      mockParseJsonResponse.mockReturnValue({ operations: [], summary: 'revised' });

      const result = await genesisApplyRetry(true, makeCtx(), attempt);
      expect(result.onSuccess).toBe(false);
      expect(result.onFailure).toBe(true);
    });

    it('attempt is called 3 times', async () => {
      const attempt = makeAttempt([{ success: false, error: 'fail' }]);
      mockCallAI.mockResolvedValue('{}');
      mockParseJsonResponse.mockReturnValue({ operations: [], summary: 'revised' });

      await genesisApplyRetry(true, makeCtx(), attempt);
      expect(attempt).toHaveBeenCalledTimes(3);
    });

    it('ctx.error contains attempt count', async () => {
      const attempt = makeAttempt([{ success: false, error: 'compile error' }]);
      mockCallAI.mockResolvedValue('{}');
      mockParseJsonResponse.mockReturnValue({ operations: [], summary: 'revised' });

      const result = await genesisApplyRetry(true, makeCtx(), attempt);
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.error).toContain('3');
    });
  });

  describe('AI revision fails during retry', () => {
    it('breaks early and returns onFailure=true', async () => {
      const attempt = makeAttempt([{ success: false, error: 'compile error' }]);
      mockCallAI.mockRejectedValue(new Error('provider timeout'));

      const result = await genesisApplyRetry(true, makeCtx(), attempt);
      expect(result.onSuccess).toBe(false);
      expect(result.onFailure).toBe(true);
    });

    it('attempt is not called a third time when revision fails on second attempt', async () => {
      // attempt 1 fails → AI revision fails → break → only 1 attempt total
      const attempt = makeAttempt([{ success: false, error: 'error' }]);
      mockCallAI.mockRejectedValue(new Error('ai down'));

      await genesisApplyRetry(true, makeCtx(), attempt);
      // Called attempt once, then AI failed, so loop breaks — attempt only once
      expect(attempt).toHaveBeenCalledTimes(1);
    });
  });
});
