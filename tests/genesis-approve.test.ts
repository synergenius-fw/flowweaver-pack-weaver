import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WeaverEnv, GenesisContext, GenesisProposal } from '../src/bot/types.js';
import { genesisApprove } from '../src/node-types/genesis-approve.js';

const BASE_ENV: WeaverEnv = {
  projectDir: '/test',
  config: { provider: 'auto' as const },
  providerType: 'anthropic' as const,
  providerInfo: { type: 'anthropic' as const, apiKey: 'key' },
};

const BASE_PROPOSAL: GenesisProposal = {
  operations: [{ type: 'addNode', args: { nodeId: 'n1', nodeType: 'A' }, costUnits: 1, rationale: 'test' }],
  totalCost: 1,
  impactLevel: 'MINOR',
  summary: 'Test proposal',
  rationale: 'Testing',
};

function makeCtx(overrides: Partial<GenesisContext> = {}): string {
  const ctx: GenesisContext = {
    env: BASE_ENV,
    genesisConfigJson: JSON.stringify({ approvalThreshold: 'MINOR' }),
    cycleId: 'cycle-001',
    proposalJson: JSON.stringify(BASE_PROPOSAL),
    workflowDiffJson: JSON.stringify({ diff: '+ added line\n- removed line' }),
    approvalRequired: false,
    ...overrides,
  };
  return JSON.stringify(ctx);
}

describe('genesisApprove', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('dry-run (execute=false)', () => {
    it('returns onSuccess=true', async () => {
      const result = await genesisApprove(false, makeCtx());
      expect(result.onSuccess).toBe(true);
      expect(result.onFailure).toBe(false);
    });

    it('sets approved=true in ctx', async () => {
      const result = await genesisApprove(false, makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.approved).toBe(true);
    });

    it('does not require proposalJson or workflowDiffJson', async () => {
      const ctx = makeCtx({ proposalJson: undefined, workflowDiffJson: undefined });
      const result = await genesisApprove(false, ctx);
      expect(result.onSuccess).toBe(true);
    });
  });

  describe('approvalRequired=false (below threshold)', () => {
    it('auto-approves and returns onSuccess=true', async () => {
      const result = await genesisApprove(true, makeCtx({ approvalRequired: false }));
      expect(result.onSuccess).toBe(true);
      expect(result.onFailure).toBe(false);
    });

    it('sets approved=true', async () => {
      const result = await genesisApprove(true, makeCtx({ approvalRequired: false }));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.approved).toBe(true);
    });
  });

  describe('approvalRequired=true, approval mode=auto (default)', () => {
    it('auto-approves when config.approval is undefined', async () => {
      const env = { ...BASE_ENV, config: { provider: 'auto' as const } };
      const ctx = makeCtx({ env, approvalRequired: true });
      const result = await genesisApprove(true, ctx);
      const outCtx = JSON.parse(result.ctx) as GenesisContext;
      expect(outCtx.approved).toBe(true);
      expect(result.onSuccess).toBe(true);
    });

    it('auto-approves when config.approval is "auto"', async () => {
      const env = { ...BASE_ENV, config: { provider: 'auto' as const, approval: 'auto' as any } };
      const ctx = makeCtx({ env, approvalRequired: true });
      const result = await genesisApprove(true, ctx);
      const outCtx = JSON.parse(result.ctx) as GenesisContext;
      expect(outCtx.approved).toBe(true);
    });

    it('auto-approves when config.approval.mode is "auto"', async () => {
      const env = { ...BASE_ENV, config: { provider: 'auto' as const, approval: { mode: 'auto' } as any } };
      const ctx = makeCtx({ env, approvalRequired: true });
      const result = await genesisApprove(true, ctx);
      const outCtx = JSON.parse(result.ctx) as GenesisContext;
      expect(outCtx.approved).toBe(true);
    });
  });

  describe('approvalRequired=true, non-auto approval mode', () => {
    it('rejects and sets approved=false', async () => {
      const env = { ...BASE_ENV, config: { provider: 'auto' as const, approval: 'manual' as any } };
      const ctx = makeCtx({ env, approvalRequired: true });
      const result = await genesisApprove(true, ctx);
      const outCtx = JSON.parse(result.ctx) as GenesisContext;
      expect(outCtx.approved).toBe(false);
    });

    it('still returns onSuccess=true (rejection is a valid outcome)', async () => {
      const env = { ...BASE_ENV, config: { provider: 'auto' as const, approval: 'manual' as any } };
      const ctx = makeCtx({ env, approvalRequired: true });
      const result = await genesisApprove(true, ctx);
      expect(result.onSuccess).toBe(true);
      expect(result.onFailure).toBe(false);
    });

    it('rejects when config.approval.mode is "manual"', async () => {
      const env = { ...BASE_ENV, config: { provider: 'auto' as const, approval: { mode: 'manual' } as any } };
      const ctx = makeCtx({ env, approvalRequired: true });
      const result = await genesisApprove(true, ctx);
      const outCtx = JSON.parse(result.ctx) as GenesisContext;
      expect(outCtx.approved).toBe(false);
    });
  });

  describe('proposal display on approvalRequired=true', () => {
    it('logs proposal summary and diff when approval is required', async () => {
      const env = { ...BASE_ENV, config: { provider: 'auto' as const } };
      const ctx = makeCtx({ env, approvalRequired: true });
      await genesisApprove(true, ctx);
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('Test proposal'),
      );
    });

    it('does not log proposal display when approvalRequired=false', async () => {
      const result = await genesisApprove(true, makeCtx({ approvalRequired: false }));
      const logCalls = vi.mocked(console.log).mock.calls.flat().join(' ');
      expect(logCalls).not.toContain('Genesis Proposal');
      expect(result.onSuccess).toBe(true);
    });
  });
});
