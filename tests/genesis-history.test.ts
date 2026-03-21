import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  GenesisContext,
  GenesisConfig,
  GenesisFingerprint,
  GenesisProposal,
  GenesisCycleRecord,
} from '../src/bot/types.js';

// ── Mock GenesisStore ─────────────────────────────────────────────────────────

const { mockAppendCycle, mockSaveFingerprint, mockSaveSnapshot, MockGenesisStore } = vi.hoisted(() => {
  const mockAppendCycle = vi.fn();
  const mockSaveFingerprint = vi.fn();
  const mockSaveSnapshot = vi.fn<() => string>().mockReturnValue('/test/.genesis/snapshots/test-cycle.ts');
  const MockGenesisStore = vi.fn(function (
    this: {
      appendCycle: typeof mockAppendCycle;
      saveFingerprint: typeof mockSaveFingerprint;
      saveSnapshot: typeof mockSaveSnapshot;
    },
  ) {
    this.appendCycle = mockAppendCycle;
    this.saveFingerprint = mockSaveFingerprint;
    this.saveSnapshot = mockSaveSnapshot;
  });
  return { mockAppendCycle, mockSaveFingerprint, mockSaveSnapshot, MockGenesisStore };
});

vi.mock('../src/bot/genesis-store.js', () => ({
  GenesisStore: MockGenesisStore,
}));

// ── Mock fs.readFileSync for genesisSnapshot ──────────────────────────────────

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, readFileSync: vi.fn() };
});

import * as fs from 'node:fs';
import { genesisUpdateHistory } from '../src/node-types/genesis-update-history.js';
import { genesisSnapshot } from '../src/node-types/genesis-snapshot.js';

const mockedReadFileSync = vi.mocked(fs.readFileSync);

// ── helpers ───────────────────────────────────────────────────────────────────

const BASE_ENV = {
  projectDir: '/test',
  config: { provider: 'auto' as const },
  providerType: 'anthropic' as const,
  providerInfo: { type: 'anthropic' as const, apiKey: 'key' },
};

const BASE_CONFIG: GenesisConfig = {
  intent: 'test',
  focus: [],
  constraints: [],
  approvalThreshold: 'MINOR',
  budgetPerCycle: 3,
  stabilize: false,
  targetWorkflow: 'workflow.ts',
};

function makeFingerprint(overrides: Partial<GenesisFingerprint> = {}): GenesisFingerprint {
  return {
    timestamp: '2026-01-01T00:00:00.000Z',
    files: {},
    packageJson: null,
    gitBranch: 'main',
    gitCommit: 'abc123',
    workflowHash: 'wh1',
    existingWorkflows: [],
    ...overrides,
  };
}

function makeProposal(ops = 1): GenesisProposal {
  return {
    operations: Array.from({ length: ops }, (_, i) => ({
      type: 'addNode' as const,
      nodeId: `n${i}`,
      nodeType: 'MyNode',
      label: 'My Node',
      position: { x: 0, y: 0 },
    })),
    totalCost: ops,
    impactLevel: 'MINOR',
    summary: 'test proposal',
    rationale: 'test',
  };
}

function makeHistoryCtx(overrides: Partial<GenesisContext> = {}): string {
  const ctx: GenesisContext = {
    env: BASE_ENV,
    genesisConfigJson: JSON.stringify(BASE_CONFIG),
    cycleId: 'test-cycle-1',
    startTimeMs: Date.now() - 100,
    fingerprintJson: JSON.stringify(makeFingerprint()),
    ...overrides,
  };
  return JSON.stringify(ctx);
}

function makeSnapshotCtx(overrides: Partial<GenesisContext> = {}): string {
  return JSON.stringify({
    env: BASE_ENV,
    genesisConfigJson: JSON.stringify(BASE_CONFIG),
    cycleId: 'snap-cycle-1',
    ...overrides,
  } as GenesisContext);
}

