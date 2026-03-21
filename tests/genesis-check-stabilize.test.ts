import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GenesisContext, WeaverEnv } from '../src/bot/types.js';

const { mockGetRecentOutcomes } = vi.hoisted(() => ({
  mockGetRecentOutcomes: vi.fn<(n: number) => string[]>(),
}));

vi.mock('../src/bot/genesis-store.js', () => ({
  GenesisStore: class {
    getRecentOutcomes(n: number) {
      return mockGetRecentOutcomes(n);
    }
  },
}));

import { genesisCheckStabilize } from '../src/node-types/genesis-check-stabilize.js';

const BASE_ENV: WeaverEnv = {
  projectDir: '/proj',
  config: { provider: 'auto' as const },
  providerType: 'anthropic' as const,
  providerInfo: { type: 'anthropic' as const, apiKey: 'key' },
};

function makeCtx(stabilizeFlag: boolean, overrides: Partial<GenesisContext> = {}): string {
  const ctx: GenesisContext = {
    env: BASE_ENV,
    genesisConfigJson: JSON.stringify({
      intent: 'improve',
      focus: [],
      constraints: [],
      approvalThreshold: 'MINOR',
      budgetPerCycle: 5,
      stabilize: stabilizeFlag,
      targetWorkflow: 'workflow.ts',
      maxCyclesPerRun: 3,
    }),
    cycleId: 'cycle-1',
    ...overrides,
  };
  return JSON.stringify(ctx);
}

describe('genesisCheckStabilize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGetRecentOutcomes.mockReturnValue([]);
  });

  describe('config.stabilize flag', () => {
    it('sets stabilized=true when config.stabilize is true', () => {
      const result = genesisCheckStabilize(makeCtx(true));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.stabilized).toBe(true);
    });

    it('does not call GenesisStore when config.stabilize is true', () => {
      genesisCheckStabilize(makeCtx(true));
      expect(mockGetRecentOutcomes).not.toHaveBeenCalled();
    });

    it('logs stabilize mode enabled message when flag is set', () => {
      genesisCheckStabilize(makeCtx(true));
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('Stabilize mode'),
      );
    });

    it('sets stabilized=false when config.stabilize is false and no bad history', () => {
      mockGetRecentOutcomes.mockReturnValue(['applied', 'applied', 'applied']);

      const result = genesisCheckStabilize(makeCtx(false));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.stabilized).toBe(false);
    });
  });

  describe('history-based stabilization', () => {
    it('sets stabilized=true when last 3 outcomes are all rolled-back', () => {
      mockGetRecentOutcomes.mockReturnValue(['rolled-back', 'rolled-back', 'rolled-back']);

      const result = genesisCheckStabilize(makeCtx(false));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.stabilized).toBe(true);
    });

    it('sets stabilized=true when last 3 outcomes are all rejected', () => {
      mockGetRecentOutcomes.mockReturnValue(['rejected', 'rejected', 'rejected']);

      const result = genesisCheckStabilize(makeCtx(false));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.stabilized).toBe(true);
    });

    it('sets stabilized=true when outcomes are mixed rolled-back and rejected', () => {
      mockGetRecentOutcomes.mockReturnValue(['rolled-back', 'rejected', 'rolled-back']);

      const result = genesisCheckStabilize(makeCtx(false));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.stabilized).toBe(true);
    });

    it('sets stabilized=false when one of the 3 outcomes is applied', () => {
      mockGetRecentOutcomes.mockReturnValue(['rolled-back', 'applied', 'rolled-back']);

      const result = genesisCheckStabilize(makeCtx(false));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.stabilized).toBe(false);
    });

    it('sets stabilized=false when only 2 outcomes exist', () => {
      mockGetRecentOutcomes.mockReturnValue(['rolled-back', 'rolled-back']);

      const result = genesisCheckStabilize(makeCtx(false));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.stabilized).toBe(false);
    });

    it('sets stabilized=false when no outcomes exist', () => {
      mockGetRecentOutcomes.mockReturnValue([]);

      const result = genesisCheckStabilize(makeCtx(false));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.stabilized).toBe(false);
    });

    it('sets stabilized=false when one outcome is error', () => {
      mockGetRecentOutcomes.mockReturnValue(['error', 'rolled-back', 'rolled-back']);

      const result = genesisCheckStabilize(makeCtx(false));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.stabilized).toBe(false);
    });

    it('logs stabilization message when history triggers stabilize', () => {
      mockGetRecentOutcomes.mockReturnValue(['rolled-back', 'rejected', 'rolled-back']);

      genesisCheckStabilize(makeCtx(false));
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('Stabilize mode'),
      );
    });

    it('does not log when stabilized=false', () => {
      mockGetRecentOutcomes.mockReturnValue(['applied', 'applied', 'applied']);

      genesisCheckStabilize(makeCtx(false));
      expect(vi.mocked(console.log)).not.toHaveBeenCalled();
    });

    it('calls getRecentOutcomes with 3', () => {
      mockGetRecentOutcomes.mockReturnValue([]);

      genesisCheckStabilize(makeCtx(false));
      expect(mockGetRecentOutcomes).toHaveBeenCalledWith(3);
    });
  });

  describe('ctx pass-through', () => {
    it('returns a valid JSON string as ctx', () => {
      const result = genesisCheckStabilize(makeCtx(false));
      expect(() => JSON.parse(result.ctx)).not.toThrow();
    });

    it('preserves env in output ctx', () => {
      const result = genesisCheckStabilize(makeCtx(false));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.env.projectDir).toBe('/proj');
    });

    it('preserves cycleId in output ctx', () => {
      const result = genesisCheckStabilize(makeCtx(false, { cycleId: 'cycle-42' }));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.cycleId).toBe('cycle-42');
    });

    it('returns object with only ctx key', () => {
      const result = genesisCheckStabilize(makeCtx(false));
      expect(Object.keys(result)).toEqual(['ctx']);
    });
  });
});
