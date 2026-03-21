import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GenesisContext, GenesisFingerprint, GenesisConfig } from '../src/bot/types.js';

// ── Mock GenesisStore ─────────────────────────────────────────────────────────

const { mockGetLastFingerprint, MockGenesisStore } = vi.hoisted(() => {
  const mockGetLastFingerprint = vi.fn<() => GenesisFingerprint | null>().mockReturnValue(null);
  const MockGenesisStore = vi.fn(function (
    this: { getLastFingerprint: typeof mockGetLastFingerprint },
  ) {
    this.getLastFingerprint = mockGetLastFingerprint;
  });
  return { mockGetLastFingerprint, MockGenesisStore };
});

vi.mock('../src/bot/genesis-store.js', () => ({
  GenesisStore: MockGenesisStore,
}));

// ── Mock execFileSync + fs.readFileSync for genesisDiffWorkflow ───────────────

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFileSync: vi.fn() };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, readFileSync: vi.fn() };
});

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { genesisDiffFingerprint } from '../src/node-types/genesis-diff-fingerprint.js';
import { genesisDiffWorkflow } from '../src/node-types/genesis-diff-workflow.js';

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedReadFileSync = vi.mocked(fs.readFileSync);

// ── helpers ───────────────────────────────────────────────────────────────────

const BASE_ENV = {
  projectDir: '/test',
  config: { provider: 'auto' as const },
  providerType: 'anthropic' as const,
  providerInfo: { type: 'anthropic' as const, apiKey: 'key' },
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

function makeDiffFpCtx(fingerprint: GenesisFingerprint): string {
  const ctx: GenesisContext = {
    env: BASE_ENV,
    genesisConfigJson: JSON.stringify({ targetWorkflow: 'workflow.ts' }),
    cycleId: 'test-cycle',
    fingerprintJson: JSON.stringify(fingerprint),
  };
  return JSON.stringify(ctx);
}

function makeDiffWfCtx(overrides: Partial<GenesisContext> = {}): string {
  const config: GenesisConfig = {
    intent: 'test',
    focus: [],
    constraints: [],
    approvalThreshold: 'MINOR',
    budgetPerCycle: 3,
    stabilize: false,
    targetWorkflow: 'workflow.ts',
  };
  return JSON.stringify({
    env: BASE_ENV,
    genesisConfigJson: JSON.stringify(config),
    cycleId: 'test-cycle',
    ...overrides,
  } as GenesisContext);
}

// ── genesisDiffFingerprint ────────────────────────────────────────────────────

describe('genesisDiffFingerprint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGetLastFingerprint.mockReturnValue(null);
  });

  it('no previous fingerprint: all current files are addedFiles, gitChanged and workflowsChanged are true', () => {
    const fp = makeFingerprint({ files: { 'foo.ts': 'hash-a', 'bar.ts': 'hash-b' } });
    mockGetLastFingerprint.mockReturnValue(null);

    const result = genesisDiffFingerprint(makeDiffFpCtx(fp));
    const diff = JSON.parse(JSON.parse(result.ctx).diffJson!);

    expect(diff.addedFiles).toEqual(expect.arrayContaining(['foo.ts', 'bar.ts']));
    expect(diff.removedFiles).toEqual([]);
    expect(diff.modifiedFiles).toEqual([]);
    expect(diff.gitChanged).toBe(true);
    expect(diff.workflowsChanged).toBe(true);
  });

  it('new files detected when file appears in current but not in last', () => {
    const last = makeFingerprint({ files: { 'old.ts': 'hash-old' } });
    const current = makeFingerprint({ files: { 'old.ts': 'hash-old', 'new.ts': 'hash-new' } });
    mockGetLastFingerprint.mockReturnValue(last);

    const diff = JSON.parse(JSON.parse(genesisDiffFingerprint(makeDiffFpCtx(current)).ctx).diffJson!);

    expect(diff.addedFiles).toContain('new.ts');
    expect(diff.addedFiles).not.toContain('old.ts');
    expect(diff.removedFiles).toEqual([]);
    expect(diff.modifiedFiles).toEqual([]);
  });

  it('changed files detected when file hash differs from last', () => {
    const last = makeFingerprint({ files: { 'foo.ts': 'hash-old' } });
    const current = makeFingerprint({ files: { 'foo.ts': 'hash-new' } });
    mockGetLastFingerprint.mockReturnValue(last);

    const diff = JSON.parse(JSON.parse(genesisDiffFingerprint(makeDiffFpCtx(current)).ctx).diffJson!);

    expect(diff.modifiedFiles).toContain('foo.ts');
    expect(diff.addedFiles).toEqual([]);
    expect(diff.removedFiles).toEqual([]);
  });

  it('deleted files detected when file present in last but missing in current', () => {
    const last = makeFingerprint({ files: { 'foo.ts': 'hash-a', 'deleted.ts': 'hash-d' } });
    const current = makeFingerprint({ files: { 'foo.ts': 'hash-a' } });
    mockGetLastFingerprint.mockReturnValue(last);

    const diff = JSON.parse(JSON.parse(genesisDiffFingerprint(makeDiffFpCtx(current)).ctx).diffJson!);

    expect(diff.removedFiles).toContain('deleted.ts');
    expect(diff.addedFiles).toEqual([]);
    expect(diff.modifiedFiles).toEqual([]);
  });

  it('gitChanged=true when gitBranch differs between current and last', () => {
    const last = makeFingerprint({ gitBranch: 'main', gitCommit: 'abc' });
    const current = makeFingerprint({ gitBranch: 'feature', gitCommit: 'abc', workflowHash: 'wh1', existingWorkflows: [] });
    mockGetLastFingerprint.mockReturnValue(last);

    const diff = JSON.parse(JSON.parse(genesisDiffFingerprint(makeDiffFpCtx(current)).ctx).diffJson!);

    expect(diff.gitChanged).toBe(true);
  });

  it('gitChanged=false when branch and commit are identical', () => {
    const last = makeFingerprint({ gitBranch: 'main', gitCommit: 'abc', workflowHash: 'wh1', existingWorkflows: [] });
    const current = makeFingerprint({ gitBranch: 'main', gitCommit: 'abc', workflowHash: 'wh1', existingWorkflows: [] });
    mockGetLastFingerprint.mockReturnValue(last);

    const diff = JSON.parse(JSON.parse(genesisDiffFingerprint(makeDiffFpCtx(current)).ctx).diffJson!);

    expect(diff.gitChanged).toBe(false);
  });

  it('workflowsChanged=true when workflowHash differs', () => {
    const last = makeFingerprint({ workflowHash: 'hash-old', existingWorkflows: [], gitBranch: 'main', gitCommit: 'abc' });
    const current = makeFingerprint({ workflowHash: 'hash-new', existingWorkflows: [], gitBranch: 'main', gitCommit: 'abc' });
    mockGetLastFingerprint.mockReturnValue(last);

    const diff = JSON.parse(JSON.parse(genesisDiffFingerprint(makeDiffFpCtx(current)).ctx).diffJson!);

    expect(diff.workflowsChanged).toBe(true);
  });

  it('workflowsChanged=false when workflowHash and existingWorkflows are identical', () => {
    const last = makeFingerprint({ workflowHash: 'wh1', existingWorkflows: ['a.ts', 'b.ts'], gitBranch: 'main', gitCommit: 'abc' });
    const current = makeFingerprint({ workflowHash: 'wh1', existingWorkflows: ['b.ts', 'a.ts'], gitBranch: 'main', gitCommit: 'abc' });
    mockGetLastFingerprint.mockReturnValue(last);

    const diff = JSON.parse(JSON.parse(genesisDiffFingerprint(makeDiffFpCtx(current)).ctx).diffJson!);

    expect(diff.workflowsChanged).toBe(false);
  });

  it('passes projectDir to GenesisStore constructor', () => {
    genesisDiffFingerprint(makeDiffFpCtx(makeFingerprint()));
    expect(MockGenesisStore).toHaveBeenCalledWith('/test');
  });
});

