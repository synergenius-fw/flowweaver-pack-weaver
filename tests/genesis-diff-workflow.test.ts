import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GenesisConfig, GenesisContext } from '../src/bot/types.js';

const { mockExecFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFileSync: mockExecFileSync };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, readFileSync: vi.fn() };
});

import * as fs from 'node:fs';
import { genesisDiffWorkflow } from '../src/node-types/genesis-diff-workflow.js';

const mockReadFileSync = vi.mocked(fs.readFileSync);

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
    snapshotPath: '/proj/.genesis/snapshots/snap-001.ts',
    ...overrides,
  };
  return JSON.stringify(ctx);
}

describe('genesisDiffWorkflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  describe('semantic diff succeeds', () => {
    it('uses flow-weaver diff output as workflowDiffJson', () => {
      mockExecFileSync.mockReturnValue('+ added node\n- removed node\n' as any);

      const result = genesisDiffWorkflow(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      const diff = JSON.parse(ctx.workflowDiffJson!);

      expect(diff.diff).toContain('added node');
      expect(diff.diff).toContain('removed node');
    });

    it('trims whitespace from diff output', () => {
      mockExecFileSync.mockReturnValue('  trimmed output  \n' as any);

      const result = genesisDiffWorkflow(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      const diff = JSON.parse(ctx.workflowDiffJson!);

      expect(diff.diff).toBe('trimmed output');
    });
  });

  describe('semantic diff throws with stdout', () => {
    it('uses stdout from error as diff output', () => {
      mockExecFileSync.mockImplementation(() => {
        const err = new Error('exit 1') as any;
        err.stdout = 'partial diff output';
        throw err;
      });

      const result = genesisDiffWorkflow(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      const diff = JSON.parse(ctx.workflowDiffJson!);

      expect(diff.diff).toBe('partial diff output');
    });

    it('trims stdout from error', () => {
      mockExecFileSync.mockImplementation(() => {
        const err = new Error('exit 1') as any;
        err.stdout = '  diff with spaces  ';
        throw err;
      });

      const result = genesisDiffWorkflow(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      const diff = JSON.parse(ctx.workflowDiffJson!);

      expect(diff.diff).toBe('diff with spaces');
    });
  });

  describe('semantic diff fails without stdout — fallback to file comparison', () => {
    it('returns (no changes) when files are identical', () => {
      // flow-weaver throws with no stdout → falls back
      mockExecFileSync.mockImplementation(() => { throw new Error('spawn failed'); });
      mockReadFileSync
        .mockReturnValueOnce('same content' as any)
        .mockReturnValueOnce('same content' as any);

      const result = genesisDiffWorkflow(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      const diff = JSON.parse(ctx.workflowDiffJson!);

      expect(diff.diff).toBe('(no changes)');
    });

    it('calls git diff when files differ', () => {
      mockExecFileSync
        .mockImplementationOnce(() => { throw new Error('spawn failed'); })  // flow-weaver fails
        .mockReturnValueOnce('git diff output' as any);                       // git diff succeeds

      mockReadFileSync
        .mockReturnValueOnce('old content' as any)
        .mockReturnValueOnce('new content' as any);

      const result = genesisDiffWorkflow(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      const diff = JSON.parse(ctx.workflowDiffJson!);

      expect(diff.diff).toBe('git diff output');

      const gitCall = mockExecFileSync.mock.calls.find(
        (c) => c[0] === 'git' && Array.isArray(c[1]) && (c[1] as string[]).includes('--no-index'),
      );
      expect(gitCall).toBeDefined();
    });

    it('uses stdout from git diff error (exit code 1 = files differ)', () => {
      mockExecFileSync
        .mockImplementationOnce(() => { throw new Error('spawn failed'); })  // flow-weaver fails
        .mockImplementationOnce(() => {
          const err = new Error('git diff exit 1') as any;
          err.stdout = '--- a\n+++ b\n+new line';
          throw err;
        });

      mockReadFileSync
        .mockReturnValueOnce('old content' as any)
        .mockReturnValueOnce('new content' as any);

      const result = genesisDiffWorkflow(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      const diff = JSON.parse(ctx.workflowDiffJson!);

      expect(diff.diff).toBe('--- a\n+++ b\n+new line');
    });
  });

  describe('all diff methods fail', () => {
    it('returns (diff unavailable) when no stdout and readFileSync fails', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('spawn failed'); });
      mockReadFileSync.mockImplementation(() => { throw new Error('file not found'); });

      const result = genesisDiffWorkflow(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      const diff = JSON.parse(ctx.workflowDiffJson!);

      expect(diff.diff).toBe('(diff unavailable)');
    });

    it('returns (diff unavailable) when git diff also throws with no stdout', () => {
      mockExecFileSync
        .mockImplementationOnce(() => { throw new Error('spawn failed'); })
        .mockImplementationOnce(() => { throw new Error('git not found'); });

      mockReadFileSync
        .mockReturnValueOnce('old' as any)
        .mockReturnValueOnce('new' as any);

      const result = genesisDiffWorkflow(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      const diff = JSON.parse(ctx.workflowDiffJson!);

      expect(diff.diff).toBe('(diff unavailable)');
    });
  });

  describe('output ctx shape', () => {
    it('always sets workflowDiffJson on ctx', () => {
      mockExecFileSync.mockReturnValue('some diff' as any);

      const result = genesisDiffWorkflow(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;

      expect(ctx.workflowDiffJson).toBeDefined();
      expect(() => JSON.parse(ctx.workflowDiffJson!)).not.toThrow();
    });

    it('preserves other ctx fields', () => {
      mockExecFileSync.mockReturnValue('diff' as any);

      const result = genesisDiffWorkflow(makeCtx({ cycleId: 'cycle-xyz' }));
      const ctx = JSON.parse(result.ctx) as GenesisContext;

      expect(ctx.cycleId).toBe('cycle-xyz');
    });

    it('logs diff line count', () => {
      mockExecFileSync.mockReturnValue('line1\nline2\nline3' as any);

      genesisDiffWorkflow(makeCtx());

      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('lines'),
      );
    });

    it('workflowDiffJson is valid JSON when semantic diff throws', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('fail'); });
      mockReadFileSync.mockImplementation(() => { throw new Error('no file'); });

      const result = genesisDiffWorkflow(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(() => JSON.parse(ctx.workflowDiffJson!)).not.toThrow();
    });

    it('workflowDiffJson.diff is a string in all cases', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('fail'); });
      mockReadFileSync.mockImplementation(() => { throw new Error('no file'); });

      const result = genesisDiffWorkflow(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      const diff = JSON.parse(ctx.workflowDiffJson!);
      expect(typeof diff.diff).toBe('string');
    });

    it('preserves env.projectDir in output ctx', () => {
      mockExecFileSync.mockReturnValue('diff' as any);

      const result = genesisDiffWorkflow(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.env.projectDir).toBe('/proj');
    });

    it('return value has only ctx key', () => {
      mockExecFileSync.mockReturnValue('diff' as any);

      const result = genesisDiffWorkflow(makeCtx());
      expect(Object.keys(result)).toEqual(['ctx']);
    });
  });

  describe('missing snapshotPath', () => {
    it('skips fallback and returns (diff unavailable) when snapshotPath is undefined', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('fail'); });

      const result = genesisDiffWorkflow(makeCtx({ snapshotPath: undefined }));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      const diff = JSON.parse(ctx.workflowDiffJson!);
      expect(diff.diff).toBe('(diff unavailable)');
      // readFileSync should not be called since snapshotPath is missing
      expect(mockReadFileSync).not.toHaveBeenCalled();
    });
  });

  describe('flow-weaver diff call arguments', () => {
    it('calls flow-weaver diff with snapshotPath and targetPath', () => {
      mockExecFileSync.mockReturnValue('diff output' as any);

      genesisDiffWorkflow(makeCtx());

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'flow-weaver',
        ['diff', '/proj/.genesis/snapshots/snap-001.ts', '/proj/src/workflows/my-workflow.ts'],
        expect.objectContaining({ cwd: '/proj' }),
      );
    });
  });
});
