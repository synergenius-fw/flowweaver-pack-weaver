import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WeaverEnv, GenesisConfig } from '../src/bot/types.js';

// ── Mock GenesisStore ─────────────────────────────────────────────────────────

const { mockLoadSnapshot, MockGenesisStore } = vi.hoisted(() => {
  const mockLoadSnapshot = vi.fn<() => string | null>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const MockGenesisStore = vi.fn(function (this: { loadSnapshot: typeof mockLoadSnapshot }) {
    this.loadSnapshot = mockLoadSnapshot;
  }) as any;
  return { mockLoadSnapshot, MockGenesisStore };
});

vi.mock('../src/bot/genesis-store.js', () => ({
  GenesisStore: MockGenesisStore,
}));

// ── Mock child_process ────────────────────────────────────────────────────────

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFileSync: vi.fn() };
});

// ── Mock fs (writeFileSync only, keep real fs otherwise) ──────────────────────

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, writeFileSync: vi.fn() };
});

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { genesisCompileValidate } from '../src/node-types/genesis-compile-validate.js';

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedWriteFileSync = vi.mocked(fs.writeFileSync);

// ── helpers ───────────────────────────────────────────────────────────────────

const BASE_ENV: WeaverEnv = {
  projectDir: '/test',
  config: { provider: 'auto' as const },
  providerType: 'anthropic' as const,
  providerInfo: { type: 'anthropic' as const, apiKey: 'key' },
};

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

const CONFIG_JSON = JSON.stringify(BASE_CONFIG);
const SNAPSHOT_PATH = '/test/.genesis/snapshots/snap-001.ts';
const APPLY_RESULT_JSON = JSON.stringify({ applied: 2, failed: 0, errors: [] });

// ── tests ─────────────────────────────────────────────────────────────────────

