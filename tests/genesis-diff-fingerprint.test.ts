import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GenesisContext, GenesisFingerprint, WeaverEnv } from '../src/bot/types.js';

const { mockGetLastFingerprint } = vi.hoisted(() => ({
  mockGetLastFingerprint: vi.fn<() => GenesisFingerprint | null>(),
}));

vi.mock('../src/bot/genesis-store.js', () => ({
  GenesisStore: class {
    getLastFingerprint() {
      return mockGetLastFingerprint();
    }
  },
}));

import { genesisDiffFingerprint } from '../src/node-types/genesis-diff-fingerprint.js';

const BASE_ENV: WeaverEnv = {
  projectDir: '/proj',
  config: { provider: 'auto' as const },
  providerType: 'anthropic' as const,
  providerInfo: { type: 'anthropic' as const, apiKey: 'key' },
};

function makeFingerprint(overrides: Partial<GenesisFingerprint> = {}): GenesisFingerprint {
  return {
    timestamp: '2024-01-01T00:00:00Z',
    files: { 'src/workflow.ts': 'abc123' },
    packageJson: null,
    gitBranch: 'main',
    gitCommit: 'abc',
    workflowHash: 'wh1',
    existingWorkflows: ['src/workflow.ts'],
    ...overrides,
  };
}

function makeCtx(fingerprint: GenesisFingerprint): string {
  const ctx: GenesisContext = {
    env: BASE_ENV,
    genesisConfigJson: JSON.stringify({ stabilize: false, targetWorkflow: 'workflow.ts' }),
    cycleId: 'cycle-1',
    fingerprintJson: JSON.stringify(fingerprint),
  };
  return JSON.stringify(ctx);
}

