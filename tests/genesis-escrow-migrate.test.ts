import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GenesisContext, EscrowToken, WeaverEnv } from '../src/bot/types.js';

const {
  mockLoadEscrowToken,
  mockSaveEscrowToken,
  mockGetEscrowStagedPath,
  mockGetEscrowBackupPath,
  mockAppendSelfMigration,
  mockWithFileLock,
} = vi.hoisted(() => ({
  mockLoadEscrowToken: vi.fn<() => EscrowToken | null>(),
  mockSaveEscrowToken: vi.fn<(t: EscrowToken) => void>(),
  mockGetEscrowStagedPath: vi.fn<(f: string) => string>(),
  mockGetEscrowBackupPath: vi.fn<(f: string) => string>(),
  mockAppendSelfMigration: vi.fn(),
  mockWithFileLock: vi.fn(),
}));

vi.mock('../src/bot/genesis-store.js', () => ({
  GenesisStore: class {
    loadEscrowToken() { return mockLoadEscrowToken(); }
    saveEscrowToken(t: EscrowToken) { return mockSaveEscrowToken(t); }
    getEscrowStagedPath(f: string) { return mockGetEscrowStagedPath(f); }
    getEscrowBackupPath(f: string) { return mockGetEscrowBackupPath(f); }
    appendSelfMigration(r: unknown) { return mockAppendSelfMigration(r); }
    static hashFile(_p: string) { return 'hash'; }
  },
}));

vi.mock('../src/bot/file-lock.js', () => ({
  withFileLock: mockWithFileLock,
}));

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  copyFileSync: vi.fn(),
  existsSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import * as fs from 'node:fs';
import { genesisEscrowMigrate } from '../src/node-types/genesis-escrow-migrate.js';

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
    phase: 'validated' as EscrowToken['phase'],
    affectedFiles: ['src/foo.ts'],
    stagedFileHashes: {},
    backupFileHashes: {},
    ownerPid: 1234,
    graceRemaining: 2,
    graceCycleIds: [],
    ...overrides,
  };
}

function makeCtx(overrides: Partial<GenesisContext> = {}): string {
  const ctx: GenesisContext = {
    env: BASE_ENV,
    genesisConfigJson: JSON.stringify({ selfEvolve: true, targetWorkflow: 'workflow.ts' }),
    cycleId: 'cycle-1',
    ...overrides,
  };
  return JSON.stringify(ctx);
}