describe('genesisCompileValidate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockedExecFileSync.mockReturnValue('' as any);
    mockLoadSnapshot.mockReturnValue('// snapshot content');
  });

  // ── dry-run (execute=false) ──────────────────────────────────────────────────

  describe('dry-run (execute=false)', () => {
    it('returns onSuccess=true without calling execFileSync', async () => {
      const result = await genesisCompileValidate(false, BASE_ENV, CONFIG_JSON, SNAPSHOT_PATH, APPLY_RESULT_JSON);
      expect(result.onSuccess).toBe(true);
      expect(result.onFailure).toBe(false);
      expect(mockedExecFileSync).not.toHaveBeenCalled();
    });

    it('passes env, genesisConfigJson, snapshotPath through unchanged', async () => {
      const result = await genesisCompileValidate(false, BASE_ENV, CONFIG_JSON, SNAPSHOT_PATH, APPLY_RESULT_JSON);
      expect(result.env).toBe(BASE_ENV);
      expect(result.genesisConfigJson).toBe(CONFIG_JSON);
      expect(result.snapshotPath).toBe(SNAPSHOT_PATH);
    });

    it('does not construct GenesisStore', async () => {
      await genesisCompileValidate(false, BASE_ENV, CONFIG_JSON, SNAPSHOT_PATH, APPLY_RESULT_JSON);
      expect(MockGenesisStore).not.toHaveBeenCalled();
    });
  });

  // ── validate + compile both succeed ──────────────────────────────────────────

  describe('validate and compile both succeed', () => {
    it('returns onSuccess=true', async () => {
      const result = await genesisCompileValidate(true, BASE_ENV, CONFIG_JSON, SNAPSHOT_PATH, APPLY_RESULT_JSON);
      expect(result.onSuccess).toBe(true);
      expect(result.onFailure).toBe(false);
    });

    it('calls execFileSync twice (validate then compile)', async () => {
      await genesisCompileValidate(true, BASE_ENV, CONFIG_JSON, SNAPSHOT_PATH, APPLY_RESULT_JSON);
      expect(mockedExecFileSync).toHaveBeenCalledTimes(2);
    });

    it('first call is validate with target path', async () => {
      await genesisCompileValidate(true, BASE_ENV, CONFIG_JSON, SNAPSHOT_PATH, APPLY_RESULT_JSON);
      const [cmd, args] = mockedExecFileSync.mock.calls[0];
      expect(cmd).toBe('flow-weaver');
      expect(args[0]).toBe('validate');
      expect((args as string[])[1]).toContain('src/workflows/my-workflow.ts');
    });

    it('second call is compile with target path', async () => {
      await genesisCompileValidate(true, BASE_ENV, CONFIG_JSON, SNAPSHOT_PATH, APPLY_RESULT_JSON);
      const [cmd, args] = mockedExecFileSync.mock.calls[1];
      expect(cmd).toBe('flow-weaver');
      expect(args[0]).toBe('compile');
      expect((args as string[])[1]).toContain('src/workflows/my-workflow.ts');
    });

    it('passes projectDir as cwd for both calls', async () => {
      await genesisCompileValidate(true, BASE_ENV, CONFIG_JSON, SNAPSHOT_PATH, APPLY_RESULT_JSON);
      for (const call of mockedExecFileSync.mock.calls) {
        const opts = call[2] as Record<string, unknown>;
        expect(opts.cwd).toBe('/test');
      }
    });

    it('does not call loadSnapshot on success', async () => {
      await genesisCompileValidate(true, BASE_ENV, CONFIG_JSON, SNAPSHOT_PATH, APPLY_RESULT_JSON);
      expect(mockLoadSnapshot).not.toHaveBeenCalled();
    });

    it('does not call writeFileSync on success', async () => {
      await genesisCompileValidate(true, BASE_ENV, CONFIG_JSON, SNAPSHOT_PATH, APPLY_RESULT_JSON);
      expect(mockedWriteFileSync).not.toHaveBeenCalled();
    });

    it('passes env through on success', async () => {
      const result = await genesisCompileValidate(true, BASE_ENV, CONFIG_JSON, SNAPSHOT_PATH, APPLY_RESULT_JSON);
      expect(result.env).toBe(BASE_ENV);
      expect(result.genesisConfigJson).toBe(CONFIG_JSON);
      expect(result.snapshotPath).toBe(SNAPSHOT_PATH);
    });
  });

  // ── validate fails ────────────────────────────────────────────────────────────

  describe('validate fails', () => {
    beforeEach(() => {
      mockedExecFileSync.mockImplementationOnce(() => { throw new Error('validation error: unknown node type'); });
    });

    it('returns onFailure=true', async () => {
      const result = await genesisCompileValidate(true, BASE_ENV, CONFIG_JSON, SNAPSHOT_PATH, APPLY_RESULT_JSON);
      expect(result.onSuccess).toBe(false);
      expect(result.onFailure).toBe(true);
    });

    it('does not call compile (second execFileSync)', async () => {
      await genesisCompileValidate(true, BASE_ENV, CONFIG_JSON, SNAPSHOT_PATH, APPLY_RESULT_JSON);
      expect(mockedExecFileSync).toHaveBeenCalledOnce();
    });

    it('constructs GenesisStore with projectDir', async () => {
      await genesisCompileValidate(true, BASE_ENV, CONFIG_JSON, SNAPSHOT_PATH, APPLY_RESULT_JSON);
      expect(MockGenesisStore).toHaveBeenCalledWith('/test');
    });

    it('calls loadSnapshot with snapshotPath', async () => {
      await genesisCompileValidate(true, BASE_ENV, CONFIG_JSON, SNAPSHOT_PATH, APPLY_RESULT_JSON);
      expect(mockLoadSnapshot).toHaveBeenCalledWith(SNAPSHOT_PATH);
    });

    it('writes snapshot content to targetPath when snapshot found', async () => {
      mockLoadSnapshot.mockReturnValue('// original workflow content');
      await genesisCompileValidate(true, BASE_ENV, CONFIG_JSON, SNAPSHOT_PATH, APPLY_RESULT_JSON);
      expect(mockedWriteFileSync).toHaveBeenCalledOnce();
      const [filePath, content] = mockedWriteFileSync.mock.calls[0];
      expect(String(filePath)).toContain('src/workflows/my-workflow.ts');
      expect(content).toBe('// original workflow content');
    });

    it('passes env through on failure', async () => {
      const result = await genesisCompileValidate(true, BASE_ENV, CONFIG_JSON, SNAPSHOT_PATH, APPLY_RESULT_JSON);
      expect(result.env).toBe(BASE_ENV);
      expect(result.snapshotPath).toBe(SNAPSHOT_PATH);
    });
  });

  // ── compile fails after validate passes ──────────────────────────────────────

  describe('compile fails after validate passes', () => {
    beforeEach(() => {
      mockedExecFileSync
        .mockReturnValueOnce('' as any)                                            // validate: ok
        .mockImplementationOnce(() => { throw new Error('compile error: syntax'); }); // compile: fail
    });

    it('returns onFailure=true', async () => {
      const result = await genesisCompileValidate(true, BASE_ENV, CONFIG_JSON, SNAPSHOT_PATH, APPLY_RESULT_JSON);
      expect(result.onSuccess).toBe(false);
      expect(result.onFailure).toBe(true);
    });

    it('calls execFileSync twice (validate + compile)', async () => {
      await genesisCompileValidate(true, BASE_ENV, CONFIG_JSON, SNAPSHOT_PATH, APPLY_RESULT_JSON);
      expect(mockedExecFileSync).toHaveBeenCalledTimes(2);
    });

    it('calls loadSnapshot to restore from snapshot', async () => {
      await genesisCompileValidate(true, BASE_ENV, CONFIG_JSON, SNAPSHOT_PATH, APPLY_RESULT_JSON);
      expect(mockLoadSnapshot).toHaveBeenCalledWith(SNAPSHOT_PATH);
    });

    it('restores file when compile fails', async () => {
      mockLoadSnapshot.mockReturnValue('// backed up content');
      await genesisCompileValidate(true, BASE_ENV, CONFIG_JSON, SNAPSHOT_PATH, APPLY_RESULT_JSON);
      expect(mockedWriteFileSync).toHaveBeenCalledOnce();
      expect(mockedWriteFileSync.mock.calls[0][1]).toBe('// backed up content');
    });
  });

  // ── snapshot not found (loadSnapshot returns null) ────────────────────────────

  describe('snapshot not found (loadSnapshot returns null)', () => {
    beforeEach(() => {
      mockedExecFileSync.mockImplementationOnce(() => { throw new Error('validate failed'); });
      mockLoadSnapshot.mockReturnValue(null);
    });

    it('returns onFailure=true without crashing', async () => {
      const result = await genesisCompileValidate(true, BASE_ENV, CONFIG_JSON, SNAPSHOT_PATH, APPLY_RESULT_JSON);
      expect(result.onSuccess).toBe(false);
      expect(result.onFailure).toBe(true);
    });

    it('does not call writeFileSync when snapshot is null', async () => {
      await genesisCompileValidate(true, BASE_ENV, CONFIG_JSON, SNAPSHOT_PATH, APPLY_RESULT_JSON);
      expect(mockedWriteFileSync).not.toHaveBeenCalled();
    });

    it('still passes env through', async () => {
      const result = await genesisCompileValidate(true, BASE_ENV, CONFIG_JSON, SNAPSHOT_PATH, APPLY_RESULT_JSON);
      expect(result.env).toBe(BASE_ENV);
    });
  });
});
