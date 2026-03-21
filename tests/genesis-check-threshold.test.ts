import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GenesisContext, GenesisImpactLevel } from '../src/bot/types.js';

import { genesisCheckThreshold } from '../src/node-types/genesis-check-threshold.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeCtx(proposalLevel: GenesisImpactLevel, threshold: GenesisImpactLevel): string {
  const context: GenesisContext = {
    env: {
      projectDir: '/project',
      config: { provider: 'auto' },
      providerType: 'anthropic',
      providerInfo: { type: 'anthropic' },
    },
    genesisConfigJson: JSON.stringify({
      intent: 'improve',
      focus: [],
      constraints: [],
      approvalThreshold: threshold,
      budgetPerCycle: 5,
      stabilize: false,
      targetWorkflow: 'workflow.ts',
      maxCyclesPerRun: 3,
    }),
    cycleId: 'cycle-1',
    proposalJson: JSON.stringify({
      operations: [{ type: 'addNode', args: { nodeId: 'n1' }, costUnits: 1, rationale: 'test' }],
      totalCost: 1,
      impactLevel: proposalLevel,
      summary: 'add a node',
      rationale: 'improve coverage',
    }),
  };
  return JSON.stringify(context);
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('genesisCheckThreshold', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  // Full 4×4 matrix: approvalRequired = proposalLevel >= thresholdLevel
  // IMPACT_ORDER: COSMETIC=0, MINOR=1, BREAKING=2, CRITICAL=3
  const cases: Array<[GenesisImpactLevel, GenesisImpactLevel, boolean]> = [
    // COSMETIC proposal
    ['COSMETIC', 'COSMETIC',  true],
    ['COSMETIC', 'MINOR',     false],
    ['COSMETIC', 'BREAKING',  false],
    ['COSMETIC', 'CRITICAL',  false],
    // MINOR proposal
    ['MINOR',    'COSMETIC',  true],
    ['MINOR',    'MINOR',     true],
    ['MINOR',    'BREAKING',  false],
    ['MINOR',    'CRITICAL',  false],
    // BREAKING proposal
    ['BREAKING', 'COSMETIC',  true],
    ['BREAKING', 'MINOR',     true],
    ['BREAKING', 'BREAKING',  true],
    ['BREAKING', 'CRITICAL',  false],
    // CRITICAL proposal
    ['CRITICAL', 'COSMETIC',  true],
    ['CRITICAL', 'MINOR',     true],
    ['CRITICAL', 'BREAKING',  true],
    ['CRITICAL', 'CRITICAL',  true],
  ];

  it.each(cases)(
    'proposal=%s threshold=%s → approvalRequired=%s',
    (proposalLevel, threshold, expected) => {
      const result = genesisCheckThreshold(makeCtx(proposalLevel, threshold));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.approvalRequired).toBe(expected);
    },
  );

  it('sets approvalRequired on the context and preserves other fields', () => {
    const result = genesisCheckThreshold(makeCtx('BREAKING', 'MINOR'));
    const ctx = JSON.parse(result.ctx) as GenesisContext;

    expect(ctx.approvalRequired).toBe(true);
    // Other context fields preserved
    expect(ctx.cycleId).toBe('cycle-1');
    expect(ctx.env.projectDir).toBe('/project');
  });

  it('returns ctx with approvalRequired=false when proposal is below threshold', () => {
    const result = genesisCheckThreshold(makeCtx('MINOR', 'CRITICAL'));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(ctx.approvalRequired).toBe(false);
  });

  it('approvalRequired=true when proposal equals threshold (BREAKING vs BREAKING)', () => {
    const result = genesisCheckThreshold(makeCtx('BREAKING', 'BREAKING'));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(ctx.approvalRequired).toBe(true);
  });
});