describe('genesisEscrowMigrate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(fs.existsSync).mockReturnValue(false);
    mockGetEscrowBackupPath.mockReturnValue('/proj/.genesis/backup/src/foo.ts');
    mockGetEscrowStagedPath.mockReturnValue('/proj/.genesis/staged/src/foo.ts');
  });

  describe('dry run (execute=false)', () => {
    it('returns onSuccess=true for dry run', async () => {
      mockLoadEscrowToken.mockReturnValue(makeToken());
      const result = await genesisEscrowMigrate(false, makeCtx());
      expect(result.onSuccess).toBe(true);
    });

    it('returns onFailure=false for dry run', async () => {
      mockLoadEscrowToken.mockReturnValue(makeToken());
      const result = await genesisEscrowMigrate(false, makeCtx());
      expect(result.onFailure).toBe(false);
    });

    it('sets escrowResultJson.migrated=false for dry run', async () => {
      mockLoadEscrowToken.mockReturnValue(makeToken());
      const result = await genesisEscrowMigrate(false, makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      const er = JSON.parse(ctx.escrowResultJson!);
      expect(er.migrated).toBe(false);
    });

    it('sets escrowResultJson.reason="dry run"', async () => {
      mockLoadEscrowToken.mockReturnValue(makeToken());
      const result = await genesisEscrowMigrate(false, makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      const er = JSON.parse(ctx.escrowResultJson!);
      expect(er.reason).toBe('dry run');
    });

    it('does not call withFileLock for dry run', async () => {
      mockLoadEscrowToken.mockReturnValue(makeToken());
      await genesisEscrowMigrate(false, makeCtx());
      expect(mockWithFileLock).not.toHaveBeenCalled();
    });
  });

  describe('no validated token', () => {
    it('returns onSuccess=true when no token', async () => {
      mockLoadEscrowToken.mockReturnValue(null);
      const result = await genesisEscrowMigrate(true, makeCtx());
      expect(result.onSuccess).toBe(true);
    });

    it('returns onSuccess=true when token phase is staged', async () => {
      mockLoadEscrowToken.mockReturnValue(makeToken({ phase: 'staged' as EscrowToken['phase'] }));
      const result = await genesisEscrowMigrate(true, makeCtx());
      expect(result.onSuccess).toBe(true);
    });

    it('returns onSuccess=true when token phase is migrated', async () => {
      mockLoadEscrowToken.mockReturnValue(makeToken({ phase: 'migrated' as EscrowToken['phase'] }));
      const result = await genesisEscrowMigrate(true, makeCtx());
      expect(result.onSuccess).toBe(true);
    });

    it('does not call withFileLock when no token', async () => {
      mockLoadEscrowToken.mockReturnValue(null);
      await genesisEscrowMigrate(true, makeCtx());
      expect(mockWithFileLock).not.toHaveBeenCalled();
    });

    it('returns onFailure=false when no token', async () => {
      mockLoadEscrowToken.mockReturnValue(null);
      const result = await genesisEscrowMigrate(true, makeCtx());
      expect(result.onFailure).toBe(false);
    });
  });

  describe('happy path migration', () => {
    beforeEach(() => {
      mockLoadEscrowToken
        .mockReturnValueOnce(makeToken())   // initial check
        .mockReturnValueOnce(makeToken());  // re-read inside lock
      mockWithFileLock.mockImplementation(async (_path: string, fn: () => void) => {
        fn();
      });
    });

    it('calls withFileLock', async () => {
      await genesisEscrowMigrate(true, makeCtx());
      expect(mockWithFileLock).toHaveBeenCalledOnce();
    });

    it('calls copyFileSync for each affected file', async () => {
      await genesisEscrowMigrate(true, makeCtx());
      expect(vi.mocked(fs.copyFileSync)).toHaveBeenCalledOnce();
    });

    it('calls mkdirSync before copying', async () => {
      await genesisEscrowMigrate(true, makeCtx());
      expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledOnce();
    });

    it('saves token with migrated phase after files copied', async () => {
      await genesisEscrowMigrate(true, makeCtx());
      const secondSave = mockSaveEscrowToken.mock.calls[1][0] as EscrowToken;
      expect(secondSave.phase).toBe('migrated');
    });

    it('saves token exactly twice (migrating then migrated)', async () => {
      await genesisEscrowMigrate(true, makeCtx());
      expect(mockSaveEscrowToken).toHaveBeenCalledTimes(2);
    });

    it('returns onSuccess=true', async () => {
      const result = await genesisEscrowMigrate(true, makeCtx());
      expect(result.onSuccess).toBe(true);
    });

    it('returns onFailure=false', async () => {
      const result = await genesisEscrowMigrate(true, makeCtx());
      expect(result.onFailure).toBe(false);
    });

    it('sets escrowResultJson.migrated=true', async () => {
      const result = await genesisEscrowMigrate(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      const er = JSON.parse(ctx.escrowResultJson!);
      expect(er.migrated).toBe(true);
    });

    it('sets escrowResultJson.migrationId to token migrationId', async () => {
      const result = await genesisEscrowMigrate(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      const er = JSON.parse(ctx.escrowResultJson!);
      expect(er.migrationId).toBe('mig-1');
    });

    it('sets escrowResultJson.files to affected files', async () => {
      const result = await genesisEscrowMigrate(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      const er = JSON.parse(ctx.escrowResultJson!);
      expect(er.files).toEqual(['src/foo.ts']);
    });

    it('logs migration complete message', async () => {
      await genesisEscrowMigrate(true, makeCtx());
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('migration complete'),
      );
    });
  });

  describe('error during migration', () => {
    beforeEach(() => {
      mockLoadEscrowToken
        .mockReturnValueOnce(makeToken())   // initial check
        .mockReturnValueOnce(makeToken());  // inside rollbackFromBackup
      mockWithFileLock.mockRejectedValue(new Error('disk full'));
    });

    it('returns onFailure=true', async () => {
      const result = await genesisEscrowMigrate(true, makeCtx());
      expect(result.onFailure).toBe(true);
    });

    it('returns onSuccess=false', async () => {
      const result = await genesisEscrowMigrate(true, makeCtx());
      expect(result.onSuccess).toBe(false);
    });

    it('sets context.error', async () => {
      const result = await genesisEscrowMigrate(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.error).toBeDefined();
    });

    it('includes original error message in context.error', async () => {
      const result = await genesisEscrowMigrate(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.error).toContain('disk full');
    });

    it('calls appendSelfMigration with outcome=rolled-back', async () => {
      await genesisEscrowMigrate(true, makeCtx());
      const record = mockAppendSelfMigration.mock.calls[0][0] as { outcome: string };
      expect(record.outcome).toBe('rolled-back');
    });

    it('calls appendSelfMigration with correct migrationId', async () => {
      await genesisEscrowMigrate(true, makeCtx());
      const record = mockAppendSelfMigration.mock.calls[0][0] as { migrationId: string };
      expect(record.migrationId).toBe('mig-1');
    });

    it('does not set escrowResultJson on failure', async () => {
      const result = await genesisEscrowMigrate(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.escrowResultJson).toBeUndefined();
    });
  });

  describe('ctx pass-through', () => {
    it('returns valid JSON string as ctx', async () => {
      mockLoadEscrowToken.mockReturnValue(null);
      const result = await genesisEscrowMigrate(true, makeCtx());
      expect(() => JSON.parse(result.ctx)).not.toThrow();
    });

    it('preserves env in output ctx', async () => {
      mockLoadEscrowToken.mockReturnValue(null);
      const result = await genesisEscrowMigrate(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.env.projectDir).toBe('/proj');
    });

    it('returns object with onSuccess, onFailure, ctx keys', async () => {
      mockLoadEscrowToken.mockReturnValue(null);
      const result = await genesisEscrowMigrate(true, makeCtx());
      expect(Object.keys(result).sort()).toEqual(['ctx', 'onFailure', 'onSuccess']);
    });
  });
});
