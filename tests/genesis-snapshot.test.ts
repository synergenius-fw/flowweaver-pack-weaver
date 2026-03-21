import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GenesisConfig, GenesisContext } from '../src/bot/types.js';

const { MockGenesisStore } = vi.hoisted(() => {
  const MockGenesisStore = vi.fn(function (this: { saveSnapshot: ReturnType<typeof vi.fn> }) {
    this.saveSnapshot = vi.fn().mockReturnValue('/proj/.genesis/snapshots/snap-001.ts');
  }) as any;
  return { MockGenesisStore };
});

vi.mock('../src/bot/genesis-store.js', () => ({
  GenesisStore: MockGenesisStore,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, readFileSync: vi.fn().mockReturnValue('// workflow content') };
});

import * as fs from 'node:fs';
import { genesisSnapshot } from '../src/node-types/genesis-snapshot.js';

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
    ...overrides,
  };
  return JSON.stringify(ctx);
}

describe('genesisSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockReadFileSync.mockReturnValue('// workflow content' as any);
    // Re-initialize store mock so saveSnapshot returns default path
    MockGenesisStore.mockImplementation(function (this: any) {
      this.saveSnapshot = vi.fn().mockReturnValue('/proj/.genesis/snapshots/snap-001.ts');
    });
  });

  describe('basic success', () => {
    it('returns ctx with snapshotPath set', () => {
      const result = genesisSnapshot(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.snapshotPath).toBe('/proj/.genesis/snapshots/snap-001.ts');
    });

    it('reads the target workflow file', () => {
      genesisSnapshot(makeCtx());
      expect(mockReadFileSync).toHaveBeenCalledWith(
        expect.stringContaining('my-workflow.ts'),
        'utf-8',
      );
    });

    it('passes cycleId to saveSnapshot', () => {
      genesisSnapshot(makeCtx({ cycleId: 'cycle-xyz' }));
      const instance = MockGenesisStore.mock.instances[0] as any;
      expect(instance.saveSnapshot).toHaveBeenCalledWith('cycle-xyz', expect.any(String));
    });

    it('passes file content to saveSnapshot', () => {
      mockReadFileSync.mockReturnValue('export function myWorkflow() {}' as any);
      genesisSnapshot(makeCtx());
      const instance = MockGenesisStore.mock.instances[0] as any;
      expect(instance.saveSnapshot).toHaveBeenCalledWith(
        expect.any(String),
        'export function myWorkflow() {}',
      );
    });

    it('constructs GenesisStore with projectDir', () => {
      genesisSnapshot(makeCtx());
      expect(MockGenesisStore).toHaveBeenCalledWith('/proj');
    });
  });

  describe('ctx preservation', () => {
    it('preserves other ctx fields', () => {
      const result = genesisSnapshot(makeCtx({ cycleId: 'cycle-abc' }));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.cycleId).toBe('cycle-abc');
    });

    it('preserves env in output ctx', () => {
      const result = genesisSnapshot(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.env.projectDir).toBe('/proj');
    });
  });

  describe('target workflow path resolution', () => {
    it('resolves targetWorkflow relative to projectDir', () => {
      genesisSnapshot(makeCtx());
      const [filePath] = mockReadFileSync.mock.calls[0] as [string, string];
      expect(filePath).toMatch(/^\/proj\//);
      expect(filePath).toContain('my-workflow.ts');
    });

    it('uses the snapshotPath returned by saveSnapshot', () => {
      MockGenesisStore.mockImplementation(function (this: any) {
        this.saveSnapshot = vi.fn().mockReturnValue('/proj/.genesis/snapshots/custom-snap.ts');
      });
      const result = genesisSnapshot(makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.snapshotPath).toBe('/proj/.genesis/snapshots/custom-snap.ts');
    });
  });

  describe('logging', () => {
    it('logs snapshot path after saving', () => {
      genesisSnapshot(makeCtx());
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('Snapshot saved'),
      );
    });

    it('logs the actual snapshot path', () => {
      genesisSnapshot(makeCtx());
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('snap-001.ts'),
      );
    });
  });

  describe('expression node — throws on error', () => {
    it('throws when readFileSync fails', () => {
      mockReadFileSync.mockImplementation(() => { throw new Error('file not found'); });
      expect(() => genesisSnapshot(makeCtx())).toThrow('file not found');
    });

    it('throws when saveSnapshot fails', () => {
      MockGenesisStore.mockImplementation(function (this: any) {
        this.saveSnapshot = vi.fn().mockImplementation(() => { throw new Error('disk full'); });
      });
      expect(() => genesisSnapshot(makeCtx())).toThrow('disk full');
    });
  });
});
