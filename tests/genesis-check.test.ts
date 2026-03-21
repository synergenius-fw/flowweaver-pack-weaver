import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GenesisContext, GenesisConfig, GenesisProposal } from '../src/bot/types.js';

// ── Hoist mock refs so they're available inside vi.mock factory ───────────────

const { mockGetRecentOutcomes, MockGenesisStore } = vi.hoisted(() => {
  const mockGetRecentOutcomes = vi.fn<() => string[]>().mockReturnValue([]);
  // Must be a real constructor function so `new GenesisStore(...)` works
  const MockGenesisStore = vi.fn(function (this: { getRecentOutcomes: typeof mockGetRecentOutcomes }) {
    this.getRecentOutcomes = mockGetRecentOutcomes;
  });
  return { mockGetRecentOutcomes, MockGenesisStore };
});

vi.mock('../src/bot/genesis-store.js', () => ({
  GenesisStore: MockGenesisStore,
}));

import { genesisCheckStabilize } from '../src/node-types/genesis-check-stabilize.js';
import { genesisCheckThreshold } from '../src/node-types/genesis-check-threshold.js';

// ── helpers ───────────────────────────────────────────────────────────────────

const BASE_ENV = {
  projectDir: '/test',
  config: { provider: 'auto' as const },
  providerType: 'anthropic',
  providerInfo: { type: 'anthropic' as const, apiKey: 'key' },
};

function makeConfig(overrides: Partial<GenesisConfig> = {}): GenesisConfig {
  return {
    intent: 'test',
    focus: [],
    constraints: [],
    approvalThreshold: 'MINOR',
    budgetPerCycle: 3,
    stabilize: false,
    targetWorkflow: '',
    maxCyclesPerRun: 10,
    ...overrides,
  };
}

function makeCtx(config: GenesisConfig, extra: Partial<GenesisContext> = {}): string {
  const ctx: GenesisContext = {
    env: BASE_ENV,
    genesisConfigJson: JSON.stringify(config),
    cycleId: 'abc12345',
    ...extra,
  };
  return JSON.stringify(ctx);
}

function makeProposal(impactLevel: GenesisProposal['impactLevel']): GenesisProposal {
  return {
    operations: [],
    totalCost: 1,
    impactLevel,
    summary: 'test proposal',
    rationale: 'test',
  };
}

// ── genesisCheckStabilize ─────────────────────────────────────────────────────

describe('genesisCheckStabilize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGetRecentOutcomes.mockReturnValue([]);
  });

  it('sets stabilized=true when config.stabilize flag is true', () => {
    const result = genesisCheckStabilize(makeCtx(makeConfig({ stabilize: true })));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(ctx.stabilized).toBe(true);
  });

  it('does not call getRecentOutcomes when config.stabilize is true', () => {
    genesisCheckStabilize(makeCtx(makeConfig({ stabilize: true })));
    expect(mockGetRecentOutcomes).not.toHaveBeenCalled();
  });

  it('sets stabilized=true when last 3 outcomes are all rolled-back', () => {
    mockGetRecentOutcomes.mockReturnValue(['rolled-back', 'rolled-back', 'rolled-back']);
    const result = genesisCheckStabilize(makeCtx(makeConfig()));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(ctx.stabilized).toBe(true);
  });

  it('sets stabilized=true when last 3 outcomes are all rejected', () => {
    mockGetRecentOutcomes.mockReturnValue(['rejected', 'rejected', 'rejected']);
    const result = genesisCheckStabilize(makeCtx(makeConfig()));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(ctx.stabilized).toBe(true);
  });

  it('sets stabilized=true for a mix of rolled-back and rejected', () => {
    mockGetRecentOutcomes.mockReturnValue(['rolled-back', 'rejected', 'rolled-back']);
    const result = genesisCheckStabilize(makeCtx(makeConfig()));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(ctx.stabilized).toBe(true);
  });

  it('sets stabilized=false when fewer than 3 recent outcomes', () => {
    mockGetRecentOutcomes.mockReturnValue(['rolled-back', 'rolled-back']);
    const result = genesisCheckStabilize(makeCtx(makeConfig()));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(ctx.stabilized).toBe(false);
  });

  it('sets stabilized=false when recent outcomes include a non-rollback', () => {
    mockGetRecentOutcomes.mockReturnValue(['rolled-back', 'applied', 'rolled-back']);
    const result = genesisCheckStabilize(makeCtx(makeConfig()));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(ctx.stabilized).toBe(false);
  });

  it('sets stabilized=false when queue is empty', () => {
    mockGetRecentOutcomes.mockReturnValue([]);
    const result = genesisCheckStabilize(makeCtx(makeConfig()));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(ctx.stabilized).toBe(false);
  });

  it('passes projectDir to GenesisStore constructor', () => {
    genesisCheckStabilize(makeCtx(makeConfig()));
    expect(MockGenesisStore).toHaveBeenCalledWith('/test');
  });
});

// ── genesisCheckThreshold ─────────────────────────────────────────────────────

describe('genesisCheckThreshold', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  function makeCtxWithProposal(
    impactLevel: GenesisProposal['impactLevel'],
    threshold: GenesisConfig['approvalThreshold'],
  ): string {
    return makeCtx(makeConfig({ approvalThreshold: threshold }), {
      proposalJson: JSON.stringify(makeProposal(impactLevel)),
    });
  }

  it('sets approvalRequired=false when impact MINOR is below threshold BREAKING', () => {
    const result = genesisCheckThreshold(makeCtxWithProposal('MINOR', 'BREAKING'));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(ctx.approvalRequired).toBe(false);
  });

  it('sets approvalRequired=false when impact COSMETIC is below threshold MINOR', () => {
    const result = genesisCheckThreshold(makeCtxWithProposal('COSMETIC', 'MINOR'));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(ctx.approvalRequired).toBe(false);
  });

  it('sets approvalRequired=true when impact MINOR equals threshold MINOR', () => {
    const result = genesisCheckThreshold(makeCtxWithProposal('MINOR', 'MINOR'));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(ctx.approvalRequired).toBe(true);
  });

  it('sets approvalRequired=true when impact BREAKING exceeds threshold MINOR', () => {
    const result = genesisCheckThreshold(makeCtxWithProposal('BREAKING', 'MINOR'));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(ctx.approvalRequired).toBe(true);
  });

  it('sets approvalRequired=true when impact CRITICAL exceeds threshold MINOR', () => {
    const result = genesisCheckThreshold(makeCtxWithProposal('CRITICAL', 'MINOR'));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(ctx.approvalRequired).toBe(true);
  });

  it('sets approvalRequired=true when impact CRITICAL equals threshold CRITICAL', () => {
    const result = genesisCheckThreshold(makeCtxWithProposal('CRITICAL', 'CRITICAL'));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(ctx.approvalRequired).toBe(true);
  });

  it('sets approvalRequired=true when impact COSMETIC equals threshold COSMETIC', () => {
    const result = genesisCheckThreshold(makeCtxWithProposal('COSMETIC', 'COSMETIC'));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(ctx.approvalRequired).toBe(true);
  });

  it('preserves the rest of the context when setting approvalRequired', () => {
    const result = genesisCheckThreshold(makeCtxWithProposal('BREAKING', 'MINOR'));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(ctx.env.projectDir).toBe('/test');
    expect(ctx.cycleId).toBe('abc12345');
  });
});
