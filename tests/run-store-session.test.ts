import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RunStore } from '../src/bot/run-store.js';
import { SessionStore } from '../src/bot/session-state.js';
import type { SessionState } from '../src/bot/session-state.js';
import type { RunRecord } from '../src/bot/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: RunStore.newId(),
    workflowFile: 'deploy.yaml',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 1200,
    success: true,
    outcome: 'completed',
    summary: 'All steps passed',
    dryRun: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// RunStore
// ---------------------------------------------------------------------------

describe('RunStore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- newId ---

  describe('newId', () => {
    it('returns a valid UUID string', () => {
      const id = RunStore.newId();
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('generates unique IDs on successive calls', () => {
      const ids = new Set(Array.from({ length: 100 }, () => RunStore.newId()));
      expect(ids.size).toBe(100);
    });
  });

  // --- append / list ---

  describe('append and list', () => {
    it('appends a record and retrieves it via list', () => {
      const store = new RunStore(tmpDir);
      const rec = makeRecord();
      store.append(rec);

      const records = store.list();
      expect(records).toHaveLength(1);
      expect(records[0]!.id).toBe(rec.id);
    });

    it('returns an empty array when no records exist', () => {
      const store = new RunStore(tmpDir);
      expect(store.list()).toEqual([]);
    });

    it('returns records sorted newest-first', () => {
      const store = new RunStore(tmpDir);
      const r1 = makeRecord({ startedAt: '2024-01-01T00:00:00Z' });
      const r2 = makeRecord({ startedAt: '2024-06-01T00:00:00Z' });
      const r3 = makeRecord({ startedAt: '2024-03-01T00:00:00Z' });
      store.append(r1);
      store.append(r2);
      store.append(r3);

      const listed = store.list();
      expect(listed.map((r) => r.id)).toEqual([r2.id, r3.id, r1.id]);
    });

    it('applies default limit of 50', () => {
      const store = new RunStore(tmpDir);
      for (let i = 0; i < 60; i++) {
        store.append(makeRecord({ startedAt: `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00Z` }));
      }
      expect(store.list()).toHaveLength(50);
    });
  });

  // --- filtering ---

  describe('list with filters', () => {
    let store: RunStore;
    let recA: RunRecord;
    let recB: RunRecord;
    let recC: RunRecord;

    beforeEach(() => {
      store = new RunStore(tmpDir);
      recA = makeRecord({
        workflowFile: 'build.yaml',
        outcome: 'completed',
        success: true,
        startedAt: '2024-03-10T10:00:00Z',
      });
      recB = makeRecord({
        workflowFile: 'deploy.yaml',
        outcome: 'failed',
        success: false,
        startedAt: '2024-03-15T10:00:00Z',
      });
      recC = makeRecord({
        workflowFile: 'build.yaml',
        outcome: 'error',
        success: false,
        startedAt: '2024-03-20T10:00:00Z',
      });
      store.append(recA);
      store.append(recB);
      store.append(recC);
    });

    it('filters by workflowFile', () => {
      const results = store.list({ workflowFile: 'build.yaml' });
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.workflowFile === 'build.yaml')).toBe(true);
    });

    it('filters by outcome', () => {
      const results = store.list({ outcome: 'failed' });
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe(recB.id);
    });

    it('filters by success=true', () => {
      const results = store.list({ success: true });
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe(recA.id);
    });

    it('filters by success=false', () => {
      const results = store.list({ success: false });
      expect(results).toHaveLength(2);
    });

    it('filters by since', () => {
      const results = store.list({ since: '2024-03-14T00:00:00Z' });
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.id)).toContain(recB.id);
      expect(results.map((r) => r.id)).toContain(recC.id);
    });

    it('filters by before', () => {
      const results = store.list({ before: '2024-03-12T00:00:00Z' });
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe(recA.id);
    });

    it('filters by since and before combined', () => {
      const results = store.list({
        since: '2024-03-12T00:00:00Z',
        before: '2024-03-18T00:00:00Z',
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe(recB.id);
    });

    it('respects custom limit', () => {
      const results = store.list({ limit: 1 });
      expect(results).toHaveLength(1);
      // Should be the newest record
      expect(results[0]!.id).toBe(recC.id);
    });

    it('combines multiple filters', () => {
      const results = store.list({
        workflowFile: 'build.yaml',
        success: false,
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe(recC.id);
    });
  });

  // --- get ---

  describe('get', () => {
    it('retrieves a record by full ID', () => {
      const store = new RunStore(tmpDir);
      const rec = makeRecord();
      store.append(rec);

      const found = store.get(rec.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(rec.id);
    });

    it('retrieves a record by prefix (>=4 chars)', () => {
      const store = new RunStore(tmpDir);
      const rec = makeRecord();
      store.append(rec);

      const prefix = rec.id.slice(0, 8);
      const found = store.get(prefix);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(rec.id);
    });

    it('returns null when no match is found', () => {
      const store = new RunStore(tmpDir);
      store.append(makeRecord());
      expect(store.get('zzzz')).toBeNull();
    });

    it('throws for prefix shorter than 4 characters', () => {
      const store = new RunStore(tmpDir);
      store.append(makeRecord());
      expect(() => store.get('abc')).toThrow('ID prefix must be at least 4 characters');
    });

    it('throws for ambiguous prefix matching multiple records', () => {
      const store = new RunStore(tmpDir);
      const sharedPrefix = 'abcd';
      const r1 = makeRecord({ id: `${sharedPrefix}1111-0000-0000-000000000000` });
      const r2 = makeRecord({ id: `${sharedPrefix}2222-0000-0000-000000000000` });
      store.append(r1);
      store.append(r2);

      expect(() => store.get(sharedPrefix)).toThrow(/Ambiguous ID prefix/);
    });
  });

  // --- prune ---

  describe('prune', () => {
    it('prunes by maxRecords keeping the newest', () => {
      const store = new RunStore(tmpDir);
      const r1 = makeRecord({ startedAt: '2024-01-01T00:00:00Z' });
      const r2 = makeRecord({ startedAt: '2024-06-01T00:00:00Z' });
      const r3 = makeRecord({ startedAt: '2024-03-01T00:00:00Z' });
      store.append(r1);
      store.append(r2);
      store.append(r3);

      const pruned = store.prune({ maxRecords: 2 });
      expect(pruned).toBe(1);

      const remaining = store.list();
      expect(remaining).toHaveLength(2);
      // Should keep the two newest
      expect(remaining.map((r) => r.id)).toContain(r2.id);
      expect(remaining.map((r) => r.id)).toContain(r3.id);
      expect(remaining.map((r) => r.id)).not.toContain(r1.id);
    });

    it('prunes by maxAgeDays', () => {
      const store = new RunStore(tmpDir);
      const old = makeRecord({
        startedAt: new Date(Date.now() - 100 * 86_400_000).toISOString(),
      });
      const recent = makeRecord({
        startedAt: new Date(Date.now() - 1 * 86_400_000).toISOString(),
      });
      store.append(old);
      store.append(recent);

      const pruned = store.prune({ maxAgeDays: 30 });
      expect(pruned).toBe(1);

      const remaining = store.list();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.id).toBe(recent.id);
    });

    it('applies maxAgeDays then maxRecords', () => {
      const store = new RunStore(tmpDir);
      for (let i = 0; i < 5; i++) {
        store.append(
          makeRecord({
            startedAt: new Date(Date.now() - i * 86_400_000).toISOString(),
          }),
        );
      }

      const pruned = store.prune({ maxAgeDays: 10, maxRecords: 2 });
      expect(pruned).toBe(3);
      expect(store.list()).toHaveLength(2);
    });

    it('returns 0 when nothing to prune', () => {
      const store = new RunStore(tmpDir);
      store.append(makeRecord());
      expect(store.prune({ maxRecords: 100 })).toBe(0);
    });

    it('returns 0 for empty store', () => {
      const store = new RunStore(tmpDir);
      expect(store.prune({ maxRecords: 10 })).toBe(0);
    });
  });

  // --- clear ---

  describe('clear', () => {
    it('removes history and returns true', () => {
      const store = new RunStore(tmpDir);
      store.append(makeRecord());
      expect(store.clear()).toBe(true);
      expect(store.list()).toEqual([]);
    });

    it('returns false when no history file exists', () => {
      const store = new RunStore(tmpDir);
      expect(store.clear()).toBe(false);
    });

    it('store can accept new records after clearing', () => {
      const store = new RunStore(tmpDir);
      store.append(makeRecord());
      store.clear();
      const rec = makeRecord();
      store.append(rec);
      expect(store.list()).toHaveLength(1);
      expect(store.list()[0]!.id).toBe(rec.id);
    });
  });

  // --- corrupt NDJSON ---

  describe('corrupt NDJSON handling', () => {
    it('skips corrupt lines and returns valid records', () => {
      const store = new RunStore(tmpDir);
      const good = makeRecord();
      store.append(good);

      // Inject a corrupt line directly into the file
      const filePath = path.join(tmpDir, 'history.ndjson');
      fs.appendFileSync(filePath, 'THIS IS NOT JSON\n', 'utf-8');

      const good2 = makeRecord();
      store.append(good2);

      const records = store.list();
      expect(records).toHaveLength(2);
      expect(records.map((r) => r.id)).toContain(good.id);
      expect(records.map((r) => r.id)).toContain(good2.id);
    });

    it('handles file with only corrupt lines', () => {
      const filePath = path.join(tmpDir, 'history.ndjson');
      fs.writeFileSync(filePath, 'bad line\nanother bad\n', 'utf-8');

      const store = new RunStore(tmpDir);
      expect(store.list()).toEqual([]);
    });
  });

  // --- markRunning / clearRunning / checkOrphans ---

  describe('markRunning / clearRunning / checkOrphans', () => {
    it('markRunning creates a marker file', () => {
      const store = new RunStore(tmpDir);
      const runId = RunStore.newId();
      store.markRunning(runId, 'deploy.yaml');

      const markerPath = path.join(tmpDir, `running-${runId}.json`);
      expect(fs.existsSync(markerPath)).toBe(true);

      const data = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
      expect(data.id).toBe(runId);
      expect(data.workflowFile).toBe('deploy.yaml');
      expect(data.pid).toBe(process.pid);
    });

    it('clearRunning removes the marker file', () => {
      const store = new RunStore(tmpDir);
      const runId = RunStore.newId();
      store.markRunning(runId, 'deploy.yaml');
      store.clearRunning(runId);

      const markerPath = path.join(tmpDir, `running-${runId}.json`);
      expect(fs.existsSync(markerPath)).toBe(false);
    });

    it('clearRunning does not throw if marker is already gone', () => {
      const store = new RunStore(tmpDir);
      expect(() => store.clearRunning('nonexistent-id')).not.toThrow();
    });

    it('checkOrphans detects orphaned markers with dead PIDs', () => {
      const store = new RunStore(tmpDir);
      const runId = 'orphan-test-id';
      const markerPath = path.join(tmpDir, `running-${runId}.json`);

      // Write a marker with a PID that does not exist
      fs.writeFileSync(
        markerPath,
        JSON.stringify({
          id: runId,
          workflowFile: 'orphan.yaml',
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          pid: 999999,
        }),
        'utf-8',
      );

      const orphans = store.checkOrphans();
      expect(orphans).toHaveLength(1);
      expect(orphans[0]!.id).toBe(runId);
      expect(orphans[0]!.workflowFile).toBe('orphan.yaml');

      // The marker file should be cleaned up
      expect(fs.existsSync(markerPath)).toBe(false);

      // An error record should be appended to history
      const records = store.list();
      expect(records).toHaveLength(1);
      expect(records[0]!.id).toBe(runId);
      expect(records[0]!.success).toBe(false);
      expect(records[0]!.outcome).toBe('error');
    });

    it('checkOrphans ignores markers with alive PIDs', () => {
      const store = new RunStore(tmpDir);
      const runId = RunStore.newId();
      // Mark with current (alive) PID
      store.markRunning(runId, 'alive.yaml');

      const orphans = store.checkOrphans();
      expect(orphans).toHaveLength(0);

      // Marker should still exist
      expect(fs.existsSync(path.join(tmpDir, `running-${runId}.json`))).toBe(true);

      // Clean up
      store.clearRunning(runId);
    });

    it('checkOrphans returns empty array when no markers exist', () => {
      const store = new RunStore(tmpDir);
      expect(store.checkOrphans()).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

describe('SessionStore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- create ---

  describe('create', () => {
    it('returns a valid SessionState', async () => {
      const store = new SessionStore(tmpDir);
      const state = await store.create();

      expect(state.sessionId).toBeTruthy();
      expect(state.sessionId.length).toBe(8);
      expect(state.status).toBe('idle');
      expect(state.currentTask).toBeNull();
      expect(state.completedTasks).toBe(0);
      expect(state.totalCost).toBe(0);
      expect(state.startedAt).toBeGreaterThan(0);
      expect(state.lastActivity).toBeGreaterThan(0);
    });

    it('persists the session to disk', async () => {
      const store = new SessionStore(tmpDir);
      const state = await store.create();
      const loaded = store.load();

      expect(loaded).not.toBeNull();
      expect(loaded!.sessionId).toBe(state.sessionId);
    });
  });

  // --- load ---

  describe('load', () => {
    it('returns null when no session file exists', () => {
      const store = new SessionStore(tmpDir);
      expect(store.load()).toBeNull();
    });

    it('returns null for corrupt session file', () => {
      const filePath = path.join(tmpDir, 'session.json');
      fs.writeFileSync(filePath, 'NOT VALID JSON', 'utf-8');

      const store = new SessionStore(tmpDir);
      expect(store.load()).toBeNull();
    });
  });

  // --- save / load round-trip ---

  describe('save and load round-trip', () => {
    it('preserves all session fields', async () => {
      const store = new SessionStore(tmpDir);
      const original: SessionState = {
        sessionId: 'test1234',
        status: 'executing',
        currentTask: 'Run deploy pipeline',
        completedTasks: 3,
        totalCost: 0.42,
        startedAt: 1700000000000,
        lastActivity: 1700001000000,
      };
      await store.save(original);

      const loaded = store.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.sessionId).toBe('test1234');
      expect(loaded!.status).toBe('executing');
      expect(loaded!.currentTask).toBe('Run deploy pipeline');
      expect(loaded!.completedTasks).toBe(3);
      expect(loaded!.totalCost).toBe(0.42);
      expect(loaded!.startedAt).toBe(1700000000000);
      // lastActivity is updated on save, so it will be >= original
      expect(loaded!.lastActivity).toBeGreaterThanOrEqual(original.lastActivity);
    });

    it('save updates lastActivity timestamp', async () => {
      const store = new SessionStore(tmpDir);
      const state: SessionState = {
        sessionId: 'ts-test',
        status: 'idle',
        currentTask: null,
        completedTasks: 0,
        totalCost: 0,
        startedAt: Date.now() - 10_000,
        lastActivity: Date.now() - 10_000,
      };

      const before = Date.now();
      await store.save(state);
      const loaded = store.load();

      expect(loaded!.lastActivity).toBeGreaterThanOrEqual(before);
    });
  });

  // --- update ---

  describe('update', () => {
    it('patches specific fields and preserves the rest', async () => {
      const store = new SessionStore(tmpDir);
      await store.create();

      const updated = await store.update({
        status: 'executing',
        currentTask: 'Step 1: Build',
        completedTasks: 1,
      });

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('executing');
      expect(updated!.currentTask).toBe('Step 1: Build');
      expect(updated!.completedTasks).toBe(1);
      // Original fields preserved
      expect(updated!.totalCost).toBe(0);
    });

    it('returns null when no session exists', async () => {
      const store = new SessionStore(tmpDir);
      const result = await store.update({ status: 'paused' });
      expect(result).toBeNull();
    });

    it('updates lastActivity on each update call', async () => {
      const store = new SessionStore(tmpDir);
      await store.create();

      const before = Date.now();
      await store.update({ completedTasks: 5 });

      const loaded = store.load();
      expect(loaded!.lastActivity).toBeGreaterThanOrEqual(before);
      expect(loaded!.completedTasks).toBe(5);
    });

    it('persists patched state to disk', async () => {
      const store = new SessionStore(tmpDir);
      await store.create();
      await store.update({ totalCost: 1.23 });

      const loaded = store.load();
      expect(loaded!.totalCost).toBe(1.23);
    });
  });

  // --- clear ---

  describe('clear', () => {
    it('removes the session file', async () => {
      const store = new SessionStore(tmpDir);
      await store.create();
      store.clear();
      expect(store.load()).toBeNull();
    });

    it('does not throw when no session exists', () => {
      const store = new SessionStore(tmpDir);
      expect(() => store.clear()).not.toThrow();
    });

    it('allows creating a new session after clearing', async () => {
      const store = new SessionStore(tmpDir);
      const first = await store.create();
      store.clear();
      const second = await store.create();

      expect(second.sessionId).not.toBe(first.sessionId);
      expect(store.load()).not.toBeNull();
    });
  });

  // --- concurrent access (basic) ---

  describe('concurrent access', () => {
    it('handles concurrent updates without data loss', async () => {
      const store = new SessionStore(tmpDir);
      await store.create();

      // Run several updates concurrently
      await Promise.all([
        store.update({ completedTasks: 1 }),
        store.update({ completedTasks: 2 }),
        store.update({ completedTasks: 3 }),
      ]);

      const final = store.load();
      expect(final).not.toBeNull();
      // One of the values should have won
      expect([1, 2, 3]).toContain(final!.completedTasks);
    });

    it('handles concurrent save operations', async () => {
      const store = new SessionStore(tmpDir);
      const state = await store.create();

      const saves = Array.from({ length: 5 }, (_, i) =>
        store.save({ ...state, completedTasks: i }),
      );
      await Promise.all(saves);

      const loaded = store.load();
      expect(loaded).not.toBeNull();
      // File should be valid JSON (not corrupted)
      expect(loaded!.sessionId).toBe(state.sessionId);
      expect(loaded!.completedTasks).toBeGreaterThanOrEqual(0);
      expect(loaded!.completedTasks).toBeLessThan(5);
    });
  });
});
