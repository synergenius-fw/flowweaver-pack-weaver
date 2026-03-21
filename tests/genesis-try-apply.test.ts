import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GenesisConfig, GenesisContext, GenesisProposal } from '../src/bot/types.js';

const { mockExecFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFileSync: mockExecFileSync };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, writeFileSync: vi.fn() };
});

const { MockGenesisStore } = vi.hoisted(() => {
  const MockGenesisStore = vi.fn(function (this: { loadSnapshot: ReturnType<typeof vi.fn> }) {
    this.loadSnapshot = vi.fn().mockReturnValue('// restored content');
  }) as any;
  return { MockGenesisStore };
});

vi.mock('../src/bot/genesis-store.js', () => ({
  GenesisStore: MockGenesisStore,
}));

import * as fs from 'node:fs';
import { genesisTryApply } from '../src/node-types/genesis-try-apply.js';

const mockWriteFileSync = vi.mocked(fs.writeFileSync);

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

const ADD_NODE_OP = { type: 'addNode' as const, args: { nodeId: 'n1', nodeType: 'MyNode' }, costUnits: 1, rationale: 'Add node' };
const ADD_CONN_OP = { type: 'addConnection' as const, args: { from: 'Start.execute', to: 'n1.execute' }, costUnits: 1, rationale: 'Wire it' };
const REMOVE_NODE_OP = { type: 'removeNode' as const, args: { nodeId: 'oldNode' }, costUnits: 1, rationale: 'Remove old' };
const REMOVE_CONN_OP = { type: 'removeConnection' as const, args: { from: 'a.out', to: 'b.in' }, costUnits: 1, rationale: 'Remove wire' };
const IMPLEMENT_NODE_OP = { type: 'implementNode' as const, args: { nodeId: 'n1' }, costUnits: 2, rationale: 'Implement' };

function makeProposal(ops = [ADD_NODE_OP]): GenesisProposal {
  return {
    operations: ops,
    totalCost: ops.reduce((s, o) => s + o.costUnits, 0),
    impactLevel: 'MINOR',
    summary: 'Test proposal',
    rationale: 'Testing',
  };
}

function makeCtx(overrides: Partial<GenesisContext> = {}): string {
  const ctx: GenesisContext = {
    env: {
      projectDir: '/proj',
      config: { provider: 'auto' as const },
      providerType: 'anthropic' as const,
      providerInfo: { type: 'anthropic' as const, apiKey: 'key' },
    },
    genesisConfigJson: JSON.stringify(BASE_CONFIG),
    cycleId: 'cycle-001',
    proposalJson: JSON.stringify(makeProposal()),
    snapshotPath: '/proj/.genesis/snapshots/snap-001.ts',
    ...overrides,
  };
  return JSON.stringify(ctx);
}

