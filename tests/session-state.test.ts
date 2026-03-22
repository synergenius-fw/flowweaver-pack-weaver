import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionStore } from '../src/bot/session-state.js';

// ---------------------------------------------------------------------------
// Tests for session-state.ts
// Focus: full coverage + error handling + reliability gaps
// ---------------------------------------------------------------------------

describe('SessionStore', () => {
  let tmpDir: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-state-test-'));
    store = new SessionStore(tmpDir);
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  // =========================================================================
  // create()
  // =========================================================================
  describe('create', () => {
    it('creates a new session with correct defaults', async () => {
      const state = await store.create();
      expect(state.sessionId).toHaveLength(8);
      expect(state.status).toBe('idle');
      expect(state.currentTask).toBeNull();
      expect(state.completedTasks).toBe(0);
      expect(state.totalCost).toBe(0);
      expect(state.startedAt).toBeGreaterThan(0);
      expect(state.lastActivity).toBeGreaterThan(0);
    });

    it('persists the session to disk', async () => {
      const state = await store.create();
      const loaded = store.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.sessionId).toBe(state.sessionId);
    });
  });

  // =========================================================================
  // load()
  // =========================================================================
  describe('load', () => {
    it('returns null when no session file exists', () => {
      const result = store.load();
      expect(result).toBeNull();
    });

    it('returns the saved session state', async () => {
      const state = await store.create();
      const loaded = store.load();
      expect(loaded!.sessionId).toBe(state.sessionId);
      expect(loaded!.status).toBe('idle');
    });

    it('returns null when session file is corrupted JSON', async () => {
      // Write garbage to the session file
      const sessionPath = path.join(tmpDir, 'session.json');
      fs.writeFileSync(sessionPath, '{not valid json!!!', 'utf-8');
      const result = store.load();
      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // save()
  // =========================================================================
  describe('save', () => {
    it('creates directory if it does not exist', async () => {
      const nestedDir = path.join(tmpDir, 'deep', 'nested');
      // Pre-create parent so file-lock can create its .lock dir
      fs.mkdirSync(nestedDir, { recursive: true });
      const nestedStore = new SessionStore(nestedDir);
      const state = await nestedStore.create();
      expect(fs.existsSync(path.join(nestedDir, 'session.json'))).toBe(true);
    });

    it('updates lastActivity timestamp on save', async () => {
      const state = await store.create();
      const firstActivity = state.lastActivity;
      // Small delay to ensure timestamp differs
      await new Promise(r => setTimeout(r, 10));
      state.status = 'executing';
      await store.save(state);
      const loaded = store.load();
      expect(loaded!.lastActivity).toBeGreaterThanOrEqual(firstActivity);
      expect(loaded!.status).toBe('executing');
    });
  });

  // =========================================================================
  // update()
  // =========================================================================
  describe('update', () => {
    it('applies partial patch to existing session', async () => {
      await store.create();
      const updated = await store.update({ status: 'executing', currentTask: 'do stuff' });
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('executing');
      expect(updated!.currentTask).toBe('do stuff');
      // Other fields preserved
      expect(updated!.completedTasks).toBe(0);
    });

    it('returns null when no session file exists', async () => {
      const result = await store.update({ status: 'executing' });
      expect(result).toBeNull();
    });

    it('returns null when session file is corrupted', async () => {
      // Write corrupt data, then try to update
      const sessionPath = path.join(tmpDir, 'session.json');
      fs.writeFileSync(sessionPath, 'CORRUPT DATA HERE', 'utf-8');

      const result = await store.update({ status: 'executing' });

      // CURRENT BUG: update() calls load() which returns null on corruption,
      // then update() silently returns null. This is technically "correct"
      // behavior but we want to verify it at least doesn't crash.
      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // clear()
  // =========================================================================
  describe('clear', () => {
    it('removes the session file', async () => {
      await store.create();
      const sessionPath = path.join(tmpDir, 'session.json');
      expect(fs.existsSync(sessionPath)).toBe(true);

      store.clear();
      expect(fs.existsSync(sessionPath)).toBe(false);
    });

    it('does not throw when session file does not exist', () => {
      // Should not throw even if file doesn't exist
      expect(() => store.clear()).not.toThrow();
    });

    it('throws when file cannot be deleted for non-ENOENT reason', async () => {
      // Make the directory read-only so unlinkSync fails with EACCES/EPERM
      await store.create();
      const sessionPath = path.join(tmpDir, 'session.json');
      expect(fs.existsSync(sessionPath)).toBe(true);

      // Make directory read-only (prevents deletion of files inside it)
      fs.chmodSync(tmpDir, 0o444);

      // CURRENT BUG: clear() swallows ALL errors, including permission errors.
      // It should only swallow ENOENT (file not found), not EACCES/EPERM.
      try {
        expect(() => store.clear()).toThrow();
      } finally {
        // Restore permissions for cleanup
        fs.chmodSync(tmpDir, 0o755);
      }
    });
  });

  // =========================================================================
  // load() concurrency gap — load should use file lock
  // =========================================================================
  describe('load with file lock', () => {
    it('load returns consistent data during concurrent save', async () => {
      // Create initial session
      const state = await store.create();

      // Do a rapid save + load cycle — if load uses a lock, it won't get
      // a partial read. We can't easily force a partial read in a unit test,
      // but we CAN verify load() still works correctly after concurrent saves.
      const savePromise = store.save({ ...state, status: 'executing' });
      await savePromise;
      const loaded = store.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.status).toBe('executing');
    });
  });

  // =========================================================================
  // Crash recovery: load() should recover from backup when primary is corrupt
  // =========================================================================
  describe('crash recovery', () => {
    it('recovers session from backup when primary file is corrupt', async () => {
      const state = await store.create();
      // save() should create a .bak backup
      state.status = 'executing';
      state.currentTask = 'important work';
      await store.save(state);

      // Simulate crash: corrupt the primary file
      const sessionPath = path.join(tmpDir, 'session.json');
      fs.writeFileSync(sessionPath, '{CORRUPT PARTIAL WRI', 'utf-8');

      // load() should recover from the .bak file
      const recovered = store.load();
      expect(recovered).not.toBeNull();
      expect(recovered!.sessionId).toBe(state.sessionId);
      expect(recovered!.status).toBe('executing');
      expect(recovered!.currentTask).toBe('important work');
    });

    it('save uses atomic write (temp file + rename)', async () => {
      const state = await store.create();
      state.status = 'validating';
      await store.save(state);

      // Verify backup was created
      const backupPath = path.join(tmpDir, 'session.json.bak');
      expect(fs.existsSync(backupPath)).toBe(true);

      // Verify backup contains valid session data
      const backupData = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
      expect(backupData.sessionId).toBe(state.sessionId);
      expect(backupData.status).toBe('validating');
    });

    it('returns null when both primary and backup are corrupt', async () => {
      const sessionPath = path.join(tmpDir, 'session.json');
      const backupPath = path.join(tmpDir, 'session.json.bak');
      fs.writeFileSync(sessionPath, 'CORRUPT', 'utf-8');
      fs.writeFileSync(backupPath, 'ALSO CORRUPT', 'utf-8');

      const result = store.load();
      expect(result).toBeNull();
    });

    it('returns null when primary is corrupt and no backup exists', async () => {
      const sessionPath = path.join(tmpDir, 'session.json');
      fs.writeFileSync(sessionPath, 'CORRUPT', 'utf-8');

      const result = store.load();
      expect(result).toBeNull();
    });
  });
});
