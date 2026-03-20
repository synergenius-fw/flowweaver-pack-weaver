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
    const id = await queue.add({ instruction: 'test task', priority: 0 });
    const tasks = await queue.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(id);
    expect(tasks[0].status).toBe('pending');
  });

  it('marks task as running', async () => {
    const id = await queue.add({ instruction: 'test', priority: 0 });
    await queue.markRunning(id);
    const tasks = await queue.list();
    expect(tasks[0].status).toBe('running');
  });

  it('marks task as completed', async () => {
    const id = await queue.add({ instruction: 'test', priority: 0 });
    await queue.markRunning(id);
    await queue.markComplete(id);
    const tasks = await queue.list();
    expect(tasks[0].status).toBe('completed');
  });

  it('marks task as failed', async () => {
    const id = await queue.add({ instruction: 'test', priority: 0 });
    await queue.markRunning(id);
    await queue.markFailed(id);
    const tasks = await queue.list();
    expect(tasks[0].status).toBe('failed');
  });

  it('full lifecycle: pending → running → completed', async () => {
    const id = await queue.add({ instruction: 'full lifecycle', priority: 0 });
    expect((await queue.list())[0].status).toBe('pending');

    await queue.markRunning(id);
    expect((await queue.list())[0].status).toBe('running');

    await queue.markComplete(id);
    expect((await queue.list())[0].status).toBe('completed');
  });

  it('full lifecycle: pending → running → failed', async () => {
    const id = await queue.add({ instruction: 'fail lifecycle', priority: 0 });
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
    const id = await queue.add({ instruction: 'retry me', priority: 0 });
    await queue.markRunning(id);
    await queue.markFailed(id);
    expect((await queue.list())[0].status).toBe('failed');

    const retried = await queue.retry(id);
    expect(retried).toBe(true);
    expect((await queue.list())[0].status).toBe('pending');
  });

  it('retries a stuck running task', async () => {
    const id = await queue.add({ instruction: 'stuck', priority: 0 });
    await queue.markRunning(id);

    const retried = await queue.retry(id);
    expect(retried).toBe(true);
    expect((await queue.list())[0].status).toBe('pending');
  });

  it('does not retry completed tasks', async () => {
    const id = await queue.add({ instruction: 'done', priority: 0 });
    await queue.markComplete(id);

    const retried = await queue.retry(id);
    expect(retried).toBe(false);
    expect((await queue.list())[0].status).toBe('completed');
  });

  it('does not retry pending tasks', async () => {
    const id = await queue.add({ instruction: 'waiting', priority: 0 });

    const retried = await queue.retry(id);
    expect(retried).toBe(false);
    expect((await queue.list())[0].status).toBe('pending');
  });

  it('retries non-existent id returns false', async () => {
    const retried = await queue.retry('nonexistent');
    expect(retried).toBe(false);
  });

  it('retryAll resets all failed tasks', async () => {
    const id1 = await queue.add({ instruction: 'fail 1', priority: 0 });
    const id2 = await queue.add({ instruction: 'fail 2', priority: 0 });
    const id3 = await queue.add({ instruction: 'success', priority: 0 });

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

  it('recoverOrphans resets running tasks to pending', async () => {
    const id1 = await queue.add({ instruction: 'orphan 1', priority: 0 });
    const id2 = await queue.add({ instruction: 'orphan 2', priority: 0 });
    const id3 = await queue.add({ instruction: 'pending', priority: 0 });

    await queue.markRunning(id1);
    await queue.markRunning(id2);

    const recovered = await queue.recoverOrphans();
    expect(recovered).toBe(2);

    const tasks = await queue.list();
    expect(tasks.filter(t => t.status === 'pending')).toHaveLength(3);
    expect(tasks.filter(t => t.status === 'running')).toHaveLength(0);
  });

  it('recoverOrphans does not touch failed/completed tasks', async () => {
    const id1 = await queue.add({ instruction: 'failed', priority: 0 });
    const id2 = await queue.add({ instruction: 'completed', priority: 0 });

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
    const id1 = await queue.add({ instruction: 'running', priority: 10 });
    const id2 = await queue.add({ instruction: 'failed', priority: 5 });
    await queue.add({ instruction: 'pending', priority: 0 });

    await queue.markRunning(id1);
    await queue.markFailed(id2);

    const next = await queue.next();
    expect(next!.instruction).toBe('pending');
  });

  it('next() returns null when no pending tasks', async () => {
    const id = await queue.add({ instruction: 'done', priority: 0 });
    await queue.markComplete(id);

    const next = await queue.next();
    expect(next).toBeNull();
  });
});
