import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GenesisContext, EscrowToken, WeaverEnv } from '../src/bot/types.js';

const {
  mockLoadEscrowToken,
  mockSaveEscrowToken,
  mockClearEscrow,
  mockAppendSelfMigration,
} = vi.hoisted(() => ({
  mockLoadEscrowToken: vi.fn<() => EscrowToken | null>(),
  mockSaveEscrowToken: vi.fn<(t: EscrowToken) => void>(),
  mockClearEscrow: vi.fn<() => void>(),
  mockAppendSelfMigration: vi.fn(),
}));

vi.mock('../src/bot/genesis-store.js', () => ({
  GenesisStore: class {
    loadEscrowToken() { return mockLoadEscrowToken(); }
    saveEscrowToken(t: EscrowToken) { return mockSaveEscrowToken(t); }
    clearEscrow() { return mockClearEscrow(); }
    appendSelfMigration(r: unknown) { return mockAppendSelfMigration(r); }
  },
}));

const { mockRollbackFromBackup } = vi.hoisted(() => ({
  mockRollbackFromBackup: vi.fn(),
}));

vi.mock('../src/node-types/genesis-escrow-migrate.js', () => ({
  rollbackFromBackup: mockRollbackFromBackup,
}));

import { genesisEscrowGrace } from '../src/node-types/genesis-escrow-grace.js';

const BASE_ENV: WeaverEnv = {
  projectDir: '/proj',
  config: { provider: 'auto' as const },
  providerType: 'anthropic' as const,
  providerInfo: { type: 'anthropic' as const, apiKey: 'key' },
};

