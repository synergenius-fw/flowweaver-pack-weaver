import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TaskQueue } from '../src/bot/task-queue.js';
import type { QueuedTask } from '../src/bot/task-queue.js';

describe('TaskQueue', () => {
  let tmpDir: string;
  let queue: TaskQueue;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-test-'));
    queue = new TaskQueue(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('add', () => {
    it('adds a task and returns a non-duplicate result', async () => {
      const result = await queue.add({ instruction: 'do thing', priority: 1 });
      expect(result.duplicate).toBe(false);
      expect(result.id).toHaveLength(8);
    });

    it('assigns pending status and addedAt timestamp', async () => {
      await queue.add({ instruction: 'do thing', priority: 1 });
      const tasks = await queue.list();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe('pending');
      expect(tasks[0].addedAt).toBeGreaterThan(0);
    });

    it('deduplicates against pending tasks with same instruction', async () => {
      const r1 = await queue.add({ instruction: 'same task', priority: 1 });
      const r2 = await queue.add({ instruction: 'same task', priority: 2 });
      expect(r1.duplicate).toBe(false);
      expect(r2.duplicate).toBe(true);
      expect(r2.id).toBe(r1.id);

      const tasks = await queue.list();
      expect(tasks).toHaveLength(1);
    });

    it('allows different instructions', async () => {
      await queue.add({ instruction: 'task A', priority: 1 });
      await queue.add({ instruction: 'task B', priority: 1 });
      const tasks = await queue.list();
      expect(tasks).toHaveLength(2);
    });

    it('deduplicates against recently completed tasks', async () => {
      const r1 = await queue.add({ instruction: 'done task', priority: 1 });
      await queue.markComplete(r1.id);

      const r2 = await queue.add({ instruction: 'done task', priority: 1 });
      expect(r2.duplicate).toBe(true);
    });

    it('throws when queue is full (200 pending tasks)', async () => {
      // Add 200 tasks
      for (let i = 0; i < 200; i++) {
        await queue.add({ instruction: `task-${i}`, priority: 1 });
      }
      await expect(queue.add({ instruction: 'overflow', priority: 1 }))
        .rejects.toThrow(/Queue full/);
    });

    it('preserves optional fields (mode, targets, options)', async () => {
      await queue.add({
        instruction: 'with opts',
        priority: 5,
        mode: 'create',
        targets: ['a.ts', 'b.ts'],
        options: { verbose: true },
      });
      const tasks = await queue.list();
      expect(tasks[0].mode).toBe('create');
      expect(tasks[0].targets).toEqual(['a.ts', 'b.ts']);
      expect(tasks[0].options).toEqual({ verbose: true });
    });
  });

  describe('next', () => {
    it('returns null on empty queue', async () => {
      expect(await queue.next()).toBeNull();
    });

    it('returns highest priority task', async () => {
      await queue.add({ instruction: 'low', priority: 1 });
      await queue.add({ instruction: 'high', priority: 10 });
      await queue.add({ instruction: 'mid', priority: 5 });

      const next = await queue.next();
      expect(next?.instruction).toBe('high');
    });

    it('returns oldest task when priorities are equal', async () => {
      await queue.add({ instruction: 'first', priority: 1 });
      await queue.add({ instruction: 'second', priority: 1 });

      const next = await queue.next();
      expect(next?.instruction).toBe('first');
    });

    it('skips non-pending tasks', async () => {
      const r1 = await queue.add({ instruction: 'running', priority: 10 });
      await queue.add({ instruction: 'pending', priority: 1 });
      await queue.markRunning(r1.id);

      const next = await queue.next();
      expect(next?.instruction).toBe('pending');
    });
  });

  describe('claimNext', () => {
    it('returns null on empty queue', async () => {
      expect(await queue.claimNext()).toBeNull();
    });

    it('atomically claims and marks task as running', async () => {
      await queue.add({ instruction: 'claim me', priority: 1 });
      const claimed = await queue.claimNext();

      expect(claimed).not.toBeNull();
      expect(claimed!.instruction).toBe('claim me');
      expect(claimed!.status).toBe('running');
      expect(claimed!.runnerId).toBe(process.pid);

      // Should be no pending tasks left
      const next = await queue.next();
      expect(next).toBeNull();
    });

    it('claims highest priority task', async () => {
      await queue.add({ instruction: 'low', priority: 1 });
      await queue.add({ instruction: 'high', priority: 10 });

      const claimed = await queue.claimNext();
      expect(claimed!.instruction).toBe('high');
    });
  });

  describe('remove', () => {
    it('removes an existing task', async () => {
      const { id } = await queue.add({ instruction: 'remove me', priority: 1 });
      const removed = await queue.remove(id);
      expect(removed).toBe(true);
      expect(await queue.list()).toHaveLength(0);
    });

    it('returns false for non-existent id', async () => {
      const removed = await queue.remove('nonexist');
      expect(removed).toBe(false);
    });
  });

  describe('clear', () => {
    it('returns 0 on empty queue', async () => {
      expect(await queue.clear()).toBe(0);
    });

    it('removes all tasks and returns count', async () => {
      await queue.add({ instruction: 'a', priority: 1 });
      await queue.add({ instruction: 'b', priority: 1 });
      await queue.add({ instruction: 'c', priority: 1 });

      const count = await queue.clear();
      expect(count).toBe(3);
      expect(await queue.list()).toHaveLength(0);
    });
  });

  describe('status transitions', () => {
    it('markRunning sets status and runnerId', async () => {
      const { id } = await queue.add({ instruction: 'run me', priority: 1 });
      await queue.markRunning(id);

      const tasks = await queue.list();
      expect(tasks[0].status).toBe('running');
      expect(tasks[0].runnerId).toBe(process.pid);
    });

    it('markComplete sets status to completed', async () => {
      const { id } = await queue.add({ instruction: 'complete me', priority: 1 });
      await queue.markComplete(id);

      const tasks = await queue.list();
      expect(tasks[0].status).toBe('completed');
    });

    it('markNoOp sets status to no-op', async () => {
      const { id } = await queue.add({ instruction: 'noop me', priority: 1 });
      await queue.markNoOp(id);

      const tasks = await queue.list();
      expect(tasks[0].status).toBe('no-op');
    });

    it('markFailed sets status and truncates reason to 500 chars', async () => {
      const { id } = await queue.add({ instruction: 'fail me', priority: 1 });
      const longReason = 'x'.repeat(1000);
      await queue.markFailed(id, longReason);

      const tasks = await queue.list();
      expect(tasks[0].status).toBe('failed');
      expect(tasks[0].failureReason).toHaveLength(500);
    });

    it('markFailed without reason does not set failureReason', async () => {
      const { id } = await queue.add({ instruction: 'fail me', priority: 1 });
      await queue.markFailed(id);

      const tasks = await queue.list();
      expect(tasks[0].status).toBe('failed');
      expect(tasks[0].failureReason).toBeUndefined();
    });
  });

  describe('retry', () => {
    it('resets a failed task to pending', async () => {
      const { id } = await queue.add({ instruction: 'retry me', priority: 1 });
      await queue.markFailed(id, 'oops');
      const retried = await queue.retry(id);

      expect(retried).toBe(true);
      const tasks = await queue.list();
      expect(tasks[0].status).toBe('pending');
      expect(tasks[0].failureReason).toBeUndefined();
    });

    it('resets a running task to pending (crash recovery)', async () => {
      const { id } = await queue.add({ instruction: 'stuck', priority: 1 });
      await queue.markRunning(id);
      const retried = await queue.retry(id);

      expect(retried).toBe(true);
      const tasks = await queue.list();
      expect(tasks[0].status).toBe('pending');
    });

    it('returns false for pending tasks', async () => {
      const { id } = await queue.add({ instruction: 'already pending', priority: 1 });
      expect(await queue.retry(id)).toBe(false);
    });

    it('returns false for completed tasks', async () => {
      const { id } = await queue.add({ instruction: 'done', priority: 1 });
      await queue.markComplete(id);
      expect(await queue.retry(id)).toBe(false);
    });

    it('returns false for non-existent id', async () => {
      expect(await queue.retry('nope')).toBe(false);
    });
  });

  describe('retryAll', () => {
    it('resets all failed tasks and returns count', async () => {
      const r1 = await queue.add({ instruction: 'fail1', priority: 1 });
      const r2 = await queue.add({ instruction: 'fail2', priority: 1 });
      await queue.add({ instruction: 'pending', priority: 1 });
      await queue.markFailed(r1.id, 'err');
      await queue.markFailed(r2.id, 'err');

      const count = await queue.retryAll();
      expect(count).toBe(2);

      const tasks = await queue.list();
      const pending = tasks.filter(t => t.status === 'pending');
      expect(pending).toHaveLength(3);
    });

    it('returns 0 when no failed tasks', async () => {
      await queue.add({ instruction: 'ok', priority: 1 });
      expect(await queue.retryAll()).toBe(0);
    });
  });

  describe('recoverOrphans', () => {
    it('resets running tasks with dead PID back to pending', async () => {
      const { id } = await queue.add({ instruction: 'orphan', priority: 1 });
      await queue.markRunning(id);

      // Manually set runnerId to a dead PID
      const filePath = queue.filePath;
      const content = fs.readFileSync(filePath, 'utf-8');
      const patched = content.replace(
        `"runnerId":${process.pid}`,
        `"runnerId":999999`,
      );
      fs.writeFileSync(filePath, patched, 'utf-8');

      const count = await queue.recoverOrphans();
      expect(count).toBe(1);

      const tasks = await queue.list();
      expect(tasks[0].status).toBe('pending');
      expect(tasks[0].runnerId).toBeUndefined();
    });

    it('does not reset running tasks with alive PID', async () => {
      const { id } = await queue.add({ instruction: 'alive', priority: 1 });
      await queue.markRunning(id);

      // Current process PID is alive
      const count = await queue.recoverOrphans();
      expect(count).toBe(0);

      const tasks = await queue.list();
      expect(tasks[0].status).toBe('running');
    });

    it('resets running tasks with no runnerId', async () => {
      const { id } = await queue.add({ instruction: 'no pid', priority: 1 });
      await queue.markRunning(id);

      // Remove the runnerId field
      const filePath = queue.filePath;
      const content = fs.readFileSync(filePath, 'utf-8');
      const patched = content.replace(/,"runnerId":\d+/, '');
      fs.writeFileSync(filePath, patched, 'utf-8');

      const count = await queue.recoverOrphans();
      expect(count).toBe(1);
    });

    it('returns 0 when no running tasks', async () => {
      await queue.add({ instruction: 'pending', priority: 1 });
      expect(await queue.recoverOrphans()).toBe(0);
    });
  });

  describe('persistence', () => {
    it('survives across queue instances', async () => {
      await queue.add({ instruction: 'persist me', priority: 1 });

      const queue2 = new TaskQueue(tmpDir);
      const tasks = await queue2.list();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].instruction).toBe('persist me');
    });

    it('handles empty/missing file gracefully', async () => {
      const tasks = await queue.list();
      expect(tasks).toEqual([]);
    });

    it('writeAll uses atomic rename (temp file pattern)', async () => {
      await queue.add({ instruction: 'atomic', priority: 1 });
      await queue.markComplete(await queue.list().then(t => t[0].id));

      // After a writeAll (triggered by markComplete), no .tmp files should remain
      const files = fs.readdirSync(tmpDir);
      const tmpFiles = files.filter(f => f.includes('.tmp.'));
      expect(tmpFiles).toHaveLength(0);
    });
  });
});
