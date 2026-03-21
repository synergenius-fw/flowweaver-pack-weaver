import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GenesisContext, GenesisProposal, GenesisFingerprint, GenesisCycleRecord } from '../src/bot/types.js';

// Hoist mock instances so they're accessible in factory closures
const mockAppendCycle = vi.hoisted(() => vi.fn());
const mockSaveFingerprint = vi.hoisted(() => vi.fn());

vi.mock('../src/bot/genesis-store.js', () => ({
  GenesisStore: vi.fn().mockImplementation(function () {
    return { appendCycle: mockAppendCycle, saveFingerprint: mockSaveFingerprint };
  }),
}));

import { genesisUpdateHistory } from '../src/node-types/genesis-update-history.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

const FINGERPRINT: GenesisFingerprint = {
  timestamp: '2026-01-01T00:00:00.000Z',
  files: { 'workflow.ts': 'abc123' },
  packageJson: null,
  gitBranch: 'main',
  gitCommit: 'abc',
  workflowHash: 'def456',
  existingWorkflows: ['workflow.ts'],
};

const PROPOSAL_WITH_OPS: GenesisProposal = {
  operations: [{ type: 'addNode', args: { nodeId: 'n1' }, costUnits: 1, rationale: 'test' }],
  totalCost: 1,
  impactLevel: 'MINOR',
  summary: 'add a node',
  rationale: 'improve coverage',
};

const EMPTY_PROPOSAL: GenesisProposal = {
  operations: [],
  totalCost: 0,
  impactLevel: 'COSMETIC',
  summary: '',
  rationale: '',
};

function makeCtx(overrides: Partial<GenesisContext> = {}): string {
  const base: GenesisContext = {
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
      approvalThreshold: 'MINOR',
      budgetPerCycle: 5,
      stabilize: false,
      targetWorkflow: 'workflow.ts',
      maxCyclesPerRun: 3,
    }),
    cycleId: 'cycle-42',
    fingerprintJson: JSON.stringify(FINGERPRINT),
    startTimeMs: Date.now() - 500,
  };
  return JSON.stringify({ ...base, ...overrides });
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('genesisUpdateHistory — outcome derivation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('outcome=error when context.error is set', () => {
    const ctx = makeCtx({
      error: 'something went wrong',
      proposalJson: JSON.stringify(PROPOSAL_WITH_OPS),
      approved: true,
      applyResultJson: JSON.stringify({ applied: 1, failed: 0, errors: [] }),
    });
    const result = genesisUpdateHistory(ctx);
    const record = JSON.parse(JSON.parse(result.ctx).cycleRecordJson) as GenesisCycleRecord;
    expect(record.outcome).toBe('error');
  });

  it('outcome=no-change when proposalJson is absent', () => {
    const ctx = makeCtx({ proposalJson: undefined });
    const result = genesisUpdateHistory(ctx);
    const record = JSON.parse(JSON.parse(result.ctx).cycleRecordJson) as GenesisCycleRecord;
    expect(record.outcome).toBe('no-change');
  });

  it('outcome=no-change when proposal has 0 operations', () => {
    const ctx = makeCtx({ proposalJson: JSON.stringify(EMPTY_PROPOSAL) });
    const result = genesisUpdateHistory(ctx);
    const record = JSON.parse(JSON.parse(result.ctx).cycleRecordJson) as GenesisCycleRecord;
    expect(record.outcome).toBe('no-change');
  });

  it('outcome=rejected when approved=false', () => {
    const ctx = makeCtx({
      proposalJson: JSON.stringify(PROPOSAL_WITH_OPS),
      approved: false,
    });
    const result = genesisUpdateHistory(ctx);
    const record = JSON.parse(JSON.parse(result.ctx).cycleRecordJson) as GenesisCycleRecord;
    expect(record.outcome).toBe('rejected');
  });

  it('outcome=rolled-back when applyResult has failed > 0', () => {
    const ctx = makeCtx({
      proposalJson: JSON.stringify(PROPOSAL_WITH_OPS),
      approved: true,
      applyResultJson: JSON.stringify({ applied: 0, failed: 1, errors: ['compile error'] }),
    });
    const result = genesisUpdateHistory(ctx);
    const record = JSON.parse(JSON.parse(result.ctx).cycleRecordJson) as GenesisCycleRecord;
    expect(record.outcome).toBe('rolled-back');
  });

  it('outcome=applied when approved=true and applyResult.failed=0', () => {
    const ctx = makeCtx({
      proposalJson: JSON.stringify(PROPOSAL_WITH_OPS),
      approved: true,
      applyResultJson: JSON.stringify({ applied: 1, failed: 0, errors: [] }),
    });
    const result = genesisUpdateHistory(ctx);
    const record = JSON.parse(JSON.parse(result.ctx).cycleRecordJson) as GenesisCycleRecord;
    expect(record.outcome).toBe('applied');
  });

  it('outcome=error for unrecognized state (proposal present, no approved, no applyResult)', () => {
    const ctx = makeCtx({
      proposalJson: JSON.stringify(PROPOSAL_WITH_OPS),
      // approved and applyResultJson both absent
    });
    const result = genesisUpdateHistory(ctx);
    const record = JSON.parse(JSON.parse(result.ctx).cycleRecordJson) as GenesisCycleRecord;
    expect(record.outcome).toBe('error');
  });
});

