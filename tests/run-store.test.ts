import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RunStore } from '../src/bot/run-store.js';
import type { RunRecord } from '../src/bot/types.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'run-store-test-'));
}

function makeRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: RunStore.newId(),
    workflowFile: 'test.flow.ts',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 100,
    success: true,
    outcome: 'completed',
    summary: 'test run',
    dryRun: false,
    ...overrides,
  };
}

describe('RunStore', () => {
  let tmpDir: string;
  let store: RunStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new RunStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- append / readAll ---

  it('appends and lists records', () => {
    const r1 = makeRecord({ id: 'aaaa-1111' });
    const r2 = makeRecord({ id: 'bbbb-2222' });
    store.append(r1);
    store.append(r2);

    const results = store.list();
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.id)).toContain('aaaa-1111');
    expect(results.map((r) => r.id)).toContain('bbbb-2222');
  });

  it('returns empty list when no history file exists', () => {
    expect(store.list()).toEqual([]);
  });

  // --- list filtering ---

  it('filters by workflowFile', () => {
    store.append(makeRecord({ workflowFile: 'a.flow.ts' }));
    store.append(makeRecord({ workflowFile: 'b.flow.ts' }));

    const results = store.list({ workflowFile: 'a.flow.ts' });
    expect(results).toHaveLength(1);
    expect(results[0]!.workflowFile).toBe('a.flow.ts');
  });

  it('filters by outcome', () => {
    store.append(makeRecord({ outcome: 'completed' }));
    store.append(makeRecord({ outcome: 'error' }));

    const results = store.list({ outcome: 'error' });
    expect(results).toHaveLength(1);
    expect(results[0]!.outcome).toBe('error');
  });

  it('filters by success', () => {
    store.append(makeRecord({ success: true }));
    store.append(makeRecord({ success: false }));

    const results = store.list({ success: false });
    expect(results).toHaveLength(1);
    expect(results[0]!.success).toBe(false);
  });

  it('filters by since/before date range', () => {
    store.append(makeRecord({ startedAt: '2025-01-01T00:00:00Z' }));
    store.append(makeRecord({ startedAt: '2025-06-15T00:00:00Z' }));
    store.append(makeRecord({ startedAt: '2025-12-31T00:00:00Z' }));

    const results = store.list({
      since: '2025-03-01T00:00:00Z',
      before: '2025-09-01T00:00:00Z',
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.startedAt).toBe('2025-06-15T00:00:00Z');
  });

  it('applies default limit of 50', () => {
    for (let i = 0; i < 60; i++) {
      store.append(makeRecord());
    }
    const results = store.list();
    expect(results).toHaveLength(50);
  });

  it('applies custom limit', () => {
    for (let i = 0; i < 10; i++) {
      store.append(makeRecord());
    }
    const results = store.list({ limit: 3 });
    expect(results).toHaveLength(3);
  });

  it('sorts results newest-first', () => {
    store.append(makeRecord({ startedAt: '2025-01-01T00:00:00Z' }));
    store.append(makeRecord({ startedAt: '2025-12-31T00:00:00Z' }));
    store.append(makeRecord({ startedAt: '2025-06-15T00:00:00Z' }));

    const results = store.list();
    expect(results[0]!.startedAt).toBe('2025-12-31T00:00:00Z');
    expect(results[1]!.startedAt).toBe('2025-06-15T00:00:00Z');
    expect(results[2]!.startedAt).toBe('2025-01-01T00:00:00Z');
  });

  // --- get (prefix lookup) ---

  it('throws when prefix is less than 4 characters', () => {
    expect(() => store.get('abc')).toThrow('at least 4 characters');
  });

  it('returns null when no record matches', () => {
    store.append(makeRecord({ id: 'aaaa-1111-2222-3333' }));
    expect(store.get('bbbb')).toBeNull();
  });

  it('returns exact match', () => {
    const id = 'aaaa-1111-2222-3333';
    store.append(makeRecord({ id }));
    expect(store.get(id)!.id).toBe(id);
  });

  it('returns single prefix match', () => {
    store.append(makeRecord({ id: 'aaaa-1111-2222-3333' }));
    expect(store.get('aaaa')!.id).toBe('aaaa-1111-2222-3333');
  });

  it('throws on ambiguous prefix match', () => {
    store.append(makeRecord({ id: 'aaaa-1111' }));
    store.append(makeRecord({ id: 'aaaa-2222' }));
    expect(() => store.get('aaaa')).toThrow('Ambiguous');
  });

  // --- markRunning / clearRunning ---

  it('creates and removes marker files', () => {
    store.markRunning('test-run-1', 'test.flow.ts');
    const marker = path.join(tmpDir, 'running-test-run-1.json');
    expect(fs.existsSync(marker)).toBe(true);

    const data = JSON.parse(fs.readFileSync(marker, 'utf-8'));
    expect(data.id).toBe('test-run-1');
    expect(data.workflowFile).toBe('test.flow.ts');
    expect(data.pid).toBe(process.pid);

    store.clearRunning('test-run-1');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('clearRunning does not throw if marker already gone', () => {
    expect(() => store.clearRunning('nonexistent')).not.toThrow();
  });

  // --- checkOrphans ---

  it('detects orphaned runs whose process is dead', () => {
    // Write a marker with a PID that definitely doesn't exist
    const marker = path.join(tmpDir, 'running-orphan-1.json');
    fs.writeFileSync(marker, JSON.stringify({
      id: 'orphan-1',
      workflowFile: 'test.flow.ts',
      startedAt: '2025-01-01T00:00:00Z',
      pid: 999999999, // very unlikely to be alive
    }), 'utf-8');

    const orphans = store.checkOrphans();
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.id).toBe('orphan-1');

    // Marker should be cleaned up
    expect(fs.existsSync(marker)).toBe(false);

    // Should have appended an error record
    const records = store.list();
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe('orphan-1');
    expect(records[0]!.success).toBe(false);
    expect(records[0]!.outcome).toBe('error');
  });

  it('does not flag marker for a living process', () => {
    const marker = path.join(tmpDir, 'running-alive-1.json');
    fs.writeFileSync(marker, JSON.stringify({
      id: 'alive-1',
      workflowFile: 'test.flow.ts',
      startedAt: '2025-01-01T00:00:00Z',
      pid: process.pid, // current process is alive
    }), 'utf-8');

    const orphans = store.checkOrphans();
    expect(orphans).toHaveLength(0);
    // Marker should still exist
    expect(fs.existsSync(marker)).toBe(true);
    fs.unlinkSync(marker); // cleanup
  });

  it('logs a warning when a marker file is corrupt', () => {
    const marker = path.join(tmpDir, 'running-corrupt-1.json');
    fs.writeFileSync(marker, '{invalid json!!!', 'utf-8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const orphans = store.checkOrphans();
    expect(orphans).toHaveLength(0);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('corrupt marker'),
      expect.anything(),
    );
    warnSpy.mockRestore();
  });

  it('deletes corrupt marker files so they do not persist across restarts', () => {
    const marker = path.join(tmpDir, 'running-corrupt-2.json');
    fs.writeFileSync(marker, '{not valid json', 'utf-8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    store.checkOrphans();

    // Corrupt marker file should be removed after detection
    expect(fs.existsSync(marker)).toBe(false);

    // Second call should NOT warn again (file is gone)
    warnSpy.mockClear();
    store.checkOrphans();
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('logs a warning when directory read fails in checkOrphans', () => {
    // Create a store pointing to a non-existent dir, then remove it
    // Point store at tmpDir (constructor creates it), then remove it so readdirSync fails
    const badDir = path.join(tmpDir, 'will-vanish');
    const badStore = new RunStore(badDir);
    fs.rmSync(badDir, { recursive: true, force: true });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const orphans = badStore.checkOrphans();
    expect(orphans).toHaveLength(0);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('checkOrphans'),
      expect.anything(),
    );
    warnSpy.mockRestore();
  });

  // --- prune ---

  it('prunes by maxAgeDays', () => {
    store.append(makeRecord({ startedAt: '2020-01-01T00:00:00Z' }));
    store.append(makeRecord({ startedAt: new Date().toISOString() }));

    const pruned = store.prune({ maxAgeDays: 1 });
    expect(pruned).toBe(1);
    expect(store.list()).toHaveLength(1);
  });

  it('prunes by maxRecords', () => {
    for (let i = 0; i < 5; i++) {
      store.append(makeRecord({ startedAt: `2025-0${i + 1}-01T00:00:00Z` }));
    }

    const pruned = store.prune({ maxRecords: 2 });
    expect(pruned).toBe(3);
    expect(store.list()).toHaveLength(2);
  });

  it('applies maxAgeDays and maxRecords together', () => {
    // 3 recent records, 2 old records
    store.append(makeRecord({ startedAt: '2020-01-01T00:00:00Z' }));
    store.append(makeRecord({ startedAt: '2020-02-01T00:00:00Z' }));
    store.append(makeRecord({ startedAt: new Date().toISOString() }));
    store.append(makeRecord({ startedAt: new Date().toISOString() }));
    store.append(makeRecord({ startedAt: new Date().toISOString() }));

    // maxAgeDays removes 2 old ones, maxRecords further caps to 2
    const pruned = store.prune({ maxAgeDays: 1, maxRecords: 2 });
    expect(pruned).toBe(3);
    expect(store.list()).toHaveLength(2);
  });

  it('returns 0 when nothing to prune', () => {
    store.append(makeRecord({ startedAt: new Date().toISOString() }));
    expect(store.prune({ maxRecords: 10 })).toBe(0);
  });

  it('returns 0 when history is empty', () => {
    expect(store.prune({ maxRecords: 10 })).toBe(0);
  });

  // --- clear ---

  it('clears history file and returns true', () => {
    store.append(makeRecord());
    expect(store.clear()).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it('returns false when no history file exists', () => {
    expect(store.clear()).toBe(false);
  });

  // --- newId ---

  it('generates unique UUIDs', () => {
    const id1 = RunStore.newId();
    const id2 = RunStore.newId();
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^[0-9a-f-]{36}$/);
  });
});