// ── genesisDiffWorkflow ───────────────────────────────────────────────────────

describe('genesisDiffWorkflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockedExecFileSync.mockImplementation(() => { throw new Error('not found'); });
  });

  it('no snapshotPath → workflowDiffJson.diff is (diff unavailable)', () => {
    const result = genesisDiffWorkflow(makeDiffWfCtx());
    const wdj = JSON.parse(JSON.parse(result.ctx).workflowDiffJson!);
    expect(wdj.diff).toBe('(diff unavailable)');
  });

  it('snapshotPath set but all fallbacks fail → (diff unavailable)', () => {
    mockedReadFileSync.mockImplementation(() => { throw new Error('file not found'); });

    const result = genesisDiffWorkflow(makeDiffWfCtx({ snapshotPath: '/tmp/snapshot.ts' }));
    const wdj = JSON.parse(JSON.parse(result.ctx).workflowDiffJson!);
    expect(wdj.diff).toBe('(diff unavailable)');
  });

  it('returns (no changes) when snapshot and target file content are identical', () => {
    const content = 'export function myWorkflow() {}';
    // flow-weaver diff throws, readFileSync returns identical content for both files
    mockedReadFileSync.mockReturnValue(content as any);

    const result = genesisDiffWorkflow(makeDiffWfCtx({ snapshotPath: '/tmp/snapshot.ts' }));
    const wdj = JSON.parse(JSON.parse(result.ctx).workflowDiffJson!);
    expect(wdj.diff).toBe('(no changes)');
  });

  it('uses flow-weaver diff output when it succeeds', () => {
    mockedExecFileSync.mockReturnValueOnce('+ added line\n- removed line\n' as any);

    const result = genesisDiffWorkflow(makeDiffWfCtx({ snapshotPath: '/tmp/snapshot.ts' }));
    const wdj = JSON.parse(JSON.parse(result.ctx).workflowDiffJson!);
    expect(wdj.diff).toBe('+ added line\n- removed line');
  });

  it('uses stdout from flow-weaver error when diff exits non-zero', () => {
    const err = Object.assign(new Error('exit 1'), { stdout: 'diff output from stderr\n' });
    mockedExecFileSync.mockImplementationOnce(() => { throw err; });

    const result = genesisDiffWorkflow(makeDiffWfCtx({ snapshotPath: '/tmp/snapshot.ts' }));
    const wdj = JSON.parse(JSON.parse(result.ctx).workflowDiffJson!);
    expect(wdj.diff).toBe('diff output from stderr');
  });

  it('sets workflowDiffJson with a diff property on the output context', () => {
    const result = genesisDiffWorkflow(makeDiffWfCtx());
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(ctx.workflowDiffJson).toBeDefined();
    expect(JSON.parse(ctx.workflowDiffJson!)).toHaveProperty('diff');
  });

  it('preserves the rest of the context when setting workflowDiffJson', () => {
    const result = genesisDiffWorkflow(makeDiffWfCtx());
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(ctx.env.projectDir).toBe('/test');
    expect(ctx.cycleId).toBe('test-cycle');
  });
});
