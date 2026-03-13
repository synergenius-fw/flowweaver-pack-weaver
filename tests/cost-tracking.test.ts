import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CostTracker, MODEL_PRICING } from '../src/bot/cost-tracker.js';
import { CostStore } from '../src/bot/cost-store.js';
import type { TokenUsage, CostRecord } from '../src/bot/types.js';

// ---------------------------------------------------------------------------
// MODEL_PRICING
// ---------------------------------------------------------------------------

describe('MODEL_PRICING', () => {
  it('contains entries for known Claude models', () => {
    const expectedModels = [
      'claude-sonnet-4-6',
      'claude-sonnet-4-20250514',
      'claude-opus-4-6',
      'claude-opus-4-20250514',
      'claude-haiku-4-5',
      'claude-3-5-haiku-20241022',
      'claude-3-5-sonnet-20241022',
    ];
    for (const model of expectedModels) {
      expect(MODEL_PRICING[model]).toBeDefined();
    }
  });

  it('every entry has inputPer1M and outputPer1M as positive numbers', () => {
    for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
      expect(pricing.inputPer1M).toBeGreaterThan(0);
      expect(pricing.outputPer1M).toBeGreaterThan(0);
    }
  });

  it('every entry has cache pricing fields', () => {
    for (const [, pricing] of Object.entries(MODEL_PRICING)) {
      expect(typeof pricing.cacheReadPer1M).toBe('number');
      expect(typeof pricing.cacheCreationPer1M).toBe('number');
    }
  });

  it('opus models are more expensive than sonnet models', () => {
    const opus = MODEL_PRICING['claude-opus-4-6']!;
    const sonnet = MODEL_PRICING['claude-sonnet-4-6']!;
    expect(opus.inputPer1M).toBeGreaterThan(sonnet.inputPer1M);
    expect(opus.outputPer1M).toBeGreaterThan(sonnet.outputPer1M);
  });
});

// ---------------------------------------------------------------------------
// CostTracker.estimateCost
// ---------------------------------------------------------------------------

describe('CostTracker.estimateCost', () => {
  it('returns 0 for an unknown model', () => {
    const usage: TokenUsage = { inputTokens: 1000, outputTokens: 500 };
    expect(CostTracker.estimateCost('unknown-model-xyz', usage)).toBe(0);
  });

  it('calculates cost for a known model with basic usage', () => {
    const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    const cost = CostTracker.estimateCost('claude-sonnet-4-6', usage);
    // input: 1M * 3/1M = 3, output: 1M * 15/1M = 15 => total 18
    expect(cost).toBeCloseTo(18, 5);
  });

  it('calculates cost correctly for zero tokens', () => {
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    expect(CostTracker.estimateCost('claude-sonnet-4-6', usage)).toBe(0);
  });

  it('includes cache read tokens in cost', () => {
    const usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 1_000_000,
    };
    const cost = CostTracker.estimateCost('claude-sonnet-4-6', usage);
    // 1M * 0.3/1M = 0.3
    expect(cost).toBeCloseTo(0.3, 5);
  });

  it('includes cache creation tokens in cost', () => {
    const usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 1_000_000,
    };
    const cost = CostTracker.estimateCost('claude-sonnet-4-6', usage);
    // 1M * 3.75/1M = 3.75
    expect(cost).toBeCloseTo(3.75, 5);
  });

  it('combines all token types correctly', () => {
    const usage: TokenUsage = {
      inputTokens: 500_000,
      outputTokens: 200_000,
      cacheReadInputTokens: 300_000,
      cacheCreationInputTokens: 100_000,
    };
    const cost = CostTracker.estimateCost('claude-sonnet-4-6', usage);
    // input: 0.5M * 3 = 1.5
    // output: 0.2M * 15 = 3.0
    // cacheRead: 0.3M * 0.3 = 0.09
    // cacheCreation: 0.1M * 3.75 = 0.375
    // total: 4.965
    expect(cost).toBeCloseTo(4.965, 5);
  });

  it('handles opus model pricing', () => {
    const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    const cost = CostTracker.estimateCost('claude-opus-4-6', usage);
    // input: 15 + output: 75 = 90
    expect(cost).toBeCloseTo(90, 5);
  });

  it('handles haiku model pricing', () => {
    const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    const cost = CostTracker.estimateCost('claude-haiku-4-5', usage);
    // input: 0.8 + output: 4 = 4.8
    expect(cost).toBeCloseTo(4.8, 5);
  });

  it('handles small token counts without floating point issues', () => {
    const usage: TokenUsage = { inputTokens: 1, outputTokens: 1 };
    const cost = CostTracker.estimateCost('claude-sonnet-4-6', usage);
    // (3 + 15) / 1_000_000 = 0.000018
    expect(cost).toBeCloseTo(0.000018, 10);
  });
});

