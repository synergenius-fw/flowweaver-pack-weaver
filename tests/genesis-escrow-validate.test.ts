import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GenesisContext, EscrowToken, WeaverEnv } from '../src/bot/types.js';

const {
  mockLoadEscrowToken,
  mockSaveEscrowToken,
  mockGetEscrowStagedPath,
  mockExecFileSync,
} = vi.hoisted(() => ({
  mockLoadEscrowToken: vi.fn<() => EscrowToken | null>(),
  mockSaveEscrowToken: vi.fn<(t: EscrowToken) => void>(),
  mockGetEscrowStagedPath: vi.fn<(f: string) => string>(),
  mockExecFileSync: vi.fn(),
}));

vi.mock('../src/bot/genesis-store.js', () => ({
  GenesisStore: class {
    loadEscrowToken() { return mockLoadEscrowToken(); }
    saveEscrowToken(t: EscrowToken) { return mockSaveEscrowToken(t); }
    getEscrowStagedPath(f: string) { return mockGetEscrowStagedPath(f); }
  },
}));

vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  mkdtempSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  tmpdir: vi.fn(() => '/tmp'),
}));

import * as fs from 'node:fs';
import { genesisEscrowValidate } from '../src/node-types/genesis-escrow-validate.js';

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
    phase: 'staged' as EscrowToken['phase'],
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