// ── genesisUpdateHistory ──────────────────────────────────────────────────────

describe('genesisUpdateHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('calls appendCycle (creates history entry for new cycle)', () => {
    const ctx = makeHistoryCtx({
      approved: true,
      proposalJson: JSON.stringify(makeProposal()),
      applyResultJson: JSON.stringify({ applied: 1, failed: 0, errors: [] }),
    });
    genesisUpdateHistory(ctx);
    expect(mockAppendCycle).toHaveBeenCalledOnce();
  });

  it('calls appendCycle on each invocation (appends to existing history)', () => {
    const ctx = makeHistoryCtx({
      approved: true,
      proposalJson: JSON.stringify(makeProposal()),
      applyResultJson: JSON.stringify({ applied: 1, failed: 0, errors: [] }),
    });
    genesisUpdateHistory(ctx);
    genesisUpdateHistory(ctx);
    expect(mockAppendCycle).toHaveBeenCalledTimes(2);
  });

  it('record passed to appendCycle contains cycleId and correct outcome', () => {
    const ctx = makeHistoryCtx({
      approved: true,
      proposalJson: JSON.stringify(makeProposal()),
      applyResultJson: JSON.stringify({ applied: 1, failed: 0, errors: [] }),
    });
    genesisUpdateHistory(ctx);
    const record = mockAppendCycle.mock.calls[0][0] as GenesisCycleRecord;
    expect(record.id).toBe('test-cycle-1');
    expect(record.outcome).toBe('applied');
  });

  it('outcome is applied when approved=true and applyResult.failed=0', () => {
    const ctx = makeHistoryCtx({
      approved: true,
      proposalJson: JSON.stringify(makeProposal()),
      applyResultJson: JSON.stringify({ applied: 1, failed: 0, errors: [] }),
    });
    genesisUpdateHistory(ctx);
    const record = mockAppendCycle.mock.calls[0][0] as GenesisCycleRecord;
    expect(record.outcome).toBe('applied');
  });

  it('outcome is rejected when approved=false', () => {
    const ctx = makeHistoryCtx({
      approved: false,
      proposalJson: JSON.stringify(makeProposal()),
    });
    genesisUpdateHistory(ctx);
    const record = mockAppendCycle.mock.calls[0][0] as GenesisCycleRecord;
    expect(record.outcome).toBe('rejected');
  });

  it('outcome is rolled-back when applyResult.failed > 0', () => {
    const ctx = makeHistoryCtx({
      approved: true,
      proposalJson: JSON.stringify(makeProposal()),
      applyResultJson: JSON.stringify({ applied: 0, failed: 1, errors: ['compile error'] }),
    });
    genesisUpdateHistory(ctx);
    const record = mockAppendCycle.mock.calls[0][0] as GenesisCycleRecord;
    expect(record.outcome).toBe('rolled-back');
  });

  it('outcome is no-change when proposal has no operations', () => {
    const ctx = makeHistoryCtx({
      proposalJson: JSON.stringify(makeProposal(0)),
    });
    genesisUpdateHistory(ctx);
    const record = mockAppendCycle.mock.calls[0][0] as GenesisCycleRecord;
    expect(record.outcome).toBe('no-change');
  });

  it('outcome is no-change when proposalJson is absent', () => {
    const ctx = makeHistoryCtx({ proposalJson: undefined });
    genesisUpdateHistory(ctx);
    const record = mockAppendCycle.mock.calls[0][0] as GenesisCycleRecord;
    expect(record.outcome).toBe('no-change');
  });

  it('outcome is error when context.error is set', () => {
    const ctx = makeHistoryCtx({
      error: 'something went wrong',
      proposalJson: JSON.stringify(makeProposal()),
    });
    genesisUpdateHistory(ctx);
    const record = mockAppendCycle.mock.calls[0][0] as GenesisCycleRecord;
    expect(record.outcome).toBe('error');
    expect(record.error).toBe('something went wrong');
  });

  it('calls saveFingerprint when fingerprintJson is present', () => {
    const ctx = makeHistoryCtx({
      approved: true,
      proposalJson: JSON.stringify(makeProposal()),
      applyResultJson: JSON.stringify({ applied: 1, failed: 0, errors: [] }),
    });
    genesisUpdateHistory(ctx);
    expect(mockSaveFingerprint).toHaveBeenCalledOnce();
  });

  it('does not call saveFingerprint when fingerprintJson is absent', () => {
    const ctx = makeHistoryCtx({ fingerprintJson: undefined });
    genesisUpdateHistory(ctx);
    expect(mockSaveFingerprint).not.toHaveBeenCalled();
  });

  it('sets cycleRecordJson on the output context', () => {
    const ctx = makeHistoryCtx({ proposalJson: undefined });
    const result = genesisUpdateHistory(ctx);
    const outCtx = JSON.parse(result.ctx) as GenesisContext;
    expect(outCtx.cycleRecordJson).toBeDefined();
    const record = JSON.parse(outCtx.cycleRecordJson!) as GenesisCycleRecord;
    expect(record.id).toBe('test-cycle-1');
  });

  it('passes projectDir to GenesisStore constructor', () => {
    genesisUpdateHistory(makeHistoryCtx());
    expect(MockGenesisStore).toHaveBeenCalledWith('/test');
  });

  it('logs error but does not throw when store throws', () => {
    mockAppendCycle.mockImplementationOnce(() => { throw new Error('disk full'); });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => genesisUpdateHistory(makeHistoryCtx())).not.toThrow();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('disk full'));
  });
});