describe('genesisDiffFingerprint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  describe('no previous fingerprint (first run)', () => {
    it('sets all current files as addedFiles when no last fingerprint', () => {
      mockGetLastFingerprint.mockReturnValue(null);
      const fp = makeFingerprint({ files: { 'a.ts': 'h1', 'b.ts': 'h2' } });

      const result = genesisDiffFingerprint(makeCtx(fp));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      const diff = JSON.parse(ctx.diffJson!);

      expect(diff.addedFiles).toEqual(expect.arrayContaining(['a.ts', 'b.ts']));
      expect(diff.addedFiles).toHaveLength(2);
    });

    it('sets removedFiles to empty array when no last fingerprint', () => {
      mockGetLastFingerprint.mockReturnValue(null);

      const result = genesisDiffFingerprint(makeCtx(makeFingerprint()));
      const diff = JSON.parse(JSON.parse(result.ctx).diffJson!);
      expect(diff.removedFiles).toEqual([]);
    });

    it('sets modifiedFiles to empty array when no last fingerprint', () => {
      mockGetLastFingerprint.mockReturnValue(null);

      const result = genesisDiffFingerprint(makeCtx(makeFingerprint()));
      const diff = JSON.parse(JSON.parse(result.ctx).diffJson!);
      expect(diff.modifiedFiles).toEqual([]);
    });

    it('sets gitChanged=true when no last fingerprint', () => {
      mockGetLastFingerprint.mockReturnValue(null);

      const result = genesisDiffFingerprint(makeCtx(makeFingerprint()));
      const diff = JSON.parse(JSON.parse(result.ctx).diffJson!);
      expect(diff.gitChanged).toBe(true);
    });

    it('sets workflowsChanged=true when no last fingerprint', () => {
      mockGetLastFingerprint.mockReturnValue(null);

      const result = genesisDiffFingerprint(makeCtx(makeFingerprint()));
      const diff = JSON.parse(JSON.parse(result.ctx).diffJson!);
      expect(diff.workflowsChanged).toBe(true);
    });
  });

  describe('no changes since last fingerprint', () => {
    it('returns empty addedFiles, removedFiles, modifiedFiles', () => {
      const fp = makeFingerprint();
      mockGetLastFingerprint.mockReturnValue(fp);

      const result = genesisDiffFingerprint(makeCtx(fp));
      const diff = JSON.parse(JSON.parse(result.ctx).diffJson!);

      expect(diff.addedFiles).toEqual([]);
      expect(diff.removedFiles).toEqual([]);
      expect(diff.modifiedFiles).toEqual([]);
    });

    it('returns gitChanged=false when branch and commit are identical', () => {
      const fp = makeFingerprint({ gitBranch: 'main', gitCommit: 'abc' });
      mockGetLastFingerprint.mockReturnValue(fp);

      const result = genesisDiffFingerprint(makeCtx(fp));
      const diff = JSON.parse(JSON.parse(result.ctx).diffJson!);
      expect(diff.gitChanged).toBe(false);
    });

    it('returns workflowsChanged=false when workflows and hash are identical', () => {
      const fp = makeFingerprint({ existingWorkflows: ['wf.ts'], workflowHash: 'wh1' });
      mockGetLastFingerprint.mockReturnValue(fp);

      const result = genesisDiffFingerprint(makeCtx(fp));
      const diff = JSON.parse(JSON.parse(result.ctx).diffJson!);
      expect(diff.workflowsChanged).toBe(false);
    });
  });

  describe('file additions', () => {
    it('detects new files as addedFiles', () => {
      const last = makeFingerprint({ files: { 'a.ts': 'h1' } });
      const current = makeFingerprint({ files: { 'a.ts': 'h1', 'b.ts': 'h2' } });
      mockGetLastFingerprint.mockReturnValue(last);

      const result = genesisDiffFingerprint(makeCtx(current));
      const diff = JSON.parse(JSON.parse(result.ctx).diffJson!);
      expect(diff.addedFiles).toContain('b.ts');
      expect(diff.addedFiles).toHaveLength(1);
    });
  });

  describe('file removals', () => {
    it('detects removed files as removedFiles', () => {
      const last = makeFingerprint({ files: { 'a.ts': 'h1', 'b.ts': 'h2' } });
      const current = makeFingerprint({ files: { 'a.ts': 'h1' } });
      mockGetLastFingerprint.mockReturnValue(last);

      const result = genesisDiffFingerprint(makeCtx(current));
      const diff = JSON.parse(JSON.parse(result.ctx).diffJson!);
      expect(diff.removedFiles).toContain('b.ts');
      expect(diff.removedFiles).toHaveLength(1);
    });
  });

  describe('file modifications', () => {
    it('detects changed hash as modifiedFiles', () => {
      const last = makeFingerprint({ files: { 'a.ts': 'old-hash' } });
      const current = makeFingerprint({ files: { 'a.ts': 'new-hash' } });
      mockGetLastFingerprint.mockReturnValue(last);

      const result = genesisDiffFingerprint(makeCtx(current));
      const diff = JSON.parse(JSON.parse(result.ctx).diffJson!);
      expect(diff.modifiedFiles).toContain('a.ts');
    });

    it('does not include unchanged files in modifiedFiles', () => {
      const fp = makeFingerprint({ files: { 'a.ts': 'same', 'b.ts': 'changed' } });
      const last = makeFingerprint({ files: { 'a.ts': 'same', 'b.ts': 'old' } });
      mockGetLastFingerprint.mockReturnValue(last);

      const result = genesisDiffFingerprint(makeCtx(fp));
      const diff = JSON.parse(JSON.parse(result.ctx).diffJson!);
      expect(diff.modifiedFiles).not.toContain('a.ts');
      expect(diff.modifiedFiles).toContain('b.ts');
    });
  });

  describe('git changes', () => {
    it('sets gitChanged=true when branch changes', () => {
      const last = makeFingerprint({ gitBranch: 'main', gitCommit: 'abc' });
      const current = makeFingerprint({ gitBranch: 'feature', gitCommit: 'abc' });
      mockGetLastFingerprint.mockReturnValue(last);

      const result = genesisDiffFingerprint(makeCtx(current));
      const diff = JSON.parse(JSON.parse(result.ctx).diffJson!);
      expect(diff.gitChanged).toBe(true);
    });

    it('sets gitChanged=true when commit changes', () => {
      const last = makeFingerprint({ gitBranch: 'main', gitCommit: 'abc' });
      const current = makeFingerprint({ gitBranch: 'main', gitCommit: 'def' });
      mockGetLastFingerprint.mockReturnValue(last);

      const result = genesisDiffFingerprint(makeCtx(current));
      const diff = JSON.parse(JSON.parse(result.ctx).diffJson!);
      expect(diff.gitChanged).toBe(true);
    });
  });

  describe('workflow changes', () => {
    it('sets workflowsChanged=true when workflowHash differs', () => {
      const last = makeFingerprint({ workflowHash: 'old', existingWorkflows: ['wf.ts'] });
      const current = makeFingerprint({ workflowHash: 'new', existingWorkflows: ['wf.ts'] });
      mockGetLastFingerprint.mockReturnValue(last);

      const result = genesisDiffFingerprint(makeCtx(current));
      const diff = JSON.parse(JSON.parse(result.ctx).diffJson!);
      expect(diff.workflowsChanged).toBe(true);
    });

    it('sets workflowsChanged=true when existingWorkflows list changes', () => {
      const last = makeFingerprint({ workflowHash: 'wh1', existingWorkflows: ['wf-a.ts'] });
      const current = makeFingerprint({ workflowHash: 'wh1', existingWorkflows: ['wf-a.ts', 'wf-b.ts'] });
      mockGetLastFingerprint.mockReturnValue(last);

      const result = genesisDiffFingerprint(makeCtx(current));
      const diff = JSON.parse(JSON.parse(result.ctx).diffJson!);
      expect(diff.workflowsChanged).toBe(true);
    });

    it('sets workflowsChanged=false regardless of existingWorkflows order', () => {
      const last = makeFingerprint({ workflowHash: 'wh1', existingWorkflows: ['b.ts', 'a.ts'] });
      const current = makeFingerprint({ workflowHash: 'wh1', existingWorkflows: ['a.ts', 'b.ts'] });
      mockGetLastFingerprint.mockReturnValue(last);

      const result = genesisDiffFingerprint(makeCtx(current));
      const diff = JSON.parse(JSON.parse(result.ctx).diffJson!);
      expect(diff.workflowsChanged).toBe(false);
    });
  });

  describe('logging', () => {
    it('logs diff summary line', () => {
      const fp = makeFingerprint();
      mockGetLastFingerprint.mockReturnValue(fp);

      genesisDiffFingerprint(makeCtx(fp));
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('Diff:'),
      );
    });
  });

  describe('ctx pass-through', () => {
    it('returns a valid JSON string as ctx', () => {
      mockGetLastFingerprint.mockReturnValue(null);

      const result = genesisDiffFingerprint(makeCtx(makeFingerprint()));
      expect(() => JSON.parse(result.ctx)).not.toThrow();
    });

    it('sets diffJson on ctx', () => {
      mockGetLastFingerprint.mockReturnValue(null);

      const result = genesisDiffFingerprint(makeCtx(makeFingerprint()));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.diffJson).toBeDefined();
    });

    it('preserves env in output ctx', () => {
      mockGetLastFingerprint.mockReturnValue(null);

      const result = genesisDiffFingerprint(makeCtx(makeFingerprint()));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.env.projectDir).toBe('/proj');
    });

    it('returns object with only ctx key', () => {
      mockGetLastFingerprint.mockReturnValue(null);

      const result = genesisDiffFingerprint(makeCtx(makeFingerprint()));
      expect(Object.keys(result)).toEqual(['ctx']);
    });
  });
});