describe('genesisTryApply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    MockGenesisStore.mockImplementation(function (this: any) {
      this.loadSnapshot = vi.fn().mockReturnValue('// restored');
    });
  });

  describe('dry-run (execute=false)', () => {
    it('returns onSuccess=true', async () => {
      const result = await genesisTryApply(false, makeCtx());
      expect(result.onSuccess).toBe(true);
      expect(result.onFailure).toBe(false);
    });

    it('does not call execFileSync', async () => {
      await genesisTryApply(false, makeCtx());
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('sets applyResultJson with applied=0, failed=0, errors=[]', async () => {
      const result = await genesisTryApply(false, makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      const r = JSON.parse(ctx.applyResultJson!);
      expect(r.applied).toBe(0);
      expect(r.failed).toBe(0);
      expect(r.errors).toEqual([]);
    });

    it('sets ctx.error to empty string', async () => {
      const result = await genesisTryApply(false, makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.error).toBe('');
    });
  });

  describe('all operations succeed + compile passes', () => {
    it('returns onSuccess=true', async () => {
      // modify succeeds, validate succeeds, compile succeeds
      mockExecFileSync.mockReturnValue('' as any);

      const result = await genesisTryApply(true, makeCtx());
      expect(result.onSuccess).toBe(true);
      expect(result.onFailure).toBe(false);
    });

    it('applies each operation via flow-weaver modify', async () => {
      mockExecFileSync.mockReturnValue('' as any);

      await genesisTryApply(true, makeCtx({ proposalJson: JSON.stringify(makeProposal([ADD_NODE_OP, ADD_CONN_OP])) }));

      const modifyCalls = mockExecFileSync.mock.calls.filter(
        (c) => c[0] === 'flow-weaver' && Array.isArray(c[1]) && (c[1] as string[]).includes('modify'),
      );
      expect(modifyCalls).toHaveLength(2);
    });

    it('calls validate after applying operations', async () => {
      mockExecFileSync.mockReturnValue('' as any);

      await genesisTryApply(true, makeCtx());

      const validateCall = mockExecFileSync.mock.calls.find(
        (c) => c[0] === 'flow-weaver' && Array.isArray(c[1]) && (c[1] as string[])[0] === 'validate',
      );
      expect(validateCall).toBeDefined();
    });

    it('calls compile after validate', async () => {
      mockExecFileSync.mockReturnValue('' as any);

      await genesisTryApply(true, makeCtx());

      const compileCalls = mockExecFileSync.mock.calls.filter(
        (c) => c[0] === 'flow-weaver' && Array.isArray(c[1]) && (c[1] as string[])[0] === 'compile',
      );
      expect(compileCalls).toHaveLength(1);
    });

    it('sets applied count in applyResultJson', async () => {
      mockExecFileSync.mockReturnValue('' as any);

      const result = await genesisTryApply(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      const r = JSON.parse(ctx.applyResultJson!);
      expect(r.applied).toBe(1);
      expect(r.failed).toBe(0);
    });

    it('sets ctx.error to empty string on success', async () => {
      mockExecFileSync.mockReturnValue('' as any);

      const result = await genesisTryApply(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.error).toBe('');
    });
  });

  describe('operation CLI call fails', () => {
    it('counts failed operations', async () => {
      mockExecFileSync
        .mockImplementationOnce(() => { throw new Error('modify failed'); }) // operation fails
        .mockReturnValue('' as any); // validate + compile succeed

      // Need a second op so applied > 0 for compile to run
      const proposal = makeProposal([ADD_NODE_OP, ADD_CONN_OP]);
      const result = await genesisTryApply(true, makeCtx({ proposalJson: JSON.stringify(proposal) }));

      const ctx = JSON.parse(result.ctx) as GenesisContext;
      const r = JSON.parse(ctx.applyResultJson!);
      expect(r.failed).toBe(1);
      expect(r.applied).toBe(1);
    });

    it('records error message in applyResultJson.errors', async () => {
      const proposal = makeProposal([ADD_NODE_OP, ADD_CONN_OP]);
      mockExecFileSync
        .mockImplementationOnce(() => { throw new Error('op failed'); })
        .mockReturnValue('' as any);

      const result = await genesisTryApply(true, makeCtx({ proposalJson: JSON.stringify(proposal) }));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      const r = JSON.parse(ctx.applyResultJson!);
      expect(r.errors[0]).toContain('op failed');
    });
  });

  describe('all operations fail (applied=0)', () => {
    it('returns onFailure=true without attempting compile', async () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('modify failed'); });

      const result = await genesisTryApply(true, makeCtx());
      expect(result.onSuccess).toBe(false);
      expect(result.onFailure).toBe(true);
    });

    it('does not call validate or compile when applied=0', async () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('modify failed'); });

      await genesisTryApply(true, makeCtx());

      const validateOrCompile = mockExecFileSync.mock.calls.filter(
        (c) => c[0] === 'flow-weaver' && ['validate', 'compile'].includes((c[1] as string[])[0]),
      );
      expect(validateOrCompile).toHaveLength(0);
    });
  });

  describe('compile/validate fails → rollback', () => {
    it('returns onFailure=true', async () => {
      mockExecFileSync
        .mockReturnValueOnce('' as any)                            // operation succeeds
        .mockImplementationOnce(() => { throw new Error('validation error'); }); // validate fails

      const result = await genesisTryApply(true, makeCtx());
      expect(result.onSuccess).toBe(false);
      expect(result.onFailure).toBe(true);
    });

    it('sets ctx.error to compile error message', async () => {
      mockExecFileSync
        .mockReturnValueOnce('' as any)
        .mockImplementationOnce(() => { throw new Error('type mismatch'); });

      const result = await genesisTryApply(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.error).toContain('type mismatch');
    });

    it('restores snapshot via writeFileSync', async () => {
      mockExecFileSync
        .mockReturnValueOnce('' as any)
        .mockImplementationOnce(() => { throw new Error('compile failed'); });

      await genesisTryApply(true, makeCtx());
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('my-workflow.ts'),
        '// restored',
        'utf-8',
      );
    });

    it('does not restore when snapshot is null', async () => {
      MockGenesisStore.mockImplementation(function (this: any) {
        this.loadSnapshot = vi.fn().mockReturnValue(null);
      });
      mockExecFileSync
        .mockReturnValueOnce('' as any)
        .mockImplementationOnce(() => { throw new Error('compile failed'); });

      await genesisTryApply(true, makeCtx());
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it('logs Restored from snapshot message', async () => {
      mockExecFileSync
        .mockReturnValueOnce('' as any)
        .mockImplementationOnce(() => { throw new Error('compile failed'); });

      await genesisTryApply(true, makeCtx());
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('Restored from snapshot'),
      );
    });
  });

  describe('pre-validation of operation args', () => {
    it('rejects addConnection with missing from/to', async () => {
      const badOp = { type: 'addConnection' as const, args: {}, costUnits: 1, rationale: 'bad' };
      const proposal = makeProposal([badOp]);
      mockExecFileSync.mockReturnValue('' as any); // compile would pass if we got there

      const result = await genesisTryApply(true, makeCtx({ proposalJson: JSON.stringify(proposal) }));
      // All ops failed pre-validation → applied=0 → onFailure
      expect(result.onFailure).toBe(true);
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      const r = JSON.parse(ctx.applyResultJson!);
      expect(r.failed).toBe(1);
      expect(r.errors[0]).toContain("missing 'from' or 'to'");
    });

    it('rejects addConnection with colon-format port refs', async () => {
      const badOp = { type: 'addConnection' as const, args: { from: 'Start:execute', to: 'n1.execute' }, costUnits: 1, rationale: 'bad' };
      const proposal = makeProposal([badOp]);
      mockExecFileSync.mockReturnValue('' as any);

      const result = await genesisTryApply(true, makeCtx({ proposalJson: JSON.stringify(proposal) }));
      expect(result.onFailure).toBe(true);
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      const r = JSON.parse(ctx.applyResultJson!);
      expect(r.errors[0]).toContain('"node.port" format');
    });

    it('rejects addNode with missing nodeId', async () => {
      const badOp = { type: 'addNode' as const, args: { nodeType: 'SomeType' }, costUnits: 1, rationale: 'bad' };
      const proposal = makeProposal([badOp]);
      mockExecFileSync.mockReturnValue('' as any);

      const result = await genesisTryApply(true, makeCtx({ proposalJson: JSON.stringify(proposal) }));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      const r = JSON.parse(ctx.applyResultJson!);
      expect(r.errors[0]).toContain("missing 'nodeId' or 'nodeType'");
    });

    it('rejects implementNode with undefined nodeId', async () => {
      const badOp = { type: 'implementNode' as const, args: { nodeId: 'undefined' }, costUnits: 2, rationale: 'bad' };
      const proposal = makeProposal([badOp]);
      mockExecFileSync.mockReturnValue('' as any);

      const result = await genesisTryApply(true, makeCtx({ proposalJson: JSON.stringify(proposal) }));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      const r = JSON.parse(ctx.applyResultJson!);
      expect(r.errors[0]).toContain('invalid');
    });
  });

  describe('buildModifyArgs — operation CLI mapping', () => {
    it('uses implement subcommand for implementNode', async () => {
      mockExecFileSync.mockReturnValue('' as any);

      await genesisTryApply(true, makeCtx({ proposalJson: JSON.stringify(makeProposal([IMPLEMENT_NODE_OP])) }));

      const implementCall = mockExecFileSync.mock.calls.find(
        (c) => c[0] === 'flow-weaver' && Array.isArray(c[1]) && (c[1] as string[])[0] === 'implement',
      );
      expect(implementCall).toBeDefined();
    });

    it('passes --nodeId for addNode', async () => {
      mockExecFileSync.mockReturnValue('' as any);

      await genesisTryApply(true, makeCtx({ proposalJson: JSON.stringify(makeProposal([ADD_NODE_OP])) }));

      const addCall = mockExecFileSync.mock.calls.find(
        (c) => c[0] === 'flow-weaver' && Array.isArray(c[1]) && (c[1] as string[]).includes('addNode'),
      );
      expect(addCall).toBeDefined();
      expect(addCall![1]).toContain('n1');
    });

    it('passes --from and --to for removeConnection', async () => {
      mockExecFileSync.mockReturnValue('' as any);

      await genesisTryApply(true, makeCtx({ proposalJson: JSON.stringify(makeProposal([REMOVE_CONN_OP])) }));

      const removeConnCall = mockExecFileSync.mock.calls.find(
        (c) => c[0] === 'flow-weaver' && Array.isArray(c[1]) && (c[1] as string[]).includes('removeConnection'),
      );
      expect(removeConnCall).toBeDefined();
      expect(removeConnCall![1]).toContain('a.out');
      expect(removeConnCall![1]).toContain('b.in');
    });
  });
});