describe('genesisUpdateHistory — record fields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('record contains cycleId and non-negative durationMs', () => {
    const ctx = makeCtx({
      proposalJson: JSON.stringify(PROPOSAL_WITH_OPS),
      approved: true,
      applyResultJson: JSON.stringify({ applied: 1, failed: 0, errors: [] }),
    });
    const result = genesisUpdateHistory(ctx);
    const record = JSON.parse(JSON.parse(result.ctx).cycleRecordJson) as GenesisCycleRecord;

    expect(record.id).toBe('cycle-42');
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
    expect(record.timestamp).toBeTruthy();
  });

  it('approvalRequired=true when approved is defined', () => {
    const ctx = makeCtx({
      proposalJson: JSON.stringify(PROPOSAL_WITH_OPS),
      approved: true,
      applyResultJson: JSON.stringify({ applied: 1, failed: 0, errors: [] }),
    });
    const result = genesisUpdateHistory(ctx);
    const record = JSON.parse(JSON.parse(result.ctx).cycleRecordJson) as GenesisCycleRecord;
    expect(record.approvalRequired).toBe(true);
  });

  it('approvalRequired=false when approved is undefined', () => {
    const ctx = makeCtx({ proposalJson: undefined });
    const result = genesisUpdateHistory(ctx);
    const record = JSON.parse(JSON.parse(result.ctx).cycleRecordJson) as GenesisCycleRecord;
    expect(record.approvalRequired).toBe(false);
  });

  it('error field populated from applyResult.errors when rolled-back', () => {
    const ctx = makeCtx({
      proposalJson: JSON.stringify(PROPOSAL_WITH_OPS),
      approved: true,
      applyResultJson: JSON.stringify({ applied: 0, failed: 1, errors: ['compile failed', 'type error'] }),
    });
    const result = genesisUpdateHistory(ctx);
    const record = JSON.parse(JSON.parse(result.ctx).cycleRecordJson) as GenesisCycleRecord;
    expect(record.error).toContain('compile failed');
    expect(record.error).toContain('type error');
  });

  it('snapshotFile set from context.snapshotPath', () => {
    const ctx = makeCtx({
      proposalJson: JSON.stringify(PROPOSAL_WITH_OPS),
      approved: true,
      applyResultJson: JSON.stringify({ applied: 1, failed: 0, errors: [] }),
      snapshotPath: '/project/.genesis/snapshots/snap-1.ts',
    });
    const result = genesisUpdateHistory(ctx);
    const record = JSON.parse(JSON.parse(result.ctx).cycleRecordJson) as GenesisCycleRecord;
    expect(record.snapshotFile).toBe('/project/.genesis/snapshots/snap-1.ts');
  });
});

