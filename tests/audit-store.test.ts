import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AuditStore } from '../src/bot/audit-store.js';
import type { AuditEvent } from '../src/bot/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides?: Partial<AuditEvent>): AuditEvent {
  return {
    type: 'step-complete',
    timestamp: new Date().toISOString(),
    runId: 'run-1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AuditStore — basic operations
// ---------------------------------------------------------------------------

describe('AuditStore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Constructor ---

  it('creates the directory if it does not exist', () => {
    const nestedDir = path.join(tmpDir, 'nested', 'dir');
    const _store = new AuditStore(nestedDir);
    expect(fs.existsSync(nestedDir)).toBe(true);
  });

  // --- emit + readAll (via queryRecent) ---

  it('queryRecent returns empty array on empty store', () => {
    const store = new AuditStore(tmpDir);
    expect(store.queryRecent()).toEqual([]);
  });

  it('emits and reads back a single event', () => {
    const store = new AuditStore(tmpDir);
    const event = makeEvent();
    store.emit(event);

    const results = store.queryRecent();
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(event);
  });

  it('emits and reads back multiple events in order', () => {
    const store = new AuditStore(tmpDir);
    const e1 = makeEvent({ type: 'run-start', runId: 'run-1' });
    const e2 = makeEvent({ type: 'step-start', runId: 'run-1' });
    const e3 = makeEvent({ type: 'step-complete', runId: 'run-1' });

    store.emit(e1);
    store.emit(e2);
    store.emit(e3);

    const results = store.queryRecent(10);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual(e1);
    expect(results[1]).toEqual(e2);
    expect(results[2]).toEqual(e3);
  });

  it('persists events across store instances', () => {
    const store1 = new AuditStore(tmpDir);
    store1.emit(makeEvent({ runId: 'run-a' }));
    store1.emit(makeEvent({ runId: 'run-b' }));

    const store2 = new AuditStore(tmpDir);
    expect(store2.queryRecent()).toHaveLength(2);
  });

  // --- queryByRun ---

  it('queryByRun filters events by runId', () => {
    const store = new AuditStore(tmpDir);
    store.emit(makeEvent({ runId: 'run-a', type: 'run-start' }));
    store.emit(makeEvent({ runId: 'run-b', type: 'step-start' }));
    store.emit(makeEvent({ runId: 'run-a', type: 'run-complete' }));

    const results = store.queryByRun('run-a');
    expect(results).toHaveLength(2);
    expect(results.every((e) => e.runId === 'run-a')).toBe(true);
  });

  it('queryByRun returns empty for unknown runId', () => {
    const store = new AuditStore(tmpDir);
    store.emit(makeEvent({ runId: 'run-a' }));
    expect(store.queryByRun('nonexistent')).toEqual([]);
  });

  // --- queryRecent limit ---

  it('queryRecent respects the limit parameter', () => {
    const store = new AuditStore(tmpDir);
    for (let i = 0; i < 10; i++) {
      store.emit(makeEvent({ runId: `run-${i}` }));
    }

    const results = store.queryRecent(3);
    expect(results).toHaveLength(3);
    // Should return the LAST 3 events
    expect(results[0]!.runId).toBe('run-7');
    expect(results[1]!.runId).toBe('run-8');
    expect(results[2]!.runId).toBe('run-9');
  });

  it('queryRecent defaults to 50', () => {
    const store = new AuditStore(tmpDir);
    for (let i = 0; i < 60; i++) {
      store.emit(makeEvent({ runId: `run-${i}` }));
    }

    const results = store.queryRecent();
    expect(results).toHaveLength(50);
  });

  // --- prune ---

  it('prune removes events older than maxAgeDays', () => {
    const store = new AuditStore(tmpDir);
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const recent = new Date().toISOString();

    store.emit(makeEvent({ timestamp: old, type: 'run-start' }));
    store.emit(makeEvent({ timestamp: recent, type: 'run-complete' }));

    const pruned = store.prune(5);
    expect(pruned).toBe(1);

    const remaining = store.queryRecent();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.type).toBe('run-complete');
  });

  it('prune returns 0 when nothing to prune', () => {
    const store = new AuditStore(tmpDir);
    const recent = new Date().toISOString();
    store.emit(makeEvent({ timestamp: recent }));

    expect(store.prune(30)).toBe(0);
  });

  it('prune returns 0 on empty store', () => {
    const store = new AuditStore(tmpDir);
    expect(store.prune(30)).toBe(0);
  });

  it('prune removes all events when all are old', () => {
    const store = new AuditStore(tmpDir);
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
    store.emit(makeEvent({ timestamp: old, type: 'run-start' }));
    store.emit(makeEvent({ timestamp: old, type: 'run-complete' }));

    const pruned = store.prune(5);
    expect(pruned).toBe(2);

    // After pruning everything, queryRecent should return empty
    expect(store.queryRecent()).toEqual([]);

    // The file should be cleanly empty or removed — no orphan content
    const filePath = path.join(tmpDir, 'audit.ndjson');
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content.trim()).toBe('');
    }
  });

  it('prune does not leave .tmp files behind', () => {
    const store = new AuditStore(tmpDir);
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const recent = new Date().toISOString();
    store.emit(makeEvent({ timestamp: old }));
    store.emit(makeEvent({ timestamp: recent }));

    store.prune(5);

    const tmpFile = path.join(tmpDir, 'audit.ndjson.tmp');
    expect(fs.existsSync(tmpFile)).toBe(false);
  });

  // --- clear ---

  it('clear removes the audit file', () => {
    const store = new AuditStore(tmpDir);
    store.emit(makeEvent());
    expect(store.clear()).toBe(true);
    expect(store.queryRecent()).toEqual([]);
  });

  it('clear returns false when no file exists', () => {
    const store = new AuditStore(tmpDir);
    expect(store.clear()).toBe(false);
  });

  // --- Resilience: corrupt NDJSON ---

  it('skips corrupt lines and returns valid events', () => {
    const store = new AuditStore(tmpDir);
    const good = makeEvent({ type: 'run-start' });

    // Write a valid line, a corrupt line, and another valid line
    const filePath = path.join(tmpDir, 'audit.ndjson');
    fs.writeFileSync(filePath, [
      JSON.stringify(good),
      'NOT VALID JSON {{{{',
      JSON.stringify(makeEvent({ type: 'run-complete' })),
    ].join('\n') + '\n', 'utf-8');

    const results = store.queryRecent();
    expect(results).toHaveLength(2);
    expect(results[0]!.type).toBe('run-start');
    expect(results[1]!.type).toBe('run-complete');
  });

  // --- Resilience: data field preserved ---

  it('preserves the optional data field', () => {
    const store = new AuditStore(tmpDir);
    const event = makeEvent({ data: { tool: 'read_file', path: '/foo' } });
    store.emit(event);

    const results = store.queryRecent();
    expect(results[0]!.data).toEqual({ tool: 'read_file', path: '/foo' });
  });
});
