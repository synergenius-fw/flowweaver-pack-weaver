import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WeaverEnv, GenesisConfig, GenesisContext } from '../src/bot/types.js';

// ── Mock GenesisStore ─────────────────────────────────────────────────────────

const { mockLoadConfig, mockNewCycleId, MockGenesisStore } = vi.hoisted(() => {
  const mockLoadConfig = vi.fn<() => GenesisConfig>();
  const mockNewCycleId = vi.fn<() => string>().mockReturnValue('test-cycle-id');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const MockGenesisStore = vi.fn(function (this: { loadConfig: typeof mockLoadConfig }) {
    this.loadConfig = mockLoadConfig;
  }) as any;
  MockGenesisStore.newCycleId = mockNewCycleId;
  return { mockLoadConfig, mockNewCycleId, MockGenesisStore };
});

vi.mock('../src/bot/genesis-store.js', () => ({
  GenesisStore: MockGenesisStore,
}));

// ── Mock fs ───────────────────────────────────────────────────────────────────

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    statSync: vi.fn(),
  };
});

import * as fs from 'node:fs';
import { genesisLoadConfig } from '../src/node-types/genesis-load-config.js';

const mockedExistsSync = vi.mocked(fs.existsSync);
const mockedStatSync = vi.mocked(fs.statSync);

// ── helpers ───────────────────────────────────────────────────────────────────

const BASE_ENV: WeaverEnv = {
  projectDir: '/test',
  config: { provider: 'auto' },
  providerType: 'anthropic',
  providerInfo: { type: 'anthropic', apiKey: 'key' },
};

const DEFAULT_CONFIG: GenesisConfig = {
  intent: 'Improve workflow reliability and efficiency',
  focus: [],
  constraints: [],
  approvalThreshold: 'MINOR',
  budgetPerCycle: 3,
  stabilize: false,
  targetWorkflow: 'src/workflows/my-workflow.ts',
  maxCyclesPerRun: 10,
};

