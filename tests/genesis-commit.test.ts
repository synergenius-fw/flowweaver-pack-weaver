import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import type { GenesisContext } from '../src/bot/types.js';

// Hoist mock instances before vi.mock factories execute
const mockLoadSnapshot = vi.hoisted(() => vi.fn().mockReturnValue('// snapshot content'));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFileSync: vi.fn() };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, writeFileSync: vi.fn() };
});

vi.mock('../src/bot/genesis-store.js', () => ({
  GenesisStore: vi.fn().mockImplementation(function () {
    return { loadSnapshot: mockLoadSnapshot };
  }),
}));

import { genesisCommit } from '../src/node-types/genesis-commit.js';

const mockedExecFileSync = vi.mocked(child_process.execFileSync);
const mockedWriteFileSync = vi.mocked(fs.writeFileSync);

// ─── helpers ──────────────────────────────────────────────────────────────────

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
      targetWorkflow: 'src/workflows/weaver-bot.ts',
      maxCyclesPerRun: 3,
    }),
    cycleId: 'cycle-99',
    snapshotPath: '/project/.genesis/snapshots/snap-1.ts',
  };
  return JSON.stringify({ ...base, ...overrides });
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('genesisCommit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('dry run (execute=false) returns committed=false without touching git or fs', async () => {
    const result = await genesisCommit(false, makeCtx({ approved: true }));

    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);

    const ctx = JSON.parse(result.ctx) as GenesisContext;
    const commit = JSON.parse(ctx.commitResultJson!);
    expect(commit.committed).toBe(false);
    expect(commit.reason).toBe('dry run');

    expect(mockedExecFileSync).not.toHaveBeenCalled();
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it('not approved: restores snapshot from disk and returns onSuccess=false', async () => {
    const result = await genesisCommit(true, makeCtx({ approved: false }));

    expect(result.onSuccess).toBe(false);
    expect(result.onFailure).toBe(true);

    // Snapshot loaded and written back to targetPath
    expect(mockLoadSnapshot).toHaveBeenCalledWith('/project/.genesis/snapshots/snap-1.ts');
    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      '/project/src/workflows/weaver-bot.ts',
      '// snapshot content',
      'utf-8',
    );

    const ctx = JSON.parse(result.ctx) as GenesisContext;
    const commit = JSON.parse(ctx.commitResultJson!);
    expect(commit.committed).toBe(false);
    expect(commit.reason).toBe('not approved');

    // No git calls
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('not approved: skips writeFileSync when snapshot is null', async () => {
    mockLoadSnapshot.mockReturnValueOnce(null);

    const result = await genesisCommit(true, makeCtx({ approved: false }));

    expect(result.onSuccess).toBe(false);
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it('approved: calls git add then git commit with genesis: message', async () => {
    mockedExecFileSync.mockReturnValue('' as any); // both git calls succeed

    const result = await genesisCommit(true, makeCtx({ approved: true }));

    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);

    // git add called with full target path
    expect(mockedExecFileSync).toHaveBeenNthCalledWith(
      1,
      'git',
      ['add', '/project/src/workflows/weaver-bot.ts'],
      expect.objectContaining({ cwd: '/project' }),
    );

    // git commit called with genesis: prefix message
    expect(mockedExecFileSync).toHaveBeenNthCalledWith(
      2,
      'git',
      ['commit', '-m', 'genesis: evolve weaver-bot.ts'],
      expect.objectContaining({ cwd: '/project' }),
    );

    const ctx = JSON.parse(result.ctx) as GenesisContext;
    const commit = JSON.parse(ctx.commitResultJson!);
    expect(commit.committed).toBe(true);
    expect(commit.message).toBe('genesis: evolve weaver-bot.ts');
  });

  it('git commit failure returns onFailure=true with error message in commitResultJson', async () => {
    mockedExecFileSync
      .mockReturnValueOnce('' as any)              // git add succeeds
      .mockImplementationOnce(() => { throw new Error('nothing to commit'); }); // git commit fails

    const result = await genesisCommit(true, makeCtx({ approved: true }));

    expect(result.onSuccess).toBe(false);
    expect(result.onFailure).toBe(true);

    const ctx = JSON.parse(result.ctx) as GenesisContext;
    const commit = JSON.parse(ctx.commitResultJson!);
    expect(commit.committed).toBe(false);
    expect(commit.reason).toContain('nothing to commit');
  });

  it('git add failure also returns onFailure=true', async () => {
    mockedExecFileSync.mockImplementationOnce(() => { throw new Error('not a git repo'); });

    const result = await genesisCommit(true, makeCtx({ approved: true }));

    expect(result.onSuccess).toBe(false);
    expect(result.onFailure).toBe(true);

    const ctx = JSON.parse(result.ctx) as GenesisContext;
    const commit = JSON.parse(ctx.commitResultJson!);
    expect(commit.committed).toBe(false);
    expect(commit.reason).toContain('not a git repo');
  });

  it('commit message uses basename of targetWorkflow', async () => {
    mockedExecFileSync.mockReturnValue('' as any);

    // targetWorkflow with a deeper path
    const ctx = makeCtx({ approved: true });
    const parsed = JSON.parse(ctx);
    parsed.genesisConfigJson = JSON.stringify({
      ...JSON.parse(parsed.genesisConfigJson),
      targetWorkflow: 'src/workflows/genesis-task.ts',
    });

    const result = await genesisCommit(true, JSON.stringify(parsed));

    expect(mockedExecFileSync).toHaveBeenNthCalledWith(
      2,
      'git',
      ['commit', '-m', 'genesis: evolve genesis-task.ts'],
      expect.any(Object),
    );

    const outCtx = JSON.parse(result.ctx) as GenesisContext;
    const commit = JSON.parse(outCtx.commitResultJson!);
    expect(commit.message).toBe('genesis: evolve genesis-task.ts');
  });

  it('dry run with approved=false still returns dry run (execute gate wins)', async () => {
    const result = await genesisCommit(false, makeCtx({ approved: false }));
    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    const commit = JSON.parse(ctx.commitResultJson!);
    expect(commit.reason).toBe('dry run');
    expect(mockedExecFileSync).not.toHaveBeenCalled();
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it('approved success: execFileSync called exactly twice', async () => {
    mockedExecFileSync.mockReturnValue('' as any);
    await genesisCommit(true, makeCtx({ approved: true }));
    expect(mockedExecFileSync).toHaveBeenCalledTimes(2);
  });

  it('approved success: loadSnapshot is not called', async () => {
    mockedExecFileSync.mockReturnValue('' as any);
    await genesisCommit(true, makeCtx({ approved: true }));
    expect(mockLoadSnapshot).not.toHaveBeenCalled();
  });

  it('non-Error thrown by git is coerced to string in commitResultJson reason', async () => {
    mockedExecFileSync.mockImplementationOnce(() => { throw 'disk full'; });
    const result = await genesisCommit(true, makeCtx({ approved: true }));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    const commit = JSON.parse(ctx.commitResultJson!);
    expect(commit.reason).toBe('disk full');
  });

  it('commitResultJson is valid JSON on dry run path', async () => {
    const result = await genesisCommit(false, makeCtx({ approved: true }));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(() => JSON.parse(ctx.commitResultJson!)).not.toThrow();
  });

  it('commitResultJson is valid JSON on not-approved path', async () => {
    const result = await genesisCommit(true, makeCtx({ approved: false }));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(() => JSON.parse(ctx.commitResultJson!)).not.toThrow();
  });

  it('commitResultJson is valid JSON on git failure path', async () => {
    mockedExecFileSync.mockImplementationOnce(() => { throw new Error('fail'); });
    const result = await genesisCommit(true, makeCtx({ approved: true }));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(() => JSON.parse(ctx.commitResultJson!)).not.toThrow();
  });

  it('output ctx preserves env.projectDir on approved success', async () => {
    mockedExecFileSync.mockReturnValue('' as any);
    const result = await genesisCommit(true, makeCtx({ approved: true }));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(ctx.env.projectDir).toBe('/project');
  });

  it('output ctx preserves env.projectDir on not-approved path', async () => {
    const result = await genesisCommit(true, makeCtx({ approved: false }));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(ctx.env.projectDir).toBe('/project');
  });

  it('return shape always has onSuccess, onFailure, and ctx keys', async () => {
    mockedExecFileSync.mockReturnValue('' as any);
    const result = await genesisCommit(true, makeCtx({ approved: true }));
    expect(Object.keys(result).sort()).toEqual(['ctx', 'onFailure', 'onSuccess']);
  });
});