describe('genesisEscrowValidate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('export function foo() {}');
    vi.mocked(fs.mkdtempSync).mockReturnValue('/tmp/escrow-test-abc');
    mockGetEscrowStagedPath.mockImplementation((f: string) => `/proj/.genesis/staged/${f}`);
    mockExecFileSync.mockReturnValue('');
  });

  describe('no staged token', () => {
    it('returns onSuccess=true when no token', () => {
      mockLoadEscrowToken.mockReturnValue(null);
      const result = genesisEscrowValidate(makeCtx());
      expect(result.onSuccess).toBe(true);
    });

    it('returns onFailure=false when no token', () => {
      mockLoadEscrowToken.mockReturnValue(null);
      const result = genesisEscrowValidate(makeCtx());
      expect(result.onFailure).toBe(false);
    });

    it('does not call execFileSync when no token', () => {
      mockLoadEscrowToken.mockReturnValue(null);
      genesisEscrowValidate(makeCtx());
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('does not call saveEscrowToken when no staged token', () => {
      mockLoadEscrowToken.mockReturnValue(null);
      genesisEscrowValidate(makeCtx());
      expect(mockSaveEscrowToken).not.toHaveBeenCalled();
    });

    it('returns onSuccess=true when token phase is migrated', () => {
      mockLoadEscrowToken.mockReturnValue(makeToken({ phase: 'migrated' as EscrowToken['phase'] }));
      const result = genesisEscrowValidate(makeCtx());
      expect(result.onSuccess).toBe(true);
    });

    it('returns onSuccess=true when token phase is validated', () => {
      mockLoadEscrowToken.mockReturnValue(makeToken({ phase: 'validated' as EscrowToken['phase'] }));
      const result = genesisEscrowValidate(makeCtx());
      expect(result.onSuccess).toBe(true);
    });
  });

  describe('happy path: TypeScript module (non-workflow)', () => {
    beforeEach(() => {
      mockLoadEscrowToken.mockReturnValue(makeToken({
        affectedFiles: ['src/node-types/my-node.ts'],
      }));
    });

    it('returns onSuccess=true', () => {
      const result = genesisEscrowValidate(makeCtx());
      expect(result.onSuccess).toBe(true);
    });

    it('returns onFailure=false', () => {
      const result = genesisEscrowValidate(makeCtx());
      expect(result.onFailure).toBe(false);
    });

    it('calls execFileSync with npx tsc', () => {
      genesisEscrowValidate(makeCtx());
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'npx',
        expect.arrayContaining(['tsc', '--project']),
        expect.any(Object),
      );
    });

    it('calls execFileSync exactly once (just tsc)', () => {
      genesisEscrowValidate(makeCtx());
      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    });

    it('reads staged file content', () => {
      genesisEscrowValidate(makeCtx());
      expect(vi.mocked(fs.readFileSync as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        expect.stringContaining('my-node.ts'),
        'utf-8',
      );
    });

    it('creates a temp dir', () => {
      genesisEscrowValidate(makeCtx());
      expect(vi.mocked(fs.mkdtempSync)).toHaveBeenCalledOnce();
    });

    it('removes temp dir after check', () => {
      genesisEscrowValidate(makeCtx());
      expect(vi.mocked(fs.rmSync)).toHaveBeenCalledWith(
        '/tmp/escrow-test-abc',
        { recursive: true, force: true },
      );
    });

    it('saves token with validated phase', () => {
      genesisEscrowValidate(makeCtx());
      const saved = mockSaveEscrowToken.mock.calls[0][0] as EscrowToken;
      expect(saved.phase).toBe('validated');
    });

    it('saves token with validationResult.compiled=true', () => {
      genesisEscrowValidate(makeCtx());
      const saved = mockSaveEscrowToken.mock.calls[0][0] as any;
      expect(saved.validationResult.compiled).toBe(true);
    });

    it('saves token with validationResult.validated=true', () => {
      genesisEscrowValidate(makeCtx());
      const saved = mockSaveEscrowToken.mock.calls[0][0] as any;
      expect(saved.validationResult.validated).toBe(true);
    });

    it('logs validation passed message', () => {
      genesisEscrowValidate(makeCtx());
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('validation passed'),
      );
    });

    it('does not call unlinkSync on success', () => {
      genesisEscrowValidate(makeCtx());
      expect(vi.mocked(fs.unlinkSync)).not.toHaveBeenCalled();
    });
  });

  describe('happy path: workflow file (path contains "workflows/")', () => {
    beforeEach(() => {
      mockLoadEscrowToken.mockReturnValue(makeToken({
        affectedFiles: ['src/workflows/genesis-task.ts'],
      }));
    });

    it('returns onSuccess=true', () => {
      const result = genesisEscrowValidate(makeCtx());
      expect(result.onSuccess).toBe(true);
    });

    it('calls execFileSync with flow-weaver compile', () => {
      genesisEscrowValidate(makeCtx());
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'flow-weaver',
        expect.arrayContaining(['compile']),
        expect.any(Object),
      );
    });

    it('calls execFileSync with flow-weaver validate', () => {
      genesisEscrowValidate(makeCtx());
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'flow-weaver',
        expect.arrayContaining(['validate']),
        expect.any(Object),
      );
    });

    it('calls execFileSync exactly twice (compile + validate)', () => {
      genesisEscrowValidate(makeCtx());
      expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    });

    it('saves token with validated phase', () => {
      genesisEscrowValidate(makeCtx());
      const saved = mockSaveEscrowToken.mock.calls[0][0] as EscrowToken;
      expect(saved.phase).toBe('validated');
    });

    it('removes temp dir after check', () => {
      genesisEscrowValidate(makeCtx());
      expect(vi.mocked(fs.rmSync)).toHaveBeenCalledWith(
        '/tmp/escrow-test-abc',
        { recursive: true, force: true },
      );
    });
  });

  describe('multiple files in one token', () => {
    it('processes each file and calls execFileSync per file', () => {
      mockLoadEscrowToken.mockReturnValue(makeToken({
        affectedFiles: ['src/node-types/a.ts', 'src/node-types/b.ts'],
      }));

      genesisEscrowValidate(makeCtx());
      // 1 tsc call per file
      expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    });

    it('saves token once after all files pass', () => {
      mockLoadEscrowToken.mockReturnValue(makeToken({
        affectedFiles: ['src/node-types/a.ts', 'src/node-types/b.ts'],
      }));

      genesisEscrowValidate(makeCtx());
      expect(mockSaveEscrowToken).toHaveBeenCalledTimes(1);
    });
  });

  describe('validation failure', () => {
    beforeEach(() => {
      mockLoadEscrowToken.mockReturnValue(makeToken({
        affectedFiles: ['src/node-types/bad.ts'],
      }));
      mockExecFileSync.mockImplementation(() => {
        throw new Error('compile error: syntax issue');
      });
    });

    it('returns onFailure=true', () => {
      const result = genesisEscrowValidate(makeCtx());
      expect(result.onFailure).toBe(true);
    });

    it('returns onSuccess=false', () => {
      const result = genesisEscrowValidate(makeCtx());
      expect(result.onSuccess).toBe(false);
    });

    it('sets context.error', () => {
      const result = genesisEscrowValidate(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.error).toBeDefined();
    });

    it('includes original error message in context.error', () => {
      const result = genesisEscrowValidate(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.error).toContain('compile error');
    });

    it('saves token with rolled-back phase', () => {
      genesisEscrowValidate(makeCtx());
      const saved = mockSaveEscrowToken.mock.calls[0][0] as EscrowToken;
      expect(saved.phase).toBe('rolled-back');
    });

    it('saves token with rollbackReason containing error', () => {
      genesisEscrowValidate(makeCtx());
      const saved = mockSaveEscrowToken.mock.calls[0][0] as any;
      expect(saved.rollbackReason).toContain('compile error');
    });

    it('saves token with validationResult.compiled=false', () => {
      genesisEscrowValidate(makeCtx());
      const saved = mockSaveEscrowToken.mock.calls[0][0] as any;
      expect(saved.validationResult.compiled).toBe(false);
    });

    it('calls unlinkSync to clean up staged file', () => {
      genesisEscrowValidate(makeCtx());
      expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalledOnce();
    });

    it('unlinkSync called with staged path for the affected file', () => {
      genesisEscrowValidate(makeCtx());
      expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalledWith(
        expect.stringContaining('bad.ts'),
      );
    });

    it('removes temp dir even after failure (finally block)', () => {
      genesisEscrowValidate(makeCtx());
      expect(vi.mocked(fs.rmSync)).toHaveBeenCalledWith(
        '/tmp/escrow-test-abc',
        { recursive: true, force: true },
      );
    });
  });

  describe('ctx pass-through', () => {
    it('returns valid JSON string as ctx', () => {
      mockLoadEscrowToken.mockReturnValue(null);
      const result = genesisEscrowValidate(makeCtx());
      expect(() => JSON.parse(result.ctx)).not.toThrow();
    });

    it('preserves env in output ctx', () => {
      mockLoadEscrowToken.mockReturnValue(null);
      const result = genesisEscrowValidate(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.env.projectDir).toBe('/proj');
    });

    it('returns object with onSuccess, onFailure, ctx keys', () => {
      mockLoadEscrowToken.mockReturnValue(null);
      const result = genesisEscrowValidate(makeCtx());
      expect(Object.keys(result).sort()).toEqual(['ctx', 'onFailure', 'onSuccess']);
    });
  });
});