describe('genesisUpdateHistory — GenesisStore calls', () => {
  beforeEach(() => {
    // clearAllMocks resets call counts without resetting mock implementations
    // (vi.resetAllMocks would wipe out the GenesisStore factory implementation)
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('calls appendCycle with the cycle record', () => {
    const ctx = makeCtx({
      proposalJson: JSON.stringify(PROPOSAL_WITH_OPS),
      approved: true,
      applyResultJson: JSON.stringify({ applied: 1, failed: 0, errors: [] }),
    });
    genesisUpdateHistory(ctx);

    expect(mockAppendCycle).toHaveBeenCalledOnce();
    const [record] = mockAppendCycle.mock.calls[0];
    expect(record.id).toBe('cycle-42');
    expect(record.outcome).toBe('applied');
  });

  it('calls saveFingerprint with the fingerprint when fingerprintJson is present', () => {
    const ctx = makeCtx({
      proposalJson: JSON.stringify(PROPOSAL_WITH_OPS),
      approved: true,
      applyResultJson: JSON.stringify({ applied: 1, failed: 0, errors: [] }),
    });
    genesisUpdateHistory(ctx);

    expect(mockSaveFingerprint).toHaveBeenCalledOnce();
    const [fp] = mockSaveFingerprint.mock.calls[0];
    expect(fp.workflowHash).toBe('def456');
  });

  it('does not call saveFingerprint when fingerprintJson is absent', () => {
    const ctx = makeCtx({ fingerprintJson: undefined });
    genesisUpdateHistory(ctx);

    expect(mockAppendCycle).toHaveBeenCalledOnce();
    expect(mockSaveFingerprint).not.toHaveBeenCalled();
  });

  it('continues gracefully when GenesisStore throws', () => {
    mockAppendCycle.mockImplementationOnce(() => { throw new Error('disk full'); });

    const ctx = makeCtx({
      proposalJson: JSON.stringify(PROPOSAL_WITH_OPS),
      approved: true,
      applyResultJson: JSON.stringify({ applied: 1, failed: 0, errors: [] }),
    });

    // Should not throw — error is caught and logged
    const result = genesisUpdateHistory(ctx);
    const outCtx = JSON.parse(result.ctx) as GenesisContext;
    // cycleRecordJson is still set even when store throws
    expect(outCtx.cycleRecordJson).toBeTruthy();
  });
});

describe('genesisUpdateHistory — record field details', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('cycleRecordJson is valid JSON', () => {
    const result = genesisUpdateHistory(makeCtx());
    const outCtx = JSON.parse(result.ctx) as GenesisContext;
    expect(() => JSON.parse(outCtx.cycleRecordJson!)).not.toThrow();
  });

  it('return value has only ctx key', () => {
    const result = genesisUpdateHistory(makeCtx());
    expect(Object.keys(result)).toEqual(['ctx']);
  });

  it('env.projectDir preserved in returned ctx', () => {
    const result = genesisUpdateHistory(makeCtx());
    const outCtx = JSON.parse(result.ctx) as GenesisContext;
    expect(outCtx.env.projectDir).toBe('/project');
  });

  it('record.approved=true when context.approved=true', () => {
    const ctx = makeCtx({
      proposalJson: JSON.stringify(PROPOSAL_WITH_OPS),
      approved: true,
      applyResultJson: JSON.stringify({ applied: 1, failed: 0, errors: [] }),
    });
    const result = genesisUpdateHistory(ctx);
    const record = JSON.parse(JSON.parse(result.ctx).cycleRecordJson) as GenesisCycleRecord;
    expect(record.approved).toBe(true);
  });

  it('record.approved=false when context.approved=false', () => {
    const ctx = makeCtx({
      proposalJson: JSON.stringify(PROPOSAL_WITH_OPS),
      approved: false,
    });
    const result = genesisUpdateHistory(ctx);
    const record = JSON.parse(JSON.parse(result.ctx).cycleRecordJson) as GenesisCycleRecord;
    expect(record.approved).toBe(false);
  });

  it('record.approved=null when context.approved is undefined', () => {
    const ctx = makeCtx({ proposalJson: undefined });
    const result = genesisUpdateHistory(ctx);
    const record = JSON.parse(JSON.parse(result.ctx).cycleRecordJson) as GenesisCycleRecord;
    expect(record.approved).toBeNull();
  });

  it('record.diffSummary equals proposal.summary', () => {
    const ctx = makeCtx({
      proposalJson: JSON.stringify(PROPOSAL_WITH_OPS),
      approved: true,
      applyResultJson: JSON.stringify({ applied: 1, failed: 0, errors: [] }),
    });
    const result = genesisUpdateHistory(ctx);
    const record = JSON.parse(JSON.parse(result.ctx).cycleRecordJson) as GenesisCycleRecord;
    expect(record.diffSummary).toBe('add a node');
  });

  it('record.diffSummary=null when proposal is absent', () => {
    const result = genesisUpdateHistory(makeCtx({ proposalJson: undefined }));
    const record = JSON.parse(JSON.parse(result.ctx).cycleRecordJson) as GenesisCycleRecord;
    expect(record.diffSummary).toBeNull();
  });

  it('record.timestamp is a valid ISO string', () => {
    const result = genesisUpdateHistory(makeCtx());
    const record = JSON.parse(JSON.parse(result.ctx).cycleRecordJson) as GenesisCycleRecord;
    expect(new Date(record.timestamp).toISOString()).toBe(record.timestamp);
  });

  it('durationMs=0 when startTimeMs is absent', () => {
    const ctx = makeCtx({ startTimeMs: undefined });
    const result = genesisUpdateHistory(ctx);
    const record = JSON.parse(JSON.parse(result.ctx).cycleRecordJson) as GenesisCycleRecord;
    expect(record.durationMs).toBe(0);
  });
});
