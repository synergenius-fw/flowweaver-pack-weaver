import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CostStore } from '../src/bot/cost-store.js';
import type { CostRecord } from '../src/bot/types.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cost-store-test-'));
}

function makeRecord(overrides: Partial<CostRecord> = {}): CostRecord {
  return {
    timestamp: Date.now(),
    workflowFile: 'test.flow.ts',
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    inputTokens: 1000,
    outputTokens: 500,
    estimatedCost: 0.012,
    steps: 3,
    ...overrides,
  };
}

describe('CostStore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('creates the directory if it does not exist', () => {
      const nested = path.join(tmpDir, 'deep', 'nested');
      new CostStore(nested);
      expect(fs.existsSync(nested)).toBe(true);
    });

    it('works if directory already exists', () => {
      // Should not throw
      new CostStore(tmpDir);
      expect(fs.existsSync(tmpDir)).toBe(true);
    });
  });

  describe('append', () => {
    it('writes a valid NDJSON line', () => {
      const store = new CostStore(tmpDir);
      const record = makeRecord();
      store.append(record);

      const content = fs.readFileSync(path.join(tmpDir, 'costs.ndjson'), 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toEqual(record);
    });

    it('accumulates multiple entries', () => {
      const store = new CostStore(tmpDir);
      store.append(makeRecord({ inputTokens: 100 }));
      store.append(makeRecord({ inputTokens: 200 }));
      store.append(makeRecord({ inputTokens: 300 }));

      const content = fs.readFileSync(path.join(tmpDir, 'costs.ndjson'), 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(3);
    });
  });

  describe('query', () => {
    it('returns empty array when file does not exist', () => {
      const store = new CostStore(tmpDir);
      expect(store.query()).toEqual([]);
    });

    it('returns all records with no filters', () => {
      const store = new CostStore(tmpDir);
      const r1 = makeRecord({ inputTokens: 100 });
      const r2 = makeRecord({ inputTokens: 200 });
      store.append(r1);
      store.append(r2);

      const results = store.query();
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual(r1);
      expect(results[1]).toEqual(r2);
    });

    it('filters by since timestamp', () => {
      const store = new CostStore(tmpDir);
      const old = makeRecord({ timestamp: 1000, inputTokens: 100 });
      const recent = makeRecord({ timestamp: 5000, inputTokens: 200 });
      store.append(old);
      store.append(recent);

      const results = store.query({ since: 3000 });
      expect(results).toHaveLength(1);
      expect(results[0]!.inputTokens).toBe(200);
    });

    it('filters by model', () => {
      const store = new CostStore(tmpDir);
      store.append(makeRecord({ model: 'claude-sonnet-4-20250514' }));
      store.append(makeRecord({ model: 'claude-haiku-35' }));
      store.append(makeRecord({ model: 'claude-sonnet-4-20250514' }));

      const results = store.query({ model: 'claude-haiku-35' });
      expect(results).toHaveLength(1);
      expect(results[0]!.model).toBe('claude-haiku-35');
    });

    it('combines since and model filters', () => {
      const store = new CostStore(tmpDir);
      store.append(makeRecord({ timestamp: 1000, model: 'sonnet' }));
      store.append(makeRecord({ timestamp: 5000, model: 'haiku' }));
      store.append(makeRecord({ timestamp: 5000, model: 'sonnet' }));
      store.append(makeRecord({ timestamp: 1000, model: 'haiku' }));

      const results = store.query({ since: 3000, model: 'sonnet' });
      expect(results).toHaveLength(1);
      expect(results[0]!.timestamp).toBe(5000);
      expect(results[0]!.model).toBe('sonnet');
    });
  });

  describe('summarize', () => {
    it('returns zero defaults for empty store', () => {
      const store = new CostStore(tmpDir);
      const summary = store.summarize();
      expect(summary.totalCost).toBe(0);
      expect(summary.totalInputTokens).toBe(0);
      expect(summary.totalOutputTokens).toBe(0);
      expect(summary.totalRuns).toBe(0);
      expect(summary.byModel).toEqual({});
    });

    it('aggregates totals across records', () => {
      const store = new CostStore(tmpDir);
      store.append(makeRecord({ inputTokens: 1000, outputTokens: 500, estimatedCost: 0.01 }));
      store.append(makeRecord({ inputTokens: 2000, outputTokens: 800, estimatedCost: 0.02 }));

      const summary = store.summarize();
      expect(summary.totalInputTokens).toBe(3000);
      expect(summary.totalOutputTokens).toBe(1300);
      expect(summary.totalCost).toBeCloseTo(0.03);
      expect(summary.totalRuns).toBe(2);
    });

    it('groups by model in byModel breakdown', () => {
      const store = new CostStore(tmpDir);
      store.append(makeRecord({ model: 'sonnet', inputTokens: 100, outputTokens: 50, estimatedCost: 0.01 }));
      store.append(makeRecord({ model: 'haiku', inputTokens: 200, outputTokens: 80, estimatedCost: 0.005 }));
      store.append(makeRecord({ model: 'sonnet', inputTokens: 300, outputTokens: 100, estimatedCost: 0.02 }));

      const summary = store.summarize();
      expect(summary.byModel['sonnet']).toEqual({
        runs: 2,
        inputTokens: 400,
        outputTokens: 150,
        cost: 0.03,
      });
      expect(summary.byModel['haiku']).toEqual({
        runs: 1,
        inputTokens: 200,
        outputTokens: 80,
        cost: 0.005,
      });
    });

    it('uses "unknown" for records with empty model', () => {
      const store = new CostStore(tmpDir);
      store.append(makeRecord({ model: '' }));

      const summary = store.summarize();
      expect(summary.byModel['unknown']).toBeDefined();
      expect(summary.byModel['unknown']!.runs).toBe(1);
    });

    it('respects filters when summarizing', () => {
      const store = new CostStore(tmpDir);
      store.append(makeRecord({ model: 'sonnet', estimatedCost: 0.01 }));
      store.append(makeRecord({ model: 'haiku', estimatedCost: 0.005 }));

      const summary = store.summarize({ model: 'haiku' });
      expect(summary.totalRuns).toBe(1);
      expect(summary.totalCost).toBeCloseTo(0.005);
    });
  });

  describe('enforceCap', () => {
    it('does not truncate when entries are under the cap', () => {
      const store = new CostStore(tmpDir);
      for (let i = 0; i < 100; i++) {
        store.append(makeRecord({ inputTokens: i }));
      }
      // 100 appends triggers enforceCap check, but 100 < 10000
      const results = store.query();
      expect(results).toHaveLength(100);
    });

    it('truncates to most recent entries when over cap', () => {
      const store = new CostStore(tmpDir);
      const filePath = path.join(tmpDir, 'costs.ndjson');

      // Pre-fill the file with 10,050 lines directly
      const lines: string[] = [];
      for (let i = 0; i < 10_050; i++) {
        lines.push(JSON.stringify(makeRecord({ timestamp: i, inputTokens: i })));
      }
      fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');

      // Now append 100 more to trigger the cap check (appendCount hits 100)
      for (let i = 0; i < 100; i++) {
        store.append(makeRecord({ timestamp: 99_000 + i, inputTokens: 99_000 + i }));
      }

      const results = store.query();
      expect(results).toHaveLength(10_000);
      // Should keep the most recent entries
      expect(results[results.length - 1]!.timestamp).toBe(99_099);
    });

    it('only runs every 100 appends', () => {
      const store = new CostStore(tmpDir);
      const filePath = path.join(tmpDir, 'costs.ndjson');

      // Pre-fill with entries over cap
      const lines: string[] = [];
      for (let i = 0; i < 10_050; i++) {
        lines.push(JSON.stringify(makeRecord({ timestamp: i })));
      }
      fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');

      // Append 99 -- should NOT trigger enforceCap
      for (let i = 0; i < 99; i++) {
        store.append(makeRecord({ timestamp: 50_000 + i }));
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const lineCount = content.trim().split('\n').length;
      // 10050 original + 99 new = 10149, no truncation yet
      expect(lineCount).toBe(10_149);
    });
  });
});