// ---------------------------------------------------------------------------
// CostTracker instance methods
// ---------------------------------------------------------------------------

describe('CostTracker', () => {
  it('starts with no entries', () => {
    const tracker = new CostTracker('claude-sonnet-4-6', 'anthropic');
    expect(tracker.hasEntries()).toBe(false);
  });

  it('hasEntries returns true after tracking', () => {
    const tracker = new CostTracker('claude-sonnet-4-6', 'anthropic');
    tracker.track('step-1', 'claude-sonnet-4-6', { inputTokens: 100, outputTokens: 50 });
    expect(tracker.hasEntries()).toBe(true);
  });

  it('getRunSummary returns defaults when no entries are tracked', () => {
    const tracker = new CostTracker('claude-sonnet-4-6', 'anthropic');
    const summary = tracker.getRunSummary();
    expect(summary.totalInputTokens).toBe(0);
    expect(summary.totalOutputTokens).toBe(0);
    expect(summary.totalCost).toBe(0);
    expect(summary.model).toBe('claude-sonnet-4-6');
    expect(summary.provider).toBe('anthropic');
    expect(summary.entries).toEqual([]);
  });

  it('getRunSummary uses defaultModel when no entries exist', () => {
    const tracker = new CostTracker('claude-opus-4-6', 'anthropic');
    expect(tracker.getRunSummary().model).toBe('claude-opus-4-6');
  });

  it('getRunSummary totals multiple tracked entries', () => {
    const tracker = new CostTracker('claude-sonnet-4-6', 'anthropic');

    tracker.track('plan', 'claude-sonnet-4-6', { inputTokens: 1000, outputTokens: 500 });
    tracker.track('execute', 'claude-sonnet-4-6', { inputTokens: 2000, outputTokens: 1000 });
    tracker.track('validate', 'claude-sonnet-4-6', { inputTokens: 500, outputTokens: 200 });

    const summary = tracker.getRunSummary();
    expect(summary.totalInputTokens).toBe(3500);
    expect(summary.totalOutputTokens).toBe(1700);
    expect(summary.entries).toHaveLength(3);
    expect(summary.totalCost).toBeGreaterThan(0);
  });

  it('getRunSummary uses the first entry model, not defaultModel', () => {
    const tracker = new CostTracker('claude-sonnet-4-6', 'anthropic');
    tracker.track('step-1', 'claude-opus-4-6', { inputTokens: 100, outputTokens: 50 });
    expect(tracker.getRunSummary().model).toBe('claude-opus-4-6');
  });

  it('getRunSummary preserves provider', () => {
    const tracker = new CostTracker('claude-sonnet-4-6', 'custom-provider');
    tracker.track('step-1', 'claude-sonnet-4-6', { inputTokens: 100, outputTokens: 50 });
    expect(tracker.getRunSummary().provider).toBe('custom-provider');
  });

  it('getRunSummary returns a copy of entries (not a reference)', () => {
    const tracker = new CostTracker('claude-sonnet-4-6', 'anthropic');
    tracker.track('step-1', 'claude-sonnet-4-6', { inputTokens: 100, outputTokens: 50 });
    const entries1 = tracker.getRunSummary().entries;
    const entries2 = tracker.getRunSummary().entries;
    expect(entries1).not.toBe(entries2);
    expect(entries1).toEqual(entries2);
  });

  it('track records estimated cost per entry', () => {
    const tracker = new CostTracker('claude-sonnet-4-6', 'anthropic');
    tracker.track('step-1', 'claude-sonnet-4-6', { inputTokens: 1_000_000, outputTokens: 0 });

    const summary = tracker.getRunSummary();
    // 1M input * 3/1M = 3.0
    expect(summary.entries[0]!.estimatedCost).toBeCloseTo(3.0, 5);
    expect(summary.totalCost).toBeCloseTo(3.0, 5);
  });

  it('track records timestamps', () => {
    const before = Date.now();
    const tracker = new CostTracker('claude-sonnet-4-6', 'anthropic');
    tracker.track('step-1', 'claude-sonnet-4-6', { inputTokens: 100, outputTokens: 50 });
    const after = Date.now();

    const entry = tracker.getRunSummary().entries[0]!;
    expect(entry.timestamp).toBeGreaterThanOrEqual(before);
    expect(entry.timestamp).toBeLessThanOrEqual(after);
  });

  it('tracks entries with unknown model (cost is 0)', () => {
    const tracker = new CostTracker('unknown-model', 'anthropic');
    tracker.track('step-1', 'unknown-model', { inputTokens: 1000, outputTokens: 500 });
    const summary = tracker.getRunSummary();
    expect(summary.totalCost).toBe(0);
    expect(summary.totalInputTokens).toBe(1000);
    expect(summary.totalOutputTokens).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// CostStore
// ---------------------------------------------------------------------------

describe('CostStore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeRecord(overrides?: Partial<CostRecord>): CostRecord {
    return {
      timestamp: Date.now(),
      workflowFile: 'test.yaml',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCost: 0.0105,
      steps: 3,
      ...overrides,
    };
  }

  // --- Basic operations ---

  it('creates the directory if it does not exist', () => {
    const nestedDir = path.join(tmpDir, 'nested', 'dir');
    const store = new CostStore(nestedDir);
    expect(fs.existsSync(nestedDir)).toBe(true);
  });

  it('query returns empty array on empty store', () => {
    const store = new CostStore(tmpDir);
    expect(store.query()).toEqual([]);
  });

  it('summarize returns zero totals on empty store', () => {
    const store = new CostStore(tmpDir);
    const summary = store.summarize();
    expect(summary.totalCost).toBe(0);
    expect(summary.totalInputTokens).toBe(0);
    expect(summary.totalOutputTokens).toBe(0);
    expect(summary.totalRuns).toBe(0);
    expect(summary.byModel).toEqual({});
  });

  it('appends and queries a single record', () => {
    const store = new CostStore(tmpDir);
    const record = makeRecord();
    store.append(record);

    const results = store.query();
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(record);
  });

  it('appends and queries multiple records', () => {
    const store = new CostStore(tmpDir);
    const r1 = makeRecord({ timestamp: 1000 });
    const r2 = makeRecord({ timestamp: 2000 });
    const r3 = makeRecord({ timestamp: 3000 });

    store.append(r1);
    store.append(r2);
    store.append(r3);

    const results = store.query();
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual(r1);
    expect(results[1]).toEqual(r2);
    expect(results[2]).toEqual(r3);
  });

  it('persists records across store instances', () => {
    const store1 = new CostStore(tmpDir);
    store1.append(makeRecord({ timestamp: 1000 }));
    store1.append(makeRecord({ timestamp: 2000 }));

    const store2 = new CostStore(tmpDir);
    expect(store2.query()).toHaveLength(2);
  });

  // --- Filtering ---

  it('filters by since timestamp', () => {
    const store = new CostStore(tmpDir);
    store.append(makeRecord({ timestamp: 1000 }));
    store.append(makeRecord({ timestamp: 2000 }));
    store.append(makeRecord({ timestamp: 3000 }));

    const results = store.query({ since: 2000 });
    expect(results).toHaveLength(2);
    expect(results[0]!.timestamp).toBe(2000);
    expect(results[1]!.timestamp).toBe(3000);
  });

  it('filters by model', () => {
    const store = new CostStore(tmpDir);
    store.append(makeRecord({ model: 'claude-sonnet-4-6' }));
    store.append(makeRecord({ model: 'claude-opus-4-6' }));
    store.append(makeRecord({ model: 'claude-sonnet-4-6' }));

    const results = store.query({ model: 'claude-opus-4-6' });
    expect(results).toHaveLength(1);
    expect(results[0]!.model).toBe('claude-opus-4-6');
  });

  it('combines since and model filters', () => {
    const store = new CostStore(tmpDir);
    store.append(makeRecord({ timestamp: 1000, model: 'claude-sonnet-4-6' }));
    store.append(makeRecord({ timestamp: 2000, model: 'claude-opus-4-6' }));
    store.append(makeRecord({ timestamp: 3000, model: 'claude-sonnet-4-6' }));
    store.append(makeRecord({ timestamp: 4000, model: 'claude-opus-4-6' }));

    const results = store.query({ since: 2500, model: 'claude-opus-4-6' });
    expect(results).toHaveLength(1);
    expect(results[0]!.timestamp).toBe(4000);
  });

  it('returns empty array when no records match filters', () => {
    const store = new CostStore(tmpDir);
    store.append(makeRecord({ timestamp: 1000, model: 'claude-sonnet-4-6' }));

    expect(store.query({ model: 'nonexistent-model' })).toEqual([]);
    expect(store.query({ since: 9999 })).toEqual([]);
  });

  // --- Summarize ---

  it('summarize totals all records', () => {
    const store = new CostStore(tmpDir);
    store.append(makeRecord({ inputTokens: 1000, outputTokens: 200, estimatedCost: 0.01 }));
    store.append(makeRecord({ inputTokens: 2000, outputTokens: 400, estimatedCost: 0.02 }));

    const summary = store.summarize();
    expect(summary.totalInputTokens).toBe(3000);
    expect(summary.totalOutputTokens).toBe(600);
    expect(summary.totalCost).toBeCloseTo(0.03, 10);
    expect(summary.totalRuns).toBe(2);
  });

  it('summarize groups by model', () => {
    const store = new CostStore(tmpDir);
    store.append(makeRecord({ model: 'claude-sonnet-4-6', inputTokens: 100, outputTokens: 50, estimatedCost: 0.01 }));
    store.append(makeRecord({ model: 'claude-opus-4-6', inputTokens: 200, outputTokens: 100, estimatedCost: 0.05 }));
    store.append(makeRecord({ model: 'claude-sonnet-4-6', inputTokens: 300, outputTokens: 150, estimatedCost: 0.02 }));

    const summary = store.summarize();
    expect(Object.keys(summary.byModel)).toHaveLength(2);

    const sonnet = summary.byModel['claude-sonnet-4-6']!;
    expect(sonnet.runs).toBe(2);
    expect(sonnet.inputTokens).toBe(400);
    expect(sonnet.outputTokens).toBe(200);
    expect(sonnet.cost).toBeCloseTo(0.03, 10);

    const opus = summary.byModel['claude-opus-4-6']!;
    expect(opus.runs).toBe(1);
    expect(opus.inputTokens).toBe(200);
    expect(opus.outputTokens).toBe(100);
    expect(opus.cost).toBeCloseTo(0.05, 10);
  });

  it('summarize respects filters', () => {
    const store = new CostStore(tmpDir);
    store.append(makeRecord({ timestamp: 1000, model: 'claude-sonnet-4-6', estimatedCost: 0.01 }));
    store.append(makeRecord({ timestamp: 2000, model: 'claude-opus-4-6', estimatedCost: 0.05 }));
    store.append(makeRecord({ timestamp: 3000, model: 'claude-sonnet-4-6', estimatedCost: 0.02 }));

    const summary = store.summarize({ since: 1500 });
    expect(summary.totalRuns).toBe(2);
    expect(summary.totalCost).toBeCloseTo(0.07, 10);
  });

  it('summarize uses "unknown" for records with empty model', () => {
    const store = new CostStore(tmpDir);
    store.append(makeRecord({ model: '' as string, estimatedCost: 0.01 }));

    const summary = store.summarize();
    expect(summary.byModel['unknown']).toBeDefined();
    expect(summary.byModel['unknown']!.runs).toBe(1);
  });

  // --- Corrupt NDJSON handling ---

  it('handles corrupt NDJSON lines gracefully', () => {
    const store = new CostStore(tmpDir);
    const filePath = path.join(tmpDir, 'costs.ndjson');

    // Write mix of valid and corrupt lines
    const validRecord = makeRecord({ timestamp: 1000 });
    const lines = [
      JSON.stringify(validRecord),
      'this is not valid json',
      '{broken json',
      JSON.stringify(makeRecord({ timestamp: 2000 })),
    ];
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');

    const results = store.query();
    expect(results).toHaveLength(2);
    expect(results[0]!.timestamp).toBe(1000);
    expect(results[1]!.timestamp).toBe(2000);
  });

  it('handles completely corrupt file', () => {
    const store = new CostStore(tmpDir);
    const filePath = path.join(tmpDir, 'costs.ndjson');
    fs.writeFileSync(filePath, 'garbage\nnonsense\n!!!', 'utf-8');

    const results = store.query();
    expect(results).toEqual([]);
  });

  it('handles empty file', () => {
    const store = new CostStore(tmpDir);
    const filePath = path.join(tmpDir, 'costs.ndjson');
    fs.writeFileSync(filePath, '', 'utf-8');

    expect(store.query()).toEqual([]);
  });

  it('handles file with only whitespace/blank lines', () => {
    const store = new CostStore(tmpDir);
    const filePath = path.join(tmpDir, 'costs.ndjson');
    fs.writeFileSync(filePath, '\n\n  \n\n', 'utf-8');

    expect(store.query()).toEqual([]);
  });

  // --- enforceCap ---

  it('enforces cap at 10_000 entries after every 100 appends', () => {
    const store = new CostStore(tmpDir);
    const filePath = path.join(tmpDir, 'costs.ndjson');

    // Pre-fill the file with 10_000 lines to simulate being at cap
    const lines: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      lines.push(JSON.stringify(makeRecord({ timestamp: i })));
    }
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');

    // Now use a fresh store and append exactly 100 entries to trigger enforceCap
    const store2 = new CostStore(tmpDir);
    for (let i = 0; i < 100; i++) {
      store2.append(makeRecord({ timestamp: 100_000 + i }));
    }

    // After enforceCap, should have exactly 10_000 entries (the most recent ones)
    const results = store2.query();
    expect(results).toHaveLength(10_000);
    // The oldest entries should have been pruned; the newest 10_000 remain
    // Last entry should be timestamp 100_099
    expect(results[results.length - 1]!.timestamp).toBe(100_099);
    // First entry should be timestamp 100 (entries 0-99 pruned)
    expect(results[0]!.timestamp).toBe(100);
  });

  it('does not enforce cap before 100 appends', () => {
    const store = new CostStore(tmpDir);
    const filePath = path.join(tmpDir, 'costs.ndjson');

    // Pre-fill with 10_050 lines
    const lines: string[] = [];
    for (let i = 0; i < 10_050; i++) {
      lines.push(JSON.stringify(makeRecord({ timestamp: i })));
    }
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');

    // Append only 50 records (less than CAP_CHECK_INTERVAL of 100)
    const store2 = new CostStore(tmpDir);
    for (let i = 0; i < 50; i++) {
      store2.append(makeRecord({ timestamp: 50_000 + i }));
    }

    // Cap not enforced yet, so all 10_100 entries should still be there
    const results = store2.query();
    expect(results).toHaveLength(10_100);
  });

  it('enforceCap keeps exactly MAX_ENTRIES most recent lines', () => {
    const store = new CostStore(tmpDir);
    const filePath = path.join(tmpDir, 'costs.ndjson');

    // Pre-fill with 10_500 lines
    const lines: string[] = [];
    for (let i = 0; i < 10_500; i++) {
      lines.push(JSON.stringify(makeRecord({ timestamp: i })));
    }
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');

    // Append 100 to trigger enforceCap
    const store2 = new CostStore(tmpDir);
    for (let i = 0; i < 100; i++) {
      store2.append(makeRecord({ timestamp: 20_000 + i }));
    }

    const results = store2.query();
    expect(results).toHaveLength(10_000);
    // Most recent entry should be the last appended
    expect(results[results.length - 1]!.timestamp).toBe(20_099);
  });

  // --- Edge cases ---

  it('handles records with zero tokens', () => {
    const store = new CostStore(tmpDir);
    store.append(makeRecord({ inputTokens: 0, outputTokens: 0, estimatedCost: 0 }));

    const results = store.query();
    expect(results).toHaveLength(1);
    expect(results[0]!.inputTokens).toBe(0);
    expect(results[0]!.outputTokens).toBe(0);

    const summary = store.summarize();
    expect(summary.totalCost).toBe(0);
    expect(summary.totalRuns).toBe(1);
  });

  it('handles records with very large token counts', () => {
    const store = new CostStore(tmpDir);
    store.append(makeRecord({ inputTokens: 1_000_000_000, outputTokens: 500_000_000 }));

    const results = store.query();
    expect(results).toHaveLength(1);
    expect(results[0]!.inputTokens).toBe(1_000_000_000);
  });

  it('query works with file that does not exist yet', () => {
    // Use a subdir that exists but where costs.ndjson has not been created
    const subDir = path.join(tmpDir, 'empty-sub');
    fs.mkdirSync(subDir, { recursive: true });
    const store = new CostStore(subDir);
    expect(store.query()).toEqual([]);
  });
});