// ── genesisSnapshot ───────────────────────────────────────────────────────────

describe('genesisSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockedReadFileSync.mockReturnValue('export function myWorkflow() {}' as any);
    mockSaveSnapshot.mockReturnValue('/test/.genesis/snapshots/snap-cycle-1.ts');
  });

  it('reads the target workflow file', () => {
    genesisSnapshot(makeSnapshotCtx());
    expect(mockedReadFileSync).toHaveBeenCalledWith(
      expect.stringContaining('workflow.ts'),
      'utf-8',
    );
  });

  it('calls saveSnapshot with cycleId and file content', () => {
    const content = '/** @flowWeaver workflow */ export function wf() {}';
    mockedReadFileSync.mockReturnValue(content as any);

    genesisSnapshot(makeSnapshotCtx());

    expect(mockSaveSnapshot).toHaveBeenCalledWith('snap-cycle-1', content);
  });

  it('sets snapshotPath in output context from saveSnapshot return value', () => {
    const snapshotPath = '/test/.genesis/snapshots/snap-cycle-1.ts';
    mockSaveSnapshot.mockReturnValue(snapshotPath);

    const result = genesisSnapshot(makeSnapshotCtx());
    const outCtx = JSON.parse(result.ctx) as GenesisContext;
    expect(outCtx.snapshotPath).toBe(snapshotPath);
  });

  it('passes projectDir to GenesisStore constructor', () => {
    genesisSnapshot(makeSnapshotCtx());
    expect(MockGenesisStore).toHaveBeenCalledWith('/test');
  });

  it('preserves existing context fields when setting snapshotPath', () => {
    const result = genesisSnapshot(makeSnapshotCtx());
    const outCtx = JSON.parse(result.ctx) as GenesisContext;
    expect(outCtx.env.projectDir).toBe('/test');
    expect(outCtx.cycleId).toBe('snap-cycle-1');
  });

  it('resolves target path relative to projectDir', () => {
    genesisSnapshot(makeSnapshotCtx());
    const [calledPath] = mockedReadFileSync.mock.calls[0];
    expect(String(calledPath)).toMatch(/^\/test\//);
    expect(String(calledPath)).toContain('workflow.ts');
  });
});
