import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileWatcher } from '../src/bot/file-watcher.js';

// ---------------------------------------------------------------------------
// Tests for file-watcher.ts
// Focus: lifecycle, debounce, polling fallback, resource leak on double-start
// ---------------------------------------------------------------------------

let tmpDir: string;
let testFile: string;

function touchFile(filePath: string): void {
  const now = Date.now();
  // Write new content to ensure mtime changes
  fs.writeFileSync(filePath, `touched-${now}`);
  // Also explicitly set mtime forward to be safe with fast timers
  const futureTime = new Date(now + 5000);
  fs.utimesSync(filePath, futureTime, futureTime);
}

describe('FileWatcher', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-filewatcher-'));
    testFile = path.join(tmpDir, 'watched.txt');
    fs.writeFileSync(testFile, 'initial');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // Basic lifecycle
  // =========================================================================
  describe('start and stop', () => {
    it('emits change when file is modified', async () => {
      const watcher = new FileWatcher({ filePath: testFile, debounceMs: 50 });
      const changes: number[] = [];
      watcher.on('change', () => changes.push(Date.now()));

      watcher.start();

      // Wait for watcher to settle, then touch
      await new Promise((r) => setTimeout(r, 100));
      touchFile(testFile);

      // Wait for debounce
      await new Promise((r) => setTimeout(r, 200));
      watcher.stop();

      expect(changes.length).toBeGreaterThanOrEqual(1);
    });

    it('stop prevents further change events', async () => {
      const watcher = new FileWatcher({ filePath: testFile, debounceMs: 50 });
      const changes: number[] = [];
      watcher.on('change', () => changes.push(Date.now()));

      watcher.start();
      await new Promise((r) => setTimeout(r, 100));
      touchFile(testFile);
      await new Promise((r) => setTimeout(r, 200));

      const countBefore = changes.length;
      watcher.stop();

      touchFile(testFile);
      await new Promise((r) => setTimeout(r, 200));

      expect(changes.length).toBe(countBefore);
    });

    it('stop is safe to call when not started', () => {
      const watcher = new FileWatcher({ filePath: testFile });
      expect(() => watcher.stop()).not.toThrow();
    });

    it('stop is safe to call multiple times', () => {
      const watcher = new FileWatcher({ filePath: testFile });
      watcher.start();
      watcher.stop();
      expect(() => watcher.stop()).not.toThrow();
    });
  });

  // =========================================================================
  // Constructor defaults
  // =========================================================================
  describe('constructor', () => {
    it('uses default debounceMs and pollingIntervalMs', () => {
      const watcher = new FileWatcher({ filePath: testFile });
      // Access private fields via cast to verify defaults
      expect((watcher as any).debounceMs).toBe(500);
      expect((watcher as any).pollingIntervalMs).toBe(2000);
    });

    it('accepts custom debounceMs and pollingIntervalMs', () => {
      const watcher = new FileWatcher({
        filePath: testFile,
        debounceMs: 100,
        pollingIntervalMs: 500,
      });
      expect((watcher as any).debounceMs).toBe(100);
      expect((watcher as any).pollingIntervalMs).toBe(500);
    });
  });

  // =========================================================================
  // Polling fallback
  // =========================================================================
  describe('polling fallback', () => {
    it('falls back to polling when file does not exist at start', async () => {
      const missingFile = path.join(tmpDir, 'does-not-exist.txt');
      const watcher = new FileWatcher({
        filePath: missingFile,
        debounceMs: 50,
        pollingIntervalMs: 100,
      });
      const changes: number[] = [];
      watcher.on('change', () => changes.push(Date.now()));

      watcher.start();

      // Create the file after a short delay — polling should detect it
      await new Promise((r) => setTimeout(r, 150));
      fs.writeFileSync(missingFile, 'created');

      // Wait for poll cycle + debounce
      await new Promise((r) => setTimeout(r, 400));
      watcher.stop();

      expect(changes.length).toBeGreaterThanOrEqual(1);
    });

    it('detects changes in polling mode', async () => {
      // Start watching a file, then force polling by making fs.watch fail
      const watcher = new FileWatcher({
        filePath: testFile,
        debounceMs: 50,
        pollingIntervalMs: 100,
      });
      const changes: number[] = [];
      watcher.on('change', () => changes.push(Date.now()));

      // Force polling by calling switchToPolling directly
      (watcher as any).stopped = false;
      (watcher as any).lastMtime = (watcher as any).getMtime();
      (watcher as any).switchToPolling();

      await new Promise((r) => setTimeout(r, 150));
      touchFile(testFile);
      await new Promise((r) => setTimeout(r, 300));

      watcher.stop();
      expect(changes.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // Debounce
  // =========================================================================
  describe('debounce', () => {
    it('coalesces rapid events into one change', async () => {
      const watcher = new FileWatcher({ filePath: testFile, debounceMs: 200 });
      const changes: number[] = [];
      watcher.on('change', () => changes.push(Date.now()));

      watcher.start();
      await new Promise((r) => setTimeout(r, 100));

      // Rapid-fire 5 touches
      for (let i = 0; i < 5; i++) {
        touchFile(testFile);
        await new Promise((r) => setTimeout(r, 20));
      }

      // Wait for debounce to settle
      await new Promise((r) => setTimeout(r, 400));
      watcher.stop();

      // Should get 1 (or at most 2) change events, not 5
      expect(changes.length).toBeLessThanOrEqual(2);
      expect(changes.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // getMtime
  // =========================================================================
  describe('getMtime', () => {
    it('returns 0 for missing file', () => {
      const watcher = new FileWatcher({ filePath: '/nonexistent/path.txt' });
      expect((watcher as any).getMtime()).toBe(0);
    });

    it('returns positive mtime for existing file', () => {
      const watcher = new FileWatcher({ filePath: testFile });
      expect((watcher as any).getMtime()).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // RESOURCE LEAK BUG: double-start
  // =========================================================================
  describe('double-start resource leak', () => {
    it('calling start() twice closes the first watcher (no resource leak)', async () => {
      const watcher = new FileWatcher({
        filePath: testFile,
        debounceMs: 50,
      });

      watcher.start();  // creates watcher #1
      const firstWatcher = (watcher as any).watcher as fs.FSWatcher;
      expect(firstWatcher).not.toBeNull();

      // Track whether the first watcher gets closed
      let firstWatcherClosed = false;
      const origClose = firstWatcher.close.bind(firstWatcher);
      firstWatcher.close = () => {
        firstWatcherClosed = true;
        origClose();
      };

      watcher.start();  // should close #1, create watcher #2

      // With the bug: firstWatcherClosed is false — resource leaked
      // With the fix: firstWatcherClosed is true — properly cleaned up
      expect(firstWatcherClosed).toBe(true);

      // The current watcher should be a NEW one, not the old one
      const secondWatcher = (watcher as any).watcher;
      expect(secondWatcher).not.toBe(firstWatcher);

      watcher.stop();
    });

    it('stop() after double-start has no leaked timers or watchers', async () => {
      const watcher = new FileWatcher({
        filePath: testFile,
        debounceMs: 50,
        pollingIntervalMs: 100,
      });

      watcher.start();
      const firstWatcher = (watcher as any).watcher as fs.FSWatcher;
      let firstClosed = false;
      const origClose = firstWatcher.close.bind(firstWatcher);
      firstWatcher.close = () => {
        firstClosed = true;
        origClose();
      };

      watcher.start();
      watcher.stop();

      // First watcher must have been closed (by second start() or by stop())
      expect(firstClosed).toBe(true);
      // Internal state should be fully cleaned
      expect((watcher as any).watcher).toBeNull();
      expect((watcher as any).pollTimer).toBeNull();
    });
  });

  // =========================================================================
  // Restart after stop
  // =========================================================================
  describe('restart after stop', () => {
    it('can be restarted after being stopped', async () => {
      const watcher = new FileWatcher({ filePath: testFile, debounceMs: 50 });
      const changes: number[] = [];
      watcher.on('change', () => changes.push(Date.now()));

      watcher.start();
      await new Promise((r) => setTimeout(r, 100));
      touchFile(testFile);
      await new Promise((r) => setTimeout(r, 200));
      watcher.stop();
      const countAfterStop = changes.length;

      // Restart
      watcher.start();
      await new Promise((r) => setTimeout(r, 100));
      touchFile(testFile);
      await new Promise((r) => setTimeout(r, 200));
      watcher.stop();

      expect(changes.length).toBeGreaterThan(countAfterStop);
    });
  });

  // =========================================================================
  // switchToPolling race: duplicate polling chains
  // =========================================================================
  describe('switchToPolling race', () => {
    it('does not create duplicate polling chains on repeated calls', async () => {
      const watcher = new FileWatcher({
        filePath: testFile,
        debounceMs: 50,
        pollingIntervalMs: 100,
      });
      const changes: number[] = [];
      watcher.on('change', () => changes.push(Date.now()));

      (watcher as any).stopped = false;
      (watcher as any).lastMtime = (watcher as any).getMtime();

      // Call switchToPolling three times — should only create one chain
      (watcher as any).switchToPolling();
      (watcher as any).switchToPolling();
      (watcher as any).switchToPolling();

      await new Promise((r) => setTimeout(r, 150));
      touchFile(testFile);
      await new Promise((r) => setTimeout(r, 300));

      watcher.stop();

      // With multiple chains: multiple changes per touch
      // With guard: exactly 1 change
      expect(changes.length).toBe(1);
    });
  });
});
