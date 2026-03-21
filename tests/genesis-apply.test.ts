import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WeaverEnv, GenesisConfig, GenesisProposal, GenesisOperation } from '../src/bot/types.js';

// ── Mock child_process ────────────────────────────────────────────────────────

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFileSync: vi.fn() };
});

import { execFileSync } from 'node:child_process';
import { genesisApply } from '../src/node-types/genesis-apply.js';

const mockedExecFileSync = vi.mocked(execFileSync);

// ── helpers ───────────────────────────────────────────────────────────────────

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

function makeProposal(operations: GenesisOperation[]): GenesisProposal {
  return {
    operations,
    totalCost: operations.reduce((sum, op) => sum + op.costUnits, 0),
    impactLevel: 'MINOR',
    summary: 'Test proposal',
    rationale: 'Testing',
  };
}

function makeOp(type: GenesisOperation['type'], args: GenesisOperation['args'] = {}, rationale = 'test rationale'): GenesisOperation {
  return { type, args, costUnits: 1, rationale };
}

const CONFIG_JSON = JSON.stringify(BASE_CONFIG);
const SNAPSHOT_PATH = '/test/.genesis/snapshots/snap-001.ts';

// ── tests ─────────────────────────────────────────────────────────────────────

describe('genesisApply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockedExecFileSync.mockReturnValue('' as any);
  });

  // ── dry-run (execute=false) ──────────────────────────────────────────────────

  describe('dry-run (execute=false)', () => {
    const proposal = makeProposal([makeOp('addNode', { nodeId: 'n1', nodeType: 'MyNode' })]);

    it('returns onSuccess=true without calling execFileSync', async () => {
      const result = await genesisApply(false, BASE_ENV, CONFIG_JSON, JSON.stringify(proposal), SNAPSHOT_PATH);
      expect(result.onSuccess).toBe(true);
      expect(result.onFailure).toBe(false);
      expect(mockedExecFileSync).not.toHaveBeenCalled();
    });

    it('returns applyResultJson with applied=0 and failed=0', async () => {
      const result = await genesisApply(false, BASE_ENV, CONFIG_JSON, JSON.stringify(proposal), SNAPSHOT_PATH);
      const r = JSON.parse(result.applyResultJson);
      expect(r.applied).toBe(0);
      expect(r.failed).toBe(0);
      expect(r.errors).toEqual([]);
    });

    it('passes env, genesisConfigJson, proposalJson, snapshotPath through unchanged', async () => {
      const proposalJson = JSON.stringify(proposal);
      const result = await genesisApply(false, BASE_ENV, CONFIG_JSON, proposalJson, SNAPSHOT_PATH);
      expect(result.env).toBe(BASE_ENV);
      expect(result.genesisConfigJson).toBe(CONFIG_JSON);
      expect(result.proposalJson).toBe(proposalJson);
      expect(result.snapshotPath).toBe(SNAPSHOT_PATH);
    });
  });

  // ── buildModifyArgs: addNode ──────────────────────────────────────────────────

  describe('buildModifyArgs — addNode', () => {
    it('calls execFileSync with modify addNode and nodeId/nodeType args', async () => {
      const proposal = makeProposal([makeOp('addNode', { nodeId: 'myNode', nodeType: 'ProcessorNode' })]);
      await genesisApply(true, BASE_ENV, CONFIG_JSON, JSON.stringify(proposal), SNAPSHOT_PATH);

      expect(mockedExecFileSync).toHaveBeenCalledOnce();
      const [cmd, args] = mockedExecFileSync.mock.calls[0];
      expect(cmd).toBe('flow-weaver');
      expect(args).toContain('modify');
      expect(args).toContain('addNode');
      expect(args).toContain('--nodeId');
      expect(args).toContain('myNode');
      expect(args).toContain('--nodeType');
      expect(args).toContain('ProcessorNode');
      expect(args).toContain('--file');
    });
  });

  // ── buildModifyArgs: removeNode ───────────────────────────────────────────────

  describe('buildModifyArgs — removeNode', () => {
    it('calls execFileSync with modify removeNode and nodeId arg', async () => {
      const proposal = makeProposal([makeOp('removeNode', { nodeId: 'oldNode' })]);
      await genesisApply(true, BASE_ENV, CONFIG_JSON, JSON.stringify(proposal), SNAPSHOT_PATH);

      const [cmd, args] = mockedExecFileSync.mock.calls[0];
      expect(cmd).toBe('flow-weaver');
      expect(args).toContain('removeNode');
      expect(args).toContain('--nodeId');
      expect(args).toContain('oldNode');
      expect(args).not.toContain('--nodeType');
    });
  });

  // ── buildModifyArgs: addConnection ────────────────────────────────────────────

  describe('buildModifyArgs — addConnection', () => {
    it('calls execFileSync with modify addConnection and from/to args', async () => {
      const proposal = makeProposal([makeOp('addConnection', { from: 'nodeA.result', to: 'nodeB.input' })]);
      await genesisApply(true, BASE_ENV, CONFIG_JSON, JSON.stringify(proposal), SNAPSHOT_PATH);

      const [, args] = mockedExecFileSync.mock.calls[0];
      expect(args).toContain('addConnection');
      expect(args).toContain('--from');
      expect(args).toContain('nodeA.result');
      expect(args).toContain('--to');
      expect(args).toContain('nodeB.input');
    });
  });

  // ── buildModifyArgs: removeConnection ─────────────────────────────────────────

  describe('buildModifyArgs — removeConnection', () => {
    it('calls execFileSync with modify removeConnection and from/to args', async () => {
      const proposal = makeProposal([makeOp('removeConnection', { from: 'src.out', to: 'dst.in' })]);
      await genesisApply(true, BASE_ENV, CONFIG_JSON, JSON.stringify(proposal), SNAPSHOT_PATH);

      const [, args] = mockedExecFileSync.mock.calls[0];
      expect(args).toContain('removeConnection');
      expect(args).toContain('--from');
      expect(args).toContain('src.out');
      expect(args).toContain('--to');
      expect(args).toContain('dst.in');
    });
  });

  // ── buildModifyArgs: implementNode ────────────────────────────────────────────

  describe('buildModifyArgs — implementNode', () => {
    it('calls execFileSync with implement (not modify) and nodeId arg', async () => {
      const proposal = makeProposal([makeOp('implementNode', { nodeId: 'stubNode' })]);
      await genesisApply(true, BASE_ENV, CONFIG_JSON, JSON.stringify(proposal), SNAPSHOT_PATH);

      const [cmd, args] = mockedExecFileSync.mock.calls[0];
      expect(cmd).toBe('flow-weaver');
      expect(args[0]).toBe('implement');
      expect(args).toContain('--nodeId');
      expect(args).toContain('stubNode');
      expect(args).not.toContain('modify');
    });
  });

  // ── unknown operation type ────────────────────────────────────────────────────

  describe('unknown operation type', () => {
    it('records an error and increments failed when operation type is unknown', async () => {
      const proposal = makeProposal([makeOp('selfModifyWorkflow' as any, { nodeId: 'x' })]);
      const result = await genesisApply(true, BASE_ENV, CONFIG_JSON, JSON.stringify(proposal), SNAPSHOT_PATH);
      const r = JSON.parse(result.applyResultJson);
      expect(r.failed).toBe(1);
      expect(r.applied).toBe(0);
      expect(r.errors[0]).toContain('selfModifyWorkflow');
    });

    it('returns onFailure=true when operation type is unknown', async () => {
      const proposal = makeProposal([makeOp('selfModifyWorkflow' as any, {})]);
      const result = await genesisApply(true, BASE_ENV, CONFIG_JSON, JSON.stringify(proposal), SNAPSHOT_PATH);
      expect(result.onSuccess).toBe(false);
      expect(result.onFailure).toBe(true);
    });

    it('does not call execFileSync for unknown operation', async () => {
      const proposal = makeProposal([makeOp('selfModifyWorkflow' as any, {})]);
      await genesisApply(true, BASE_ENV, CONFIG_JSON, JSON.stringify(proposal), SNAPSHOT_PATH);
      expect(mockedExecFileSync).not.toHaveBeenCalled();
    });
  });

  // ── all operations succeed ────────────────────────────────────────────────────

  describe('all operations succeed', () => {
    it('returns onSuccess=true when all steps complete without error', async () => {
      const proposal = makeProposal([
        makeOp('addNode', { nodeId: 'n1', nodeType: 'NodeA' }),
        makeOp('addConnection', { from: 'Start.data', to: 'n1.input' }),
      ]);
      const result = await genesisApply(true, BASE_ENV, CONFIG_JSON, JSON.stringify(proposal), SNAPSHOT_PATH);
      expect(result.onSuccess).toBe(true);
      expect(result.onFailure).toBe(false);
    });

    it('applyResultJson has applied=N, failed=0, errors=[]', async () => {
      const proposal = makeProposal([
        makeOp('addNode', { nodeId: 'n1', nodeType: 'NodeA' }),
        makeOp('addNode', { nodeId: 'n2', nodeType: 'NodeB' }),
        makeOp('addConnection', { from: 'n1.out', to: 'n2.in' }),
      ]);
      const result = await genesisApply(true, BASE_ENV, CONFIG_JSON, JSON.stringify(proposal), SNAPSHOT_PATH);
      const r = JSON.parse(result.applyResultJson);
      expect(r.applied).toBe(3);
      expect(r.failed).toBe(0);
      expect(r.errors).toEqual([]);
    });

    it('calls execFileSync once per operation', async () => {
      const proposal = makeProposal([
        makeOp('addNode', { nodeId: 'n1', nodeType: 'A' }),
        makeOp('removeNode', { nodeId: 'n2' }),
        makeOp('addConnection', { from: 'a.out', to: 'b.in' }),
      ]);
      await genesisApply(true, BASE_ENV, CONFIG_JSON, JSON.stringify(proposal), SNAPSHOT_PATH);
      expect(mockedExecFileSync).toHaveBeenCalledTimes(3);
    });

    it('passes env through on success', async () => {
      const proposal = makeProposal([makeOp('addNode', { nodeId: 'n1', nodeType: 'A' })]);
      const result = await genesisApply(true, BASE_ENV, CONFIG_JSON, JSON.stringify(proposal), SNAPSHOT_PATH);
      expect(result.env).toBe(BASE_ENV);
    });
  });

  // ── empty operations list ─────────────────────────────────────────────────────

  describe('empty operations list', () => {
    it('returns onFailure=true when proposal has no operations (applied=0)', async () => {
      const proposal = makeProposal([]);
      const result = await genesisApply(true, BASE_ENV, CONFIG_JSON, JSON.stringify(proposal), SNAPSHOT_PATH);
      // success = failed === 0 && applied > 0 → false when applied=0
      expect(result.onSuccess).toBe(false);
      expect(result.onFailure).toBe(true);
    });

    it('applyResultJson has applied=0 and failed=0', async () => {
      const proposal = makeProposal([]);
      const result = await genesisApply(true, BASE_ENV, CONFIG_JSON, JSON.stringify(proposal), SNAPSHOT_PATH);
      const r = JSON.parse(result.applyResultJson);
      expect(r.applied).toBe(0);
      expect(r.failed).toBe(0);
    });
  });

  // ── partial failures ──────────────────────────────────────────────────────────

  describe('partial failures (execFileSync throws on some steps)', () => {
    it('returns onFailure=true when any execFileSync call throws', async () => {
      mockedExecFileSync
        .mockImplementationOnce(() => { throw new Error('CLI error'); })
        .mockReturnValue('' as any);

      const proposal = makeProposal([
        makeOp('addNode', { nodeId: 'bad', nodeType: 'X' }),
        makeOp('addNode', { nodeId: 'ok', nodeType: 'Y' }),
      ]);
      const result = await genesisApply(true, BASE_ENV, CONFIG_JSON, JSON.stringify(proposal), SNAPSHOT_PATH);
      expect(result.onSuccess).toBe(false);
      expect(result.onFailure).toBe(true);
    });

    it('continues executing remaining operations after one fails', async () => {
      mockedExecFileSync
        .mockImplementationOnce(() => { throw new Error('step 1 error'); })
        .mockReturnValue('' as any);

      const proposal = makeProposal([
        makeOp('addNode', { nodeId: 'n1', nodeType: 'A' }),
        makeOp('addNode', { nodeId: 'n2', nodeType: 'B' }),
        makeOp('addNode', { nodeId: 'n3', nodeType: 'C' }),
      ]);
      await genesisApply(true, BASE_ENV, CONFIG_JSON, JSON.stringify(proposal), SNAPSHOT_PATH);
      expect(mockedExecFileSync).toHaveBeenCalledTimes(3);
    });

    it('applyResultJson has correct applied and failed counts', async () => {
      mockedExecFileSync
        .mockReturnValueOnce('' as any)
        .mockImplementationOnce(() => { throw new Error('op 2 failed'); })
        .mockReturnValue('' as any);

      const proposal = makeProposal([
        makeOp('addNode', { nodeId: 'n1', nodeType: 'A' }),
        makeOp('removeNode', { nodeId: 'n2' }),
        makeOp('addConnection', { from: 'a.out', to: 'b.in' }),
      ]);
      const result = await genesisApply(true, BASE_ENV, CONFIG_JSON, JSON.stringify(proposal), SNAPSHOT_PATH);
      const r = JSON.parse(result.applyResultJson);
      expect(r.applied).toBe(2);
      expect(r.failed).toBe(1);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toContain('removeNode');
      expect(r.errors[0]).toContain('op 2 failed');
    });

    it('includes op.type prefix in error message', async () => {
      mockedExecFileSync.mockImplementationOnce(() => { throw new Error('compile failure'); });

      const proposal = makeProposal([makeOp('addConnection', { from: 'x.out', to: 'y.in' })]);
      const result = await genesisApply(true, BASE_ENV, CONFIG_JSON, JSON.stringify(proposal), SNAPSHOT_PATH);
      const r = JSON.parse(result.applyResultJson);
      expect(r.errors[0]).toMatch(/^addConnection:/);
      expect(r.errors[0]).toContain('compile failure');
    });

    it('all failures: onFailure=true and applied=0', async () => {
      mockedExecFileSync.mockImplementation(() => { throw new Error('always fails'); });

      const proposal = makeProposal([
        makeOp('addNode', { nodeId: 'n1', nodeType: 'A' }),
        makeOp('addNode', { nodeId: 'n2', nodeType: 'B' }),
      ]);
      const result = await genesisApply(true, BASE_ENV, CONFIG_JSON, JSON.stringify(proposal), SNAPSHOT_PATH);
      const r = JSON.parse(result.applyResultJson);
      expect(r.applied).toBe(0);
      expect(r.failed).toBe(2);
      expect(result.onFailure).toBe(true);
    });
  });

  // ── target path resolution ────────────────────────────────────────────────────

  describe('target path resolution', () => {
    it('passes absolute resolved target path to execFileSync --file arg', async () => {
      const proposal = makeProposal([makeOp('addNode', { nodeId: 'n1', nodeType: 'A' })]);
      await genesisApply(true, BASE_ENV, CONFIG_JSON, JSON.stringify(proposal), SNAPSHOT_PATH);

      const [, args] = mockedExecFileSync.mock.calls[0];
      const fileArgIdx = (args as string[]).indexOf('--file');
      expect(fileArgIdx).toBeGreaterThan(-1);
      const filePath = (args as string[])[fileArgIdx + 1];
      expect(filePath).toContain('src/workflows/my-workflow.ts');
    });

    it('uses projectDir from env as cwd for execFileSync', async () => {
      const proposal = makeProposal([makeOp('addNode', { nodeId: 'n1', nodeType: 'A' })]);
      await genesisApply(true, BASE_ENV, CONFIG_JSON, JSON.stringify(proposal), SNAPSHOT_PATH);

      const opts = mockedExecFileSync.mock.calls[0][2] as Record<string, unknown>;
      expect(opts.cwd).toBe('/test');
    });
  });
});
