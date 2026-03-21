import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GenesisContext, EscrowToken, WeaverEnv } from '../src/bot/types.js';

const {
  mockEnsureEscrowDirs,
  mockGetEscrowBackupPath,
  mockGetEscrowStagedPath,
  mockSaveEscrowToken,
  mockClearEscrow,
  mockHashFile,
} = vi.hoisted(() => ({
  mockEnsureEscrowDirs: vi.fn(),
  mockGetEscrowBackupPath: vi.fn<(f: string) => string>(),
  mockGetEscrowStagedPath: vi.fn<(f: string) => string>(),
  mockSaveEscrowToken: vi.fn<(t: EscrowToken) => void>(),
  mockClearEscrow: vi.fn(),
  mockHashFile: vi.fn<(p: string) => string>(),
}));

vi.mock('../src/bot/genesis-store.js', () => ({
  GenesisStore: class {
    ensureEscrowDirs() { return mockEnsureEscrowDirs(); }
    getEscrowBackupPath(f: string) { return mockGetEscrowBackupPath(f); }
    getEscrowStagedPath(f: string) { return mockGetEscrowStagedPath(f); }
    saveEscrowToken(t: EscrowToken) { return mockSaveEscrowToken(t); }
    clearEscrow() { return mockClearEscrow(); }
    static hashFile(p: string) { return mockHashFile(p); }
  },
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  copyFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('node:crypto', () => ({
  randomUUID: vi.fn(() => 'test-uuid-1234567890'),
}));

import * as fs from 'node:fs';
import { genesisEscrowStage } from '../src/node-types/genesis-escrow-stage.js';

const BASE_ENV: WeaverEnv = {
  projectDir: '/proj',
  config: { provider: 'auto' as const },
  providerType: 'anthropic' as const,
  providerInfo: { type: 'anthropic' as const, apiKey: 'key' },
};

function makeSelfModifyOp(
  file: string,
  content = 'export function foo() {}',
  type = 'selfModifyNodeType',
) {
  return { type, args: { file, content } };
}

function makeCtx(
  ops: { type: string; args: Record<string, unknown> }[],
  configOverrides: Record<string, unknown> = {},
  ctxOverrides: Partial<GenesisContext> = {},
): string {
  const ctx: GenesisContext = {
    env: BASE_ENV,
    genesisConfigJson: JSON.stringify({
      selfEvolve: true,
      targetWorkflow: 'workflow.ts',
      ...configOverrides,
    }),
    cycleId: 'cycle-1',
    proposalJson: JSON.stringify({ operations: ops }),
    ...ctxOverrides,
  };
  return JSON.stringify(ctx);
}

describe('genesisEscrowStage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(fs.existsSync).mockReturnValue(false);
    mockGetEscrowBackupPath.mockImplementation((f: string) => `/proj/.genesis/backup/${f}`);
    mockGetEscrowStagedPath.mockImplementation((f: string) => `/proj/.genesis/staged/${f}`);
    mockHashFile.mockReturnValue('hash-abc');
  });

  describe('no self-modify operations', () => {
    it('returns onSuccess=true when no self-modify ops', () => {
      const result = genesisEscrowStage(makeCtx([{ type: 'addNode', args: {} }]));
      expect(result.onSuccess).toBe(true);
    });

    it('returns onFailure=false when no self-modify ops', () => {
      const result = genesisEscrowStage(makeCtx([{ type: 'addNode', args: {} }]));
      expect(result.onFailure).toBe(false);
    });

    it('sets hasSelfModifyOps=false when no self-modify ops', () => {
      const result = genesisEscrowStage(makeCtx([{ type: 'addNode', args: {} }]));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.hasSelfModifyOps).toBe(false);
    });

    it('does not call ensureEscrowDirs when no self-modify ops', () => {
      genesisEscrowStage(makeCtx([]));
      expect(mockEnsureEscrowDirs).not.toHaveBeenCalled();
    });

    it('does not call saveEscrowToken when no self-modify ops', () => {
      genesisEscrowStage(makeCtx([]));
      expect(mockSaveEscrowToken).not.toHaveBeenCalled();
    });
  });

  describe('self-modify operations present (file exists)', () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockHashFile
        .mockReturnValueOnce('backup-hash')
        .mockReturnValueOnce('staged-hash');
    });

    it('returns onSuccess=true', () => {
      const result = genesisEscrowStage(makeCtx([makeSelfModifyOp('src/foo.ts')]));
      expect(result.onSuccess).toBe(true);
    });

    it('returns onFailure=false', () => {
      const result = genesisEscrowStage(makeCtx([makeSelfModifyOp('src/foo.ts')]));
      expect(result.onFailure).toBe(false);
    });

    it('sets hasSelfModifyOps=true', () => {
      const result = genesisEscrowStage(makeCtx([makeSelfModifyOp('src/foo.ts')]));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.hasSelfModifyOps).toBe(true);
    });

    it('calls ensureEscrowDirs', () => {
      genesisEscrowStage(makeCtx([makeSelfModifyOp('src/foo.ts')]));
      expect(mockEnsureEscrowDirs).toHaveBeenCalledOnce();
    });

    it('calls saveEscrowToken once', () => {
      genesisEscrowStage(makeCtx([makeSelfModifyOp('src/foo.ts')]));
      expect(mockSaveEscrowToken).toHaveBeenCalledOnce();
    });

    it('saves token with phase=staged', () => {
      genesisEscrowStage(makeCtx([makeSelfModifyOp('src/foo.ts')]));
      const token = mockSaveEscrowToken.mock.calls[0][0] as EscrowToken;
      expect(token.phase).toBe('staged');
    });

    it('saves token with correct cycleId', () => {
      genesisEscrowStage(makeCtx([makeSelfModifyOp('src/foo.ts')]));
      const token = mockSaveEscrowToken.mock.calls[0][0] as EscrowToken;
      expect(token.cycleId).toBe('cycle-1');
    });

    it('saves token with affectedFiles containing the staged file', () => {
      genesisEscrowStage(makeCtx([makeSelfModifyOp('src/foo.ts')]));
      const token = mockSaveEscrowToken.mock.calls[0][0] as EscrowToken;
      expect(token.affectedFiles).toContain('src/foo.ts');
    });

    it('saves token with backupFileHashes entry', () => {
      genesisEscrowStage(makeCtx([makeSelfModifyOp('src/foo.ts')]));
      const token = mockSaveEscrowToken.mock.calls[0][0] as EscrowToken;
      expect(token.backupFileHashes['src/foo.ts']).toBe('backup-hash');
    });

    it('saves token with stagedFileHashes entry', () => {
      genesisEscrowStage(makeCtx([makeSelfModifyOp('src/foo.ts')]));
      const token = mockSaveEscrowToken.mock.calls[0][0] as EscrowToken;
      expect(token.stagedFileHashes['src/foo.ts']).toBe('staged-hash');
    });

    it('copies existing file to backup path', () => {
      genesisEscrowStage(makeCtx([makeSelfModifyOp('src/foo.ts')]));
      expect(vi.mocked(fs.copyFileSync)).toHaveBeenCalledOnce();
    });

    it('writes staged content to staged path', () => {
      genesisEscrowStage(makeCtx([makeSelfModifyOp('src/foo.ts', 'const x = 1;')]));
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
        expect.any(String),
        'const x = 1;',
        'utf-8',
      );
    });

    it('logs staging success message', () => {
      genesisEscrowStage(makeCtx([makeSelfModifyOp('src/foo.ts')]));
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('Escrow staged'),
      );
    });

    it('sets escrowResultJson.staged=true', () => {
      const result = genesisEscrowStage(makeCtx([makeSelfModifyOp('src/foo.ts')]));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      const er = JSON.parse(ctx.escrowResultJson!);
      expect(er.staged).toBe(true);
    });

    it('sets escrowResultJson.files containing the affected file', () => {
      const result = genesisEscrowStage(makeCtx([makeSelfModifyOp('src/foo.ts')]));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      const er = JSON.parse(ctx.escrowResultJson!);
      expect(er.files).toContain('src/foo.ts');
    });

    it('sets selfModifyOpsJson on ctx', () => {
      const result = genesisEscrowStage(makeCtx([makeSelfModifyOp('src/foo.ts')]));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.selfModifyOpsJson).toBeDefined();
    });
  });

  describe('grace period configuration', () => {
    it('uses default grace period of 3 when not configured', () => {
      genesisEscrowStage(makeCtx([makeSelfModifyOp('src/foo.ts')]));
      const token = mockSaveEscrowToken.mock.calls[0][0] as EscrowToken;
      expect(token.graceRemaining).toBe(3);
    });

    it('uses selfEvolveGracePeriod from config when provided', () => {
      genesisEscrowStage(makeCtx([makeSelfModifyOp('src/foo.ts')], { selfEvolveGracePeriod: 5 }));
      const token = mockSaveEscrowToken.mock.calls[0][0] as EscrowToken;
      expect(token.graceRemaining).toBe(5);
    });
  });

  describe('new file (does not exist — no backup)', () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
    });

    it('does not call copyFileSync when file does not exist', () => {
      genesisEscrowStage(makeCtx([makeSelfModifyOp('src/new-file.ts')]));
      expect(vi.mocked(fs.copyFileSync)).not.toHaveBeenCalled();
    });

    it('still calls writeFileSync for staged content', () => {
      genesisEscrowStage(makeCtx([makeSelfModifyOp('src/new-file.ts', 'export {}')]));
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledOnce();
    });

    it('token backupFileHashes has no entry for new file', () => {
      genesisEscrowStage(makeCtx([makeSelfModifyOp('src/new-file.ts')]));
      const token = mockSaveEscrowToken.mock.calls[0][0] as EscrowToken;
      expect(token.backupFileHashes['src/new-file.ts']).toBeUndefined();
    });
  });

  describe('multiple self-modify operations', () => {
    it('stages all files and adds each to affectedFiles', () => {
      const ops = [makeSelfModifyOp('src/a.ts'), makeSelfModifyOp('src/b.ts')];
      genesisEscrowStage(makeCtx(ops));
      const token = mockSaveEscrowToken.mock.calls[0][0] as EscrowToken;
      expect(token.affectedFiles).toHaveLength(2);
      expect(token.affectedFiles).toContain('src/a.ts');
      expect(token.affectedFiles).toContain('src/b.ts');
    });

    it('calls writeFileSync for each file', () => {
      const ops = [makeSelfModifyOp('src/a.ts'), makeSelfModifyOp('src/b.ts')];
      genesisEscrowStage(makeCtx(ops));
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledTimes(2);
    });
  });

  describe('path traversal protection', () => {
    it('does not write staged content for path traversal (..)', () => {
      genesisEscrowStage(makeCtx([makeSelfModifyOp('../evil.ts')]));
      expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled();
    });

    it('does not write staged content for absolute paths', () => {
      genesisEscrowStage(makeCtx([makeSelfModifyOp('/etc/passwd')]));
      expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled();
    });

    it('skipped unsafe path is not added to affectedFiles', () => {
      genesisEscrowStage(makeCtx([makeSelfModifyOp('../evil.ts')]));
      const token = mockSaveEscrowToken.mock.calls[0][0] as EscrowToken;
      expect(token.affectedFiles).toHaveLength(0);
    });

    it('processes safe relative paths normally', () => {
      genesisEscrowStage(makeCtx([makeSelfModifyOp('src/safe.ts')]));
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledOnce();
    });

    it('safe ops alongside unsafe ops: only safe paths staged', () => {
      const ops = [makeSelfModifyOp('../evil.ts'), makeSelfModifyOp('src/safe.ts')];
      genesisEscrowStage(makeCtx(ops));
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledOnce();
      const token = mockSaveEscrowToken.mock.calls[0][0] as EscrowToken;
      expect(token.affectedFiles).toEqual(['src/safe.ts']);
    });
  });

  describe('all self-modify operation types', () => {
    it('processes selfModifyWorkflow operations', () => {
      genesisEscrowStage(makeCtx([makeSelfModifyOp('src/wf.ts', 'content', 'selfModifyWorkflow')]));
      expect(mockSaveEscrowToken).toHaveBeenCalledOnce();
    });

    it('processes selfModifyNodeType operations', () => {
      genesisEscrowStage(makeCtx([makeSelfModifyOp('src/node.ts', 'content', 'selfModifyNodeType')]));
      expect(mockSaveEscrowToken).toHaveBeenCalledOnce();
    });

    it('processes selfModifyModule operations', () => {
      genesisEscrowStage(makeCtx([makeSelfModifyOp('src/mod.ts', 'content', 'selfModifyModule')]));
      expect(mockSaveEscrowToken).toHaveBeenCalledOnce();
    });

    it('non-self-modify ops are excluded from affectedFiles', () => {
      const ops = [
        makeSelfModifyOp('src/foo.ts'),
        { type: 'addNode', args: { file: 'workflow.ts' } },
      ];
      genesisEscrowStage(makeCtx(ops));
      const token = mockSaveEscrowToken.mock.calls[0][0] as EscrowToken;
      expect(token.affectedFiles).toHaveLength(1);
      expect(token.affectedFiles).toContain('src/foo.ts');
    });
  });

  describe('error during staging', () => {
    beforeEach(() => {
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw new Error('disk full');
      });
    });

    it('returns onFailure=true', () => {
      const result = genesisEscrowStage(makeCtx([makeSelfModifyOp('src/foo.ts')]));
      expect(result.onFailure).toBe(true);
    });

    it('returns onSuccess=false', () => {
      const result = genesisEscrowStage(makeCtx([makeSelfModifyOp('src/foo.ts')]));
      expect(result.onSuccess).toBe(false);
    });

    it('sets context.error', () => {
      const result = genesisEscrowStage(makeCtx([makeSelfModifyOp('src/foo.ts')]));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.error).toBeDefined();
    });

    it('includes original error message in context.error', () => {
      const result = genesisEscrowStage(makeCtx([makeSelfModifyOp('src/foo.ts')]));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.error).toContain('disk full');
    });

    it('calls clearEscrow on error', () => {
      genesisEscrowStage(makeCtx([makeSelfModifyOp('src/foo.ts')]));
      expect(mockClearEscrow).toHaveBeenCalledOnce();
    });

    it('does not call saveEscrowToken on error', () => {
      genesisEscrowStage(makeCtx([makeSelfModifyOp('src/foo.ts')]));
      expect(mockSaveEscrowToken).not.toHaveBeenCalled();
    });
  });

  describe('ctx pass-through', () => {
    it('returns valid JSON string as ctx', () => {
      const result = genesisEscrowStage(makeCtx([]));
      expect(() => JSON.parse(result.ctx)).not.toThrow();
    });

    it('preserves env in output ctx', () => {
      const result = genesisEscrowStage(makeCtx([]));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.env.projectDir).toBe('/proj');
    });

    it('returns object with onSuccess, onFailure, ctx keys', () => {
      const result = genesisEscrowStage(makeCtx([]));
      expect(Object.keys(result).sort()).toEqual(['ctx', 'onFailure', 'onSuccess']);
    });
  });
});
