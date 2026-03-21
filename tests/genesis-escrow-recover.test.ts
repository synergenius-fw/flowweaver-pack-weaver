import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GenesisContext, EscrowToken, WeaverEnv } from '../src/bot/types.js';

const {
  mockLoadEscrowToken,
  mockSaveEscrowToken,
  mockGetSelfFailureCount,
  mockHashFile,
  mockRollbackFromBackup,
} = vi.hoisted(() => ({
  mockLoadEscrowToken: vi.fn<() => EscrowToken | null>(),
  mockSaveEscrowToken: vi.fn<(t: EscrowToken) => void>(),
  mockGetSelfFailureCount: vi.fn<() => number>(),
  mockHashFile: vi.fn<(p: string) => string>(),
  mockRollbackFromBackup: vi.fn(),
}));

vi.mock('../src/bot/genesis-store.js', () => ({
  GenesisStore: class {
    loadEscrowToken() { return mockLoadEscrowToken(); }
    saveEscrowToken(t: EscrowToken) { return mockSaveEscrowToken(t); }
    getSelfFailureCount() { return mockGetSelfFailureCount(); }
    static hashFile(p: string) { return mockHashFile(p); }
  },
}));

vi.mock('../src/node-types/genesis-escrow-migrate.js', () => ({
  rollbackFromBackup: mockRollbackFromBackup,
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

import * as fs from 'node:fs';
import { genesisEscrowRecover } from '../src/node-types/genesis-escrow-recover.js';

const BASE_ENV: WeaverEnv = {
  projectDir: '/proj',
  config: { provider: 'auto' as const },
  providerType: 'anthropic' as const,
  providerInfo: { type: 'anthropic' as const, apiKey: 'key' },
};

function makeToken(overrides: Partial<EscrowToken> = {}): EscrowToken {
  return {
    migrationId: 'mig-1',
    cycleId: 'cycle-0',
    stagedAt: '2024-01-01T00:00:00Z',
    phase: 'migrating' as EscrowToken['phase'],
    affectedFiles: ['src/foo.ts'],
    stagedFileHashes: { 'src/foo.ts': 'staged-hash' },
    backupFileHashes: { 'src/foo.ts': 'backup-hash' },
    ownerPid: 1234,
    graceRemaining: 2,
    graceCycleIds: [],
    ...overrides,
  };
}

function makeCtx(
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
    ...ctxOverrides,
  };
  return JSON.stringify(ctx);
}

describe('genesisEscrowRecover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGetSelfFailureCount.mockReturnValue(0);
    mockLoadEscrowToken.mockReturnValue(null);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockHashFile.mockReturnValue('staged-hash');
  });

  describe('selfEvolve disabled', () => {
    it('sets escrowGraceLocked=false when selfEvolve is false', () => {
      const result = genesisEscrowRecover(makeCtx({ selfEvolve: false }));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.escrowGraceLocked).toBe(false);
    });

    it('does not call getSelfFailureCount when selfEvolve is false', () => {
      genesisEscrowRecover(makeCtx({ selfEvolve: false }));
      expect(mockGetSelfFailureCount).not.toHaveBeenCalled();
    });

    it('returns valid ctx when selfEvolve is false', () => {
      const result = genesisEscrowRecover(makeCtx({ selfEvolve: false }));
      expect(() => JSON.parse(result.ctx)).not.toThrow();
    });
  });

  describe('max failures exceeded', () => {
    it('sets escrowGraceLocked=true when failure count equals default max (3)', () => {
      mockGetSelfFailureCount.mockReturnValue(3);
      const result = genesisEscrowRecover(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.escrowGraceLocked).toBe(true);
    });

    it('sets escrowGraceRemaining=0 when locked by failures', () => {
      mockGetSelfFailureCount.mockReturnValue(3);
      const result = genesisEscrowRecover(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.escrowGraceRemaining).toBe(0);
    });

    it('respects custom selfEvolveMaxFailures from config', () => {
      mockGetSelfFailureCount.mockReturnValue(2);
      const result = genesisEscrowRecover(makeCtx({ selfEvolveMaxFailures: 2 }));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.escrowGraceLocked).toBe(true);
    });

    it('does not lock when failure count is below default max', () => {
      mockGetSelfFailureCount.mockReturnValue(2);
      const result = genesisEscrowRecover(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.escrowGraceLocked).toBe(false);
    });

    it('logs warning containing failure count', () => {
      mockGetSelfFailureCount.mockReturnValue(3);
      genesisEscrowRecover(makeCtx());
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('3'),
      );
    });

    it('does not call loadEscrowToken when locked by failures', () => {
      mockGetSelfFailureCount.mockReturnValue(3);
      genesisEscrowRecover(makeCtx());
      expect(mockLoadEscrowToken).not.toHaveBeenCalled();
    });
  });

  describe('no token', () => {
    it('sets escrowGraceLocked=false when loadEscrowToken returns null', () => {
      mockLoadEscrowToken.mockReturnValue(null);
      const result = genesisEscrowRecover(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.escrowGraceLocked).toBe(false);
    });

    it('does not call rollbackFromBackup when no token', () => {
      mockLoadEscrowToken.mockReturnValue(null);
      genesisEscrowRecover(makeCtx());
      expect(mockRollbackFromBackup).not.toHaveBeenCalled();
    });
  });

  describe('crash recovery: migrating phase — file missing', () => {
    beforeEach(() => {
      mockLoadEscrowToken
        .mockReturnValueOnce(makeToken({ phase: 'migrating' as EscrowToken['phase'] }))
        .mockReturnValueOnce(null); // final grace check
      vi.mocked(fs.existsSync).mockReturnValue(false);
    });

    it('calls rollbackFromBackup when file is missing', () => {
      genesisEscrowRecover(makeCtx());
      expect(mockRollbackFromBackup).toHaveBeenCalledOnce();
    });

    it('rollback reason mentions crash recovery', () => {
      genesisEscrowRecover(makeCtx());
      const [, , , reason] = mockRollbackFromBackup.mock.calls[0] as string[];
      expect(reason).toContain('Crash recovery');
    });

    it('sets escrowGraceLocked=false after rollback with no remaining token', () => {
      const result = genesisEscrowRecover(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.escrowGraceLocked).toBe(false);
    });
  });

  describe('crash recovery: migrating phase — hash mismatch', () => {
    beforeEach(() => {
      mockLoadEscrowToken
        .mockReturnValueOnce(makeToken({
          phase: 'migrating' as EscrowToken['phase'],
          stagedFileHashes: { 'src/foo.ts': 'staged-hash' },
          backupFileHashes: { 'src/foo.ts': 'backup-hash' },
        }))
        .mockReturnValueOnce(null);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockHashFile.mockReturnValue('unknown-hash'); // neither staged nor backup
    });

    it('calls rollbackFromBackup when hash matches neither staged nor backup', () => {
      genesisEscrowRecover(makeCtx());
      expect(mockRollbackFromBackup).toHaveBeenCalledOnce();
    });
  });

  describe('crash recovery: migrating phase — migration was complete', () => {
    beforeEach(() => {
      mockLoadEscrowToken
        .mockReturnValueOnce(makeToken({
          phase: 'migrating' as EscrowToken['phase'],
          stagedFileHashes: { 'src/foo.ts': 'staged-hash' },
        }))
        .mockReturnValueOnce(makeToken({
          phase: 'migrated' as EscrowToken['phase'],
          graceRemaining: 2,
        }));
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockHashFile.mockReturnValue('staged-hash'); // matches staged
    });

    it('does not call rollbackFromBackup when all files match staged', () => {
      genesisEscrowRecover(makeCtx());
      expect(mockRollbackFromBackup).not.toHaveBeenCalled();
    });

    it('saves token with migrated phase', () => {
      genesisEscrowRecover(makeCtx());
      const saved = mockSaveEscrowToken.mock.calls[0][0] as EscrowToken;
      expect(saved.phase).toBe('migrated');
    });

    it('sets escrowGraceLocked=true when final token has graceRemaining > 0', () => {
      const result = genesisEscrowRecover(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.escrowGraceLocked).toBe(true);
    });

    it('sets escrowGraceRemaining from final token', () => {
      const result = genesisEscrowRecover(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.escrowGraceRemaining).toBe(2);
    });

    it('logs advancing to grace period', () => {
      genesisEscrowRecover(makeCtx());
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('grace period'),
      );
    });
  });

  describe('crash recovery: migrating phase — partial migration', () => {
    beforeEach(() => {
      // 2 files: a.ts matches staged, b.ts matches backup only → allStaged=false
      const token = makeToken({
        phase: 'migrating' as EscrowToken['phase'],
        affectedFiles: ['src/a.ts', 'src/b.ts'],
        stagedFileHashes: { 'src/a.ts': 'staged-a', 'src/b.ts': 'staged-b' },
        backupFileHashes: { 'src/a.ts': 'backup-a', 'src/b.ts': 'backup-b' },
      });
      mockLoadEscrowToken
        .mockReturnValueOnce(token)
        .mockReturnValueOnce(null);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      // a.ts matches staged, b.ts matches backup (not staged)
      mockHashFile.mockImplementation((p: string) =>
        p.includes('a.ts') ? 'staged-a' : 'backup-b',
      );
    });

    it('calls rollbackFromBackup for partial migration', () => {
      genesisEscrowRecover(makeCtx());
      expect(mockRollbackFromBackup).toHaveBeenCalledOnce();
    });

    it('rollback reason mentions partial migration', () => {
      genesisEscrowRecover(makeCtx());
      const [, , , reason] = mockRollbackFromBackup.mock.calls[0] as string[];
      expect(reason).toContain('partial migration');
    });
  });

  describe('grace state: non-migrating token', () => {
    it('sets escrowGraceLocked=true when token is migrated with graceRemaining > 0', () => {
      mockLoadEscrowToken.mockReturnValue(makeToken({
        phase: 'migrated' as EscrowToken['phase'],
        graceRemaining: 3,
      }));
      const result = genesisEscrowRecover(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.escrowGraceLocked).toBe(true);
    });

    it('sets escrowGraceRemaining from token', () => {
      mockLoadEscrowToken.mockReturnValue(makeToken({
        phase: 'migrated' as EscrowToken['phase'],
        graceRemaining: 3,
      }));
      const result = genesisEscrowRecover(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.escrowGraceRemaining).toBe(3);
    });

    it('sets escrowGraceLocked=false when token is migrated with graceRemaining=0', () => {
      mockLoadEscrowToken.mockReturnValue(makeToken({
        phase: 'migrated' as EscrowToken['phase'],
        graceRemaining: 0,
      }));
      const result = genesisEscrowRecover(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.escrowGraceLocked).toBe(false);
    });

    it('sets escrowGraceLocked=false when token phase is staged', () => {
      mockLoadEscrowToken.mockReturnValue(makeToken({
        phase: 'staged' as EscrowToken['phase'],
      }));
      const result = genesisEscrowRecover(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.escrowGraceLocked).toBe(false);
    });

    it('sets escrowGraceLocked=false when token phase is validated', () => {
      mockLoadEscrowToken.mockReturnValue(makeToken({
        phase: 'validated' as EscrowToken['phase'],
      }));
      const result = genesisEscrowRecover(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.escrowGraceLocked).toBe(false);
    });
  });

  describe('ctx pass-through', () => {
    it('returns valid JSON string as ctx', () => {
      const result = genesisEscrowRecover(makeCtx());
      expect(() => JSON.parse(result.ctx)).not.toThrow();
    });

    it('preserves env in output ctx', () => {
      const result = genesisEscrowRecover(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.env.projectDir).toBe('/proj');
    });

    it('returns object with only ctx key', () => {
      const result = genesisEscrowRecover(makeCtx());
      expect(Object.keys(result)).toEqual(['ctx']);
    });
  });
});
