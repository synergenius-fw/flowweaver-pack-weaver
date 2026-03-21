import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { WeaverEnv, WeaverContext } from '../src/bot/types.js';
import { weaverReceiveTask } from '../src/node-types/receive-task.js';

function makeEnv(): WeaverEnv {
  return {
    projectDir: '/tmp/proj',
    config: { provider: 'auto' },
    providerType: 'anthropic',
    providerInfo: { type: 'anthropic' },
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receive-task-test-'));
  fs.mkdirSync(path.join(tmpDir, '.weaver'), { recursive: true });
  process.env.HOME = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('weaverReceiveTask', () => {
  it('dry-run (execute=false) returns onSuccess=true with hasTask=false', async () => {
    const result = await weaverReceiveTask(false, makeEnv());
    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    expect(ctx.hasTask).toBe(false);
  });

  it('pre-supplied taskJson with instruction returns onSuccess=true with hasTask=true', async () => {
    const task = { instruction: 'build a thing', mode: 'create' };
    const result = await weaverReceiveTask(true, makeEnv(), JSON.stringify(task));
    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    expect(ctx.hasTask).toBe(true);
    expect(JSON.parse(ctx.taskJson!).instruction).toBe('build a thing');
  });

  it('pre-supplied taskJson without instruction falls through to queue check', async () => {
    // No instruction → falls through; queue empty → onFailure
    const taskNoInstruction = { mode: 'create' };
    const result = await weaverReceiveTask(true, makeEnv(), JSON.stringify(taskNoInstruction));
    expect(result.onSuccess).toBe(false);
    expect(result.onFailure).toBe(true);
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    expect(ctx.hasTask).toBe(false);
  });

  it('invalid JSON in pre-supplied taskJson falls through to queue (queue empty → onFailure)', async () => {
    const result = await weaverReceiveTask(true, makeEnv(), 'not-valid-json{{{');
    expect(result.onSuccess).toBe(false);
    expect(result.onFailure).toBe(true);
  });

  it('empty queue returns onFailure=true with hasTask=false', async () => {
    const result = await weaverReceiveTask(true, makeEnv());
    expect(result.onSuccess).toBe(false);
    expect(result.onFailure).toBe(true);
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    expect(ctx.hasTask).toBe(false);
  });

  it('pending task in queue is claimed and returned with hasTask=true', async () => {
    const queuePath = path.join(tmpDir, '.weaver', 'task-queue.ndjson');
    const queuedTask = {
      id: 'task-abc',
      instruction: 'fix the bug',
      mode: 'modify',
      priority: 0,
      addedAt: Date.now(),
      status: 'pending',
    };
    fs.writeFileSync(queuePath, JSON.stringify(queuedTask) + '\n');

    const result = await weaverReceiveTask(true, makeEnv());
    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    expect(ctx.hasTask).toBe(true);
    const task = JSON.parse(ctx.taskJson!);
    expect(task.instruction).toBe('fix the bug');
    expect(task.queueId).toBe('task-abc');
  });

  it('claimed task is marked as running in the queue file', async () => {
    const queuePath = path.join(tmpDir, '.weaver', 'task-queue.ndjson');
    const queuedTask = {
      id: 'task-xyz',
      instruction: 'do something',
      priority: 0,
      addedAt: Date.now(),
      status: 'pending',
    };
    fs.writeFileSync(queuePath, JSON.stringify(queuedTask) + '\n');

    await weaverReceiveTask(true, makeEnv());

    const lines = fs.readFileSync(queuePath, 'utf-8').trim().split('\n').filter(Boolean);
    const stored = JSON.parse(lines[0]!);
    expect(stored.status).toBe('running');
  });

  it('already-running tasks are skipped; only pending tasks are claimed', async () => {
    const queuePath = path.join(tmpDir, '.weaver', 'task-queue.ndjson');
    const runningTask = {
      id: 'task-running',
      instruction: 'already running',
      priority: 5,
      addedAt: Date.now() - 1000,
      status: 'running',
    };
    const pendingTask = {
      id: 'task-pending',
      instruction: 'waiting',
      priority: 0,
      addedAt: Date.now(),
      status: 'pending',
    };
    fs.writeFileSync(queuePath, [runningTask, pendingTask].map(t => JSON.stringify(t)).join('\n') + '\n');

    const result = await weaverReceiveTask(true, makeEnv());
    expect(result.onSuccess).toBe(true);
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const task = JSON.parse(ctx.taskJson!);
    expect(task.queueId).toBe('task-pending');
  });

  it('highest-priority pending task is claimed first', async () => {
    const queuePath = path.join(tmpDir, '.weaver', 'task-queue.ndjson');
    const lowPriority = {
      id: 'low',
      instruction: 'low priority',
      priority: 0,
      addedAt: Date.now(),
      status: 'pending',
    };
    const highPriority = {
      id: 'high',
      instruction: 'high priority',
      priority: 10,
      addedAt: Date.now() + 1000,
      status: 'pending',
    };
    fs.writeFileSync(queuePath, [lowPriority, highPriority].map(t => JSON.stringify(t)).join('\n') + '\n');

    const result = await weaverReceiveTask(true, makeEnv());
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const task = JSON.parse(ctx.taskJson!);
    expect(task.queueId).toBe('high');
  });
});
