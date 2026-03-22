import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskQueue } from '../src/bot/task-queue.js';

describe('TaskQueue lifecycle', () => {
  let tmpDir: string;
  let queue: TaskQueue;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-queue-'));
    queue = new TaskQueue(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds a task as pending', async () => {
    const { id } = await queue.add({ instruction: 'test task', priority: 0 });
    const tasks = await queue.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(id);
    expect(tasks[0].status).toBe('pending');
  });

  it('marks task as running', async () => {
    const { id } = await queue.add({ instruction: 'test', priority: 0 });
    await queue.markRunning(id);
    const tasks = await queue.list();
    expect(tasks[0].status).toBe('running');
  });

  it('marks task as completed', async () => {
    const { id } = await queue.add({ instruction: 'test', priority: 0 });
    await queue.markRunning(id);
    await queue.markComplete(id);
    const tasks = await queue.list();
    expect(tasks[0].status).toBe('completed');
  });

  it('marks task as failed', async () => {
    const { id } = await queue.add({ instruction: 'test', priority: 0 });
    await queue.markRunning(id);
    await queue.markFailed(id);
    const tasks = await queue.list();
    expect(tasks[0].status).toBe('failed');
  });

  it('full lifecycle: pending → running → completed', async () => {
    const { id } = await queue.add({ instruction: 'full lifecycle', priority: 0 });
    expect((await queue.list())[0].status).toBe('pending');

    await queue.markRunning(id);
    expect((await queue.list())[0].status).toBe('running');

    await queue.markComplete(id);
    expect((await queue.list())[0].status).toBe('completed');
  });

  it('full lifecycle: pending → running → failed', async () => {
    const { id } = await queue.add({ instruction: 'fail lifecycle', priority: 0 });
    await queue.markRunning(id);
    await queue.markFailed(id);
    expect((await queue.list())[0].status).toBe('failed');
  });
});