function makeToken(overrides: Partial<EscrowToken> = {}): EscrowToken {
  return {
    migrationId: 'migration-1',
    cycleId: 'cycle-0',
    stagedAt: '2024-01-01T00:00:00Z',
    phase: 'migrated',
    affectedFiles: ['src/node-types/foo.ts'],
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

describe('genesisEscrowGrace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  describe('selfEvolve disabled', () => {
    it('returns ctx unchanged when config.selfEvolve is false', () => {
      const input = makeCtx();
      const parsed = JSON.parse(input);
      parsed.genesisConfigJson = JSON.stringify({ selfEvolve: false, targetWorkflow: 'wf.ts' });
      const ctx = JSON.stringify(parsed);

      const result = genesisEscrowGrace(ctx);
      expect(result.ctx).toBe(ctx);
    });

    it('does not call loadEscrowToken when selfEvolve is false', () => {
      const parsed = JSON.parse(makeCtx());
      parsed.genesisConfigJson = JSON.stringify({ selfEvolve: false });

      genesisEscrowGrace(JSON.stringify(parsed));
      expect(mockLoadEscrowToken).not.toHaveBeenCalled();
    });
  });

  describe('no escrow token', () => {
    it('returns ctx unchanged when loadEscrowToken returns null', () => {
      mockLoadEscrowToken.mockReturnValue(null);

      const input = makeCtx();
      const result = genesisEscrowGrace(input);
      expect(result.ctx).toBe(input);
    });

    it('does not call saveEscrowToken when no token', () => {
      mockLoadEscrowToken.mockReturnValue(null);

      genesisEscrowGrace(makeCtx());
      expect(mockSaveEscrowToken).not.toHaveBeenCalled();
    });
  });

  describe('token not in migrated phase', () => {
    it('returns ctx unchanged when phase is not migrated', () => {
      mockLoadEscrowToken.mockReturnValue(makeToken({ phase: 'staged' }));

      const input = makeCtx();
      const result = genesisEscrowGrace(input);
      expect(result.ctx).toBe(input);
    });
  });

  describe('token with graceRemaining <= 0', () => {
    it('returns ctx unchanged when graceRemaining is 0', () => {
      mockLoadEscrowToken.mockReturnValue(makeToken({ graceRemaining: 0 }));

      const input = makeCtx();
      const result = genesisEscrowGrace(input);
      expect(result.ctx).toBe(input);
    });
  });

  describe('cycle failed during grace (context.error set)', () => {
    it('calls rollbackFromBackup when context.error is set', () => {
      mockLoadEscrowToken.mockReturnValue(makeToken({ graceRemaining: 2 }));

      genesisEscrowGrace(makeCtx({ error: 'compilation failed' }));
      expect(mockRollbackFromBackup).toHaveBeenCalledOnce();
    });

    it('passes error message to rollbackFromBackup', () => {
      mockLoadEscrowToken.mockReturnValue(makeToken({ graceRemaining: 2 }));

      genesisEscrowGrace(makeCtx({ error: 'build broke' }));
      const [, , , reason] = mockRollbackFromBackup.mock.calls[0] as string[];
      expect(reason).toContain('build broke');
    });

    it('does not call saveEscrowToken when rolling back on error', () => {
      mockLoadEscrowToken.mockReturnValue(makeToken({ graceRemaining: 2 }));

      genesisEscrowGrace(makeCtx({ error: 'oops' }));
      expect(mockSaveEscrowToken).not.toHaveBeenCalled();
    });

    it('returns ctx after rollback', () => {
      mockLoadEscrowToken.mockReturnValue(makeToken({ graceRemaining: 2 }));
      const input = makeCtx({ error: 'oops' });

      const result = genesisEscrowGrace(input);
      expect(() => JSON.parse(result.ctx)).not.toThrow();
    });
  });

  describe('cycle succeeded — grace decrement', () => {
    it('decrements graceRemaining by 1 on success', () => {
      mockLoadEscrowToken.mockReturnValue(makeToken({ graceRemaining: 3 }));

      genesisEscrowGrace(makeCtx());

      const saved = mockSaveEscrowToken.mock.calls[0][0] as EscrowToken;
      expect(saved.graceRemaining).toBe(2);
    });

    it('appends cycleId to graceCycleIds', () => {
      mockLoadEscrowToken.mockReturnValue(makeToken({ graceRemaining: 2, graceCycleIds: [] }));

      genesisEscrowGrace(makeCtx({ cycleId: 'cycle-99' }));

      const saved = mockSaveEscrowToken.mock.calls[0][0] as EscrowToken;
      expect(saved.graceCycleIds).toContain('cycle-99');
    });

    it('calls saveEscrowToken with updated token', () => {
      mockLoadEscrowToken.mockReturnValue(makeToken({ graceRemaining: 2 }));

      genesisEscrowGrace(makeCtx());
      expect(mockSaveEscrowToken).toHaveBeenCalledOnce();
    });

    it('logs remaining grace cycles', () => {
      mockLoadEscrowToken.mockReturnValue(makeToken({ graceRemaining: 2 }));

      genesisEscrowGrace(makeCtx());
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('Grace period'),
      );
    });

    it('does not call clearEscrow when graceRemaining > 0 after decrement', () => {
      mockLoadEscrowToken.mockReturnValue(makeToken({ graceRemaining: 2 }));

      genesisEscrowGrace(makeCtx());
      expect(mockClearEscrow).not.toHaveBeenCalled();
    });
  });

  describe('grace period complete (last cycle)', () => {
    it('calls appendSelfMigration when grace reaches 0', () => {
      mockLoadEscrowToken.mockReturnValue(makeToken({ graceRemaining: 1 }));

      genesisEscrowGrace(makeCtx());
      expect(mockAppendSelfMigration).toHaveBeenCalledOnce();
    });

    it('calls clearEscrow when grace reaches 0', () => {
      mockLoadEscrowToken.mockReturnValue(makeToken({ graceRemaining: 1 }));

      genesisEscrowGrace(makeCtx());
      expect(mockClearEscrow).toHaveBeenCalledOnce();
    });

    it('logs grace period complete message', () => {
      mockLoadEscrowToken.mockReturnValue(makeToken({ graceRemaining: 1 }));

      genesisEscrowGrace(makeCtx());
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('Grace period complete'),
      );
    });

    it('appendSelfMigration is called with outcome=grace-cleared', () => {
      mockLoadEscrowToken.mockReturnValue(makeToken({ graceRemaining: 1, migrationId: 'mig-42' }));

      genesisEscrowGrace(makeCtx());
      const record = mockAppendSelfMigration.mock.calls[0][0] as { outcome: string };
      expect(record.outcome).toBe('grace-cleared');
    });

    it('appendSelfMigration is called with graceCompleted=true', () => {
      mockLoadEscrowToken.mockReturnValue(makeToken({ graceRemaining: 1 }));

      genesisEscrowGrace(makeCtx());
      const record = mockAppendSelfMigration.mock.calls[0][0] as { graceCompleted: boolean };
      expect(record.graceCompleted).toBe(true);
    });
  });

  describe('ctx pass-through', () => {
    it('always returns valid JSON string as ctx', () => {
      mockLoadEscrowToken.mockReturnValue(null);

      const result = genesisEscrowGrace(makeCtx());
      expect(() => JSON.parse(result.ctx)).not.toThrow();
    });

    it('preserves env in output ctx', () => {
      mockLoadEscrowToken.mockReturnValue(null);

      const result = genesisEscrowGrace(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.env.projectDir).toBe('/proj');
    });

    it('returns object with only ctx key', () => {
      mockLoadEscrowToken.mockReturnValue(null);

      const result = genesisEscrowGrace(makeCtx());
      expect(Object.keys(result)).toEqual(['ctx']);
    });
  });
});