/** Make fs checks pass (file exists and is a regular file). */
function mockFileExists(): void {
  mockedExistsSync.mockReturnValue(true);
  mockedStatSync.mockReturnValue({ isFile: () => true } as any);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('genesisLoadConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Happy-path defaults
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG });
    mockNewCycleId.mockReturnValue('test-cycle-id');
    mockFileExists();
  });

  // ── happy path ──────────────────────────────────────────────────────────────

  it('returns ctx with genesisConfigJson when config is valid and file exists', () => {
    const result = genesisLoadConfig(BASE_ENV);
    expect(result).toHaveProperty('ctx');
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(ctx.genesisConfigJson).toBeDefined();
  });

  it('genesisConfigJson in ctx contains all fields from loadConfig result', () => {
    const customConfig: GenesisConfig = {
      ...DEFAULT_CONFIG,
      intent: 'improve test coverage',
      focus: ['src/node-types'],
      budgetPerCycle: 5,
    };
    mockLoadConfig.mockReturnValue(customConfig);

    const result = genesisLoadConfig(BASE_ENV);
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    const config = JSON.parse(ctx.genesisConfigJson) as GenesisConfig;

    expect(config.intent).toBe('improve test coverage');
    expect(config.focus).toEqual(['src/node-types']);
    expect(config.budgetPerCycle).toBe(5);
    expect(config.targetWorkflow).toBe(DEFAULT_CONFIG.targetWorkflow);
  });

  it('returns default config fields when loadConfig returns defaults (no config.json)', () => {
    // Simulates the case where GenesisStore.loadConfig returns defaults
    // because no .genesis/config.json exists yet
    const defaults: GenesisConfig = {
      intent: 'Improve workflow reliability and efficiency',
      focus: [],
      constraints: [],
      approvalThreshold: 'MINOR',
      budgetPerCycle: 3,
      stabilize: false,
      targetWorkflow: 'workflow.ts',
      maxCyclesPerRun: 10,
    };
    mockLoadConfig.mockReturnValue(defaults);

    const result = genesisLoadConfig(BASE_ENV);
    const config = JSON.parse(JSON.parse(result.ctx).genesisConfigJson) as GenesisConfig;

    expect(config.approvalThreshold).toBe('MINOR');
    expect(config.budgetPerCycle).toBe(3);
    expect(config.stabilize).toBe(false);
    expect(config.maxCyclesPerRun).toBe(10);
  });

  it('merges loaded fields with defaults: partial config has all default fields filled in', () => {
    // Simulates GenesisStore merging { ...DEFAULT_CONFIG, ...raw }
    const merged: GenesisConfig = {
      intent: 'custom intent',           // overridden
      focus: ['workflows'],              // overridden
      constraints: [],                   // from default
      approvalThreshold: 'BREAKING',     // overridden
      budgetPerCycle: 3,                 // from default
      stabilize: false,                  // from default
      targetWorkflow: 'my-wf.ts',        // overridden
      maxCyclesPerRun: 10,               // from default
    };
    mockLoadConfig.mockReturnValue(merged);

    const result = genesisLoadConfig({ ...BASE_ENV, projectDir: '/test' });
    const config = JSON.parse(JSON.parse(result.ctx).genesisConfigJson) as GenesisConfig;

    // Overridden fields
    expect(config.intent).toBe('custom intent');
    expect(config.approvalThreshold).toBe('BREAKING');
    // Default fields preserved
    expect(config.budgetPerCycle).toBe(3);
    expect(config.maxCyclesPerRun).toBe(10);
    expect(config.constraints).toEqual([]);
  });

  it('ctx includes cycleId from GenesisStore.newCycleId()', () => {
    mockNewCycleId.mockReturnValue('abc12345');

    const result = genesisLoadConfig(BASE_ENV);
    const ctx = JSON.parse(result.ctx) as GenesisContext;

    expect(ctx.cycleId).toBe('abc12345');
  });

  it('ctx includes startTimeMs close to the current time', () => {
    const before = Date.now();
    const result = genesisLoadConfig(BASE_ENV);
    const after = Date.now();
    const ctx = JSON.parse(result.ctx) as GenesisContext;

    expect(ctx.startTimeMs).toBeGreaterThanOrEqual(before);
    expect(ctx.startTimeMs).toBeLessThanOrEqual(after);
  });

  it('ctx preserves the input env bundle', () => {
    const result = genesisLoadConfig(BASE_ENV);
    const ctx = JSON.parse(result.ctx) as GenesisContext;

    expect(ctx.env.projectDir).toBe('/test');
    expect(ctx.env.providerType).toBe('anthropic');
  });

  it('passes projectDir to GenesisStore constructor', () => {
    genesisLoadConfig(BASE_ENV);
    expect(MockGenesisStore).toHaveBeenCalledWith('/test');
  });

  // ── required field validation ───────────────────────────────────────────────

  it('throws when config.targetWorkflow is empty string', () => {
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG, targetWorkflow: '' });
    expect(() => genesisLoadConfig(BASE_ENV)).toThrow(/targetWorkflow/);
  });

  it('throws when config.targetWorkflow is missing (undefined cast)', () => {
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG, targetWorkflow: undefined as any });
    expect(() => genesisLoadConfig(BASE_ENV)).toThrow();
  });

  it('error message for missing targetWorkflow mentions how to fix it', () => {
    mockLoadConfig.mockReturnValue({ ...DEFAULT_CONFIG, targetWorkflow: '' });
    expect(() => genesisLoadConfig(BASE_ENV)).toThrow(/config\.json/);
  });

  // ── target workflow file validation ────────────────────────────────────────

  it('throws when target workflow file does not exist', () => {
    mockedExistsSync.mockReturnValue(false);
    expect(() => genesisLoadConfig(BASE_ENV)).toThrow(/not found/);
  });

  it('throws when target path is a directory (isFile returns false)', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedStatSync.mockReturnValue({ isFile: () => false } as any);
    expect(() => genesisLoadConfig(BASE_ENV)).toThrow(/not found/);
  });

  it('error message for missing file contains the resolved path', () => {
    mockedExistsSync.mockReturnValue(false);
    expect(() => genesisLoadConfig(BASE_ENV)).toThrow(/src\/workflows\/my-workflow\.ts/);
  });
});