describe('TaskQueue retry', () => {
  let tmpDir: string;
  let queue: TaskQueue;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-queue-'));
    queue = new TaskQueue(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('retries a failed task (resets to pending)', async () => {
    const { id } = await queue.add({ instruction: 'retry me', priority: 0 });
    await queue.markRunning(id);
    await queue.markFailed(id);
    expect((await queue.list())[0].status).toBe('failed');

    const retried = await queue.retry(id);
    expect(retried).toBe(true);
    expect((await queue.list())[0].status).toBe('pending');
  });

  it('retries a stuck running task', async () => {
    const { id } = await queue.add({ instruction: 'stuck', priority: 0 });
    await queue.markRunning(id);

    const retried = await queue.retry(id);
    expect(retried).toBe(true);
    expect((await queue.list())[0].status).toBe('pending');
  });

  it('does not retry completed tasks', async () => {
    const { id } = await queue.add({ instruction: 'done', priority: 0 });
    await queue.markComplete(id);

    const retried = await queue.retry(id);
    expect(retried).toBe(false);
    expect((await queue.list())[0].status).toBe('completed');
  });

  it('does not retry pending tasks', async () => {
    const { id } = await queue.add({ instruction: 'waiting', priority: 0 });

    const retried = await queue.retry(id);
    expect(retried).toBe(false);
    expect((await queue.list())[0].status).toBe('pending');
  });

  it('retries non-existent id returns false', async () => {
    const retried = await queue.retry('nonexistent');
    expect(retried).toBe(false);
  });

  it('retryAll resets all failed tasks', async () => {
    const { id: id1 } = await queue.add({ instruction: 'fail 1', priority: 0 });
    const { id: id2 } = await queue.add({ instruction: 'fail 2', priority: 0 });
    const { id: id3 } = await queue.add({ instruction: 'success', priority: 0 });

    await queue.markFailed(id1);
    await queue.markFailed(id2);
    await queue.markComplete(id3);

    const count = await queue.retryAll();
    expect(count).toBe(2);

    const tasks = await queue.list();
    expect(tasks.find(t => t.id === id1)!.status).toBe('pending');
    expect(tasks.find(t => t.id === id2)!.status).toBe('pending');
    expect(tasks.find(t => t.id === id3)!.status).toBe('completed');
  });

  it('retryAll with no failed tasks returns 0', async () => {
    await queue.add({ instruction: 'ok', priority: 0 });
    const count = await queue.retryAll();
    expect(count).toBe(0);
  });
});

describe('TaskQueue crash recovery', () => {
  let tmpDir: string;
  let queue: TaskQueue;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-queue-'));
    queue = new TaskQueue(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('recoverOrphans resets running tasks to pending when PID is dead', async () => {
    const { id: id1 } = await queue.add({ instruction: 'orphan 1', priority: 0 });
    const { id: id2 } = await queue.add({ instruction: 'orphan 2', priority: 0 });
    await queue.add({ instruction: 'pending recovery', priority: 0 });

    await queue.markRunning(id1);
    await queue.markRunning(id2);

    // Simulate dead PIDs by patching runnerId to a non-existent PID
    const raw = fs.readFileSync(queue.filePath, 'utf-8');
    const patched = raw.split('\n').map(line => {
      if (!line.trim()) return line;
      try {
        const task = JSON.parse(line);
        if (task.status === 'running') task.runnerId = 999999;
        return JSON.stringify(task);
      } catch { return line; }
    }).join('\n');
    fs.writeFileSync(queue.filePath, patched, 'utf-8');

    const recovered = await queue.recoverOrphans();
    expect(recovered).toBe(2);

    const tasks = await queue.list();
    expect(tasks.filter(t => t.status === 'pending')).toHaveLength(3);
    expect(tasks.filter(t => t.status === 'running')).toHaveLength(0);
  });

  it('recoverOrphans skips running tasks whose process is still alive', async () => {
    const { id } = await queue.add({ instruction: 'still running', priority: 0 });
    await queue.markRunning(id);

    // runnerId defaults to current process PID, which IS alive
    const recovered = await queue.recoverOrphans();
    expect(recovered).toBe(0);

    const tasks = await queue.list();
    expect(tasks.find(t => t.id === id)!.status).toBe('running');
  });

  it('recoverOrphans does not touch failed/completed tasks', async () => {
    const { id: id1 } = await queue.add({ instruction: 'failed recovery', priority: 0 });
    const { id: id2 } = await queue.add({ instruction: 'completed recovery', priority: 0 });

    await queue.markFailed(id1);
    await queue.markComplete(id2);

    const recovered = await queue.recoverOrphans();
    expect(recovered).toBe(0);

    const tasks = await queue.list();
    expect(tasks.find(t => t.id === id1)!.status).toBe('failed');
    expect(tasks.find(t => t.id === id2)!.status).toBe('completed');
  });

  it('recoverOrphans on empty queue returns 0', async () => {
    const recovered = await queue.recoverOrphans();
    expect(recovered).toBe(0);
  });
});

describe('TaskQueue priority and ordering', () => {
  let tmpDir: string;
  let queue: TaskQueue;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-queue-'));
    queue = new TaskQueue(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('next() returns highest priority task', async () => {
    await queue.add({ instruction: 'low', priority: 0 });
    await queue.add({ instruction: 'high', priority: 10 });
    await queue.add({ instruction: 'medium', priority: 5 });

    const next = await queue.next();
    expect(next!.instruction).toBe('high');
  });

  it('next() returns earliest task when same priority', async () => {
    await queue.add({ instruction: 'first', priority: 0 });
    // Small delay to ensure different addedAt
    await new Promise(r => setTimeout(r, 10));
    await queue.add({ instruction: 'second', priority: 0 });

    const next = await queue.next();
    expect(next!.instruction).toBe('first');
  });

  it('next() skips running/completed/failed tasks', async () => {
    const { id: id1 } = await queue.add({ instruction: 'running skip', priority: 10 });
    const { id: id2 } = await queue.add({ instruction: 'failed skip', priority: 5 });
    await queue.add({ instruction: 'pending skip', priority: 0 });

    await queue.markRunning(id1);
    await queue.markFailed(id2);

    const next = await queue.next();
    expect(next!.instruction).toBe('pending skip');
  });

  it('next() returns null when no pending tasks', async () => {
    const { id } = await queue.add({ instruction: 'done', priority: 0 });
    await queue.markComplete(id);

    const next = await queue.next();
    expect(next).toBeNull();
  });
});

describe('TaskQueue claimNext (atomic select+mark running)', () => {
  let tmpDir: string;
  let queue: TaskQueue;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-queue-'));
    queue = new TaskQueue(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('claimNext() returns highest priority task and marks it running with PID', async () => {
    await queue.add({ instruction: 'low', priority: 0 });
    await queue.add({ instruction: 'high', priority: 10 });

    const claimed = await queue.claimNext();
    expect(claimed).not.toBeNull();
    expect(claimed!.instruction).toBe('high');
    expect(claimed!.status).toBe('running');
    expect(claimed!.runnerId).toBe(process.pid);

    // Verify it is persisted as running with PID
    const tasks = await queue.list();
    const highTask = tasks.find(t => t.instruction === 'high');
    expect(highTask!.status).toBe('running');
    expect(highTask!.runnerId).toBe(process.pid);
  });

  it('claimNext() returns null when no pending tasks', async () => {
    const { id } = await queue.add({ instruction: 'done', priority: 0 });
    await queue.markComplete(id);

    const claimed = await queue.claimNext();
    expect(claimed).toBeNull();
  });

  it('claimNext() skips already-running tasks', async () => {
    const { id } = await queue.add({ instruction: 'running one', priority: 10 });
    await queue.add({ instruction: 'pending one', priority: 5 });
    await queue.markRunning(id);

    const claimed = await queue.claimNext();
    expect(claimed!.instruction).toBe('pending one');
    expect(claimed!.status).toBe('running');
  });

  it('successive claimNext() calls dispatch different tasks', async () => {
    await queue.add({ instruction: 'task-1', priority: 5 });
    await queue.add({ instruction: 'task-2', priority: 5 });

    const first = await queue.claimNext();
    const second = await queue.claimNext();

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.id).not.toBe(second!.id);
  });

  it('claimNext() returns null on empty queue', async () => {
    expect(await queue.claimNext()).toBeNull();
  });
});

describe('TaskQueue atomic writeAll', () => {
  let tmpDir: string;
  let queue: TaskQueue;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-queue-'));
    queue = new TaskQueue(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writeAll uses write+rename (no .tmp file left behind)', async () => {
    await queue.add({ instruction: 'atomic test', priority: 0 });
    await queue.markComplete((await queue.list())[0].id);

    // After the operation, there should be no .tmp file
    const files = fs.readdirSync(tmpDir);
    const tmpFiles = files.filter(f => f.includes('.tmp.'));
    expect(tmpFiles).toHaveLength(0);

    // But the data should be intact
    const tasks = await queue.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe('completed');
  });
});
