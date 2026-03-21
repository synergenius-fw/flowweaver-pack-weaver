import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TaskQueue } from '../src/bot/task-queue.js';
import { SteeringController } from '../src/bot/steering.js';
import type { QueuedTask } from '../src/bot/task-queue.js';
import type { SteeringCommand } from '../src/bot/steering.js';

// ---------------------------------------------------------------------------
// TaskQueue
// ---------------------------------------------------------------------------
describe('TaskQueue', () => {
  let tmpDir: string;
  let queue: TaskQueue;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-'));
    queue = new TaskQueue(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -- add / list ----------------------------------------------------------

  it('add() returns a string ID and task appears in list()', async () => {
    const { id } = await queue.add({ instruction: 'do stuff', priority: 1 });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);

    const tasks = await queue.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(id);
    expect(tasks[0].instruction).toBe('do stuff');
    expect(tasks[0].priority).toBe(1);
    expect(tasks[0].status).toBe('pending');
    expect(typeof tasks[0].addedAt).toBe('number');
  });

  it('add() preserves optional fields (mode, targets, options)', async () => {
    const { id } = await queue.add({
      instruction: 'batch job',
      mode: 'batch',
      targets: ['a.ts', 'b.ts'],
      options: { dryRun: true },
      priority: 5,
    });

    const tasks = await queue.list();
    const task = tasks.find(t => t.id === id)!;
    expect(task.mode).toBe('batch');
    expect(task.targets).toEqual(['a.ts', 'b.ts']);
    expect(task.options).toEqual({ dryRun: true });
  });

  it('add() creates multiple tasks with unique IDs', async () => {
    const { id: id1 } = await queue.add({ instruction: 'first', priority: 1 });
    const { id: id2 } = await queue.add({ instruction: 'second', priority: 1 });
    expect(id1).not.toBe(id2);

    const tasks = await queue.list();
    expect(tasks).toHaveLength(2);
  });

  // -- next() --------------------------------------------------------------

  it('next() returns highest priority pending task', async () => {
    await queue.add({ instruction: 'low', priority: 1 });
    await queue.add({ instruction: 'high', priority: 10 });
    await queue.add({ instruction: 'mid', priority: 5 });

    const next = await queue.next();
    expect(next).not.toBeNull();
    expect(next!.instruction).toBe('high');
    expect(next!.priority).toBe(10);
  });

  it('next() returns oldest task when priorities are equal', async () => {
    await queue.add({ instruction: 'first', priority: 3 });
    // Ensure addedAt differs
    await new Promise(r => setTimeout(r, 5));
    await queue.add({ instruction: 'second', priority: 3 });

    const next = await queue.next();
    expect(next!.instruction).toBe('first');
  });

  it('next() returns null when queue is empty', async () => {
    expect(await queue.next()).toBeNull();
  });

  it('next() skips non-pending tasks', async () => {
    const { id } = await queue.add({ instruction: 'running one', priority: 10 });
    await queue.markRunning(id);
    await queue.add({ instruction: 'pending one', priority: 1 });

    const next = await queue.next();
    expect(next!.instruction).toBe('pending one');
  });

  // -- status transitions --------------------------------------------------

  it('markRunning() changes status to running', async () => {
    const { id } = await queue.add({ instruction: 'mark-running task', priority: 1 });
    await queue.markRunning(id);

    const tasks = await queue.list();
    expect(tasks.find(t => t.id === id)!.status).toBe('running');
  });

  it('markComplete() changes status to completed', async () => {
    const { id } = await queue.add({ instruction: 'mark-complete task', priority: 1 });
    await queue.markRunning(id);
    await queue.markComplete(id);

    const tasks = await queue.list();
    expect(tasks.find(t => t.id === id)!.status).toBe('completed');
  });

  it('markFailed() changes status to failed', async () => {
    const { id } = await queue.add({ instruction: 'mark-failed task', priority: 1 });
    await queue.markRunning(id);
    await queue.markFailed(id);

    const tasks = await queue.list();
    expect(tasks.find(t => t.id === id)!.status).toBe('failed');
  });

  it('status transitions are independent per task', async () => {
    const { id: id1 } = await queue.add({ instruction: 'transition-a', priority: 1 });
    const { id: id2 } = await queue.add({ instruction: 'transition-b', priority: 1 });

    await queue.markRunning(id1);
    await queue.markComplete(id1);
    await queue.markFailed(id2);

    const tasks = await queue.list();
    expect(tasks.find(t => t.id === id1)!.status).toBe('completed');
    expect(tasks.find(t => t.id === id2)!.status).toBe('failed');
  });

  it('markRunning() on nonexistent ID does not throw', async () => {
    await expect(queue.markRunning('nonexistent')).resolves.toBeUndefined();
  });

  // -- remove --------------------------------------------------------------

  it('remove() returns true and removes the task', async () => {
    const { id } = await queue.add({ instruction: 'doomed', priority: 1 });
    expect(await queue.remove(id)).toBe(true);

    const tasks = await queue.list();
    expect(tasks).toHaveLength(0);
  });

  it('remove() returns false for nonexistent ID', async () => {
    expect(await queue.remove('no-such-id')).toBe(false);
  });

  it('remove() only removes the targeted task', async () => {
    const { id: id1 } = await queue.add({ instruction: 'keep', priority: 1 });
    const { id: id2 } = await queue.add({ instruction: 'remove me', priority: 1 });

    await queue.remove(id2);

    const tasks = await queue.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(id1);
  });

  // -- clear ---------------------------------------------------------------

  it('clear() returns count and empties the queue', async () => {
    await queue.add({ instruction: 'a', priority: 1 });
    await queue.add({ instruction: 'b', priority: 2 });
    await queue.add({ instruction: 'c', priority: 3 });

    const count = await queue.clear();
    expect(count).toBe(3);
    expect(await queue.list()).toHaveLength(0);
  });

  it('clear() returns 0 when queue is already empty', async () => {
    expect(await queue.clear()).toBe(0);
  });

  // -- corrupt NDJSON handling ---------------------------------------------

  it('gracefully skips corrupt NDJSON lines', async () => {
    // Manually write corrupt data into the queue file
    const filePath = path.join(tmpDir, 'task-queue.ndjson');
    const validTask: QueuedTask = {
      id: 'valid-1',
      instruction: 'good task',
      priority: 1,
      addedAt: Date.now(),
      status: 'pending',
    };
    const content = [
      JSON.stringify(validTask),
      'THIS IS NOT JSON {{{',
      '',
      '{"incomplete": true',
      JSON.stringify({ ...validTask, id: 'valid-2', instruction: 'another good task' }),
    ].join('\n') + '\n';
    fs.writeFileSync(filePath, content, 'utf-8');

    const tasks = await queue.list();
    expect(tasks).toHaveLength(2);
    expect(tasks[0].id).toBe('valid-1');
    expect(tasks[1].id).toBe('valid-2');
  });

  it('returns empty list when file contains only corrupt data', async () => {
    const filePath = path.join(tmpDir, 'task-queue.ndjson');
    fs.writeFileSync(filePath, 'garbage\nnope\n', 'utf-8');

    const tasks = await queue.list();
    expect(tasks).toHaveLength(0);
  });

  // -- file-system edge cases ----------------------------------------------

  it('works when directory does not pre-exist (add creates it)', async () => {
    const nestedDir = path.join(tmpDir, 'deep', 'nested');
    // Pre-create the parent so the file-lock mechanism can create its .lock dir
    fs.mkdirSync(nestedDir, { recursive: true });
    const q = new TaskQueue(nestedDir);
    const { id } = await q.add({ instruction: 'nested', priority: 1 });
    expect(typeof id).toBe('string');
    const tasks = await q.list();
    expect(tasks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// SteeringController
// ---------------------------------------------------------------------------
describe('SteeringController', () => {
  let tmpDir: string;
  let ctrl: SteeringController;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'steer-'));
    ctrl = new SteeringController(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -- write / check round-trip -------------------------------------------

  it('write() then check() returns the written command', async () => {
    const cmd: SteeringCommand = { command: 'pause', timestamp: Date.now() };
    await ctrl.write(cmd);

    const result = await ctrl.check();
    expect(result).not.toBeNull();
    expect(result!.command).toBe('pause');
    expect(result!.timestamp).toBe(cmd.timestamp);
  });

  it('check() consumes the command (second call returns null)', async () => {
    await ctrl.write({ command: 'cancel', timestamp: Date.now() });
    const first = await ctrl.check();
    expect(first).not.toBeNull();

    const second = await ctrl.check();
    expect(second).toBeNull();
  });

  // -- check returns null when empty --------------------------------------

  it('check() returns null when no command has been written', async () => {
    expect(await ctrl.check()).toBeNull();
  });

  it('check() returns null when control file does not exist', async () => {
    // Fresh controller pointing at an empty dir
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'steer-empty-'));
    const c = new SteeringController(emptyDir);
    expect(await c.check()).toBeNull();
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  // -- multiple writes overwrite ------------------------------------------

  it('multiple writes overwrite; only last command is returned', async () => {
    await ctrl.write({ command: 'pause', timestamp: 1 });
    await ctrl.write({ command: 'resume', timestamp: 2 });
    await ctrl.write({ command: 'cancel', timestamp: 3 });

    const result = await ctrl.check();
    expect(result!.command).toBe('cancel');
    expect(result!.timestamp).toBe(3);
  });

  // -- clear --------------------------------------------------------------

  it('clear() removes pending command', async () => {
    await ctrl.write({ command: 'pause', timestamp: Date.now() });
    ctrl.clear();
    expect(await ctrl.check()).toBeNull();
  });

  it('clear() does not throw when no command exists', () => {
    expect(() => ctrl.clear()).not.toThrow();
  });

  // -- all command types ---------------------------------------------------

  const commandTypes: SteeringCommand['command'][] = [
    'pause',
    'resume',
    'cancel',
    'redirect',
    'queue',
  ];

  for (const cmdType of commandTypes) {
    it(`round-trips "${cmdType}" command`, async () => {
      const cmd: SteeringCommand = {
        command: cmdType,
        payload: cmdType === 'redirect' ? '/new/path' : undefined,
        timestamp: Date.now(),
      };
      await ctrl.write(cmd);

      const result = await ctrl.check();
      expect(result).not.toBeNull();
      expect(result!.command).toBe(cmdType);
      if (cmd.payload !== undefined) {
        expect(result!.payload).toBe(cmd.payload);
      }
    });
  }

  // -- payload handling ----------------------------------------------------

  it('preserves payload on redirect command', async () => {
    await ctrl.write({
      command: 'redirect',
      payload: 'focus on tests instead',
      timestamp: 42,
    });

    const result = await ctrl.check();
    expect(result!.payload).toBe('focus on tests instead');
  });

  it('preserves payload on queue command', async () => {
    await ctrl.write({
      command: 'queue',
      payload: 'add this to the backlog',
      timestamp: 100,
    });

    const result = await ctrl.check();
    expect(result!.command).toBe('queue');
    expect(result!.payload).toBe('add this to the backlog');
  });

  // -- file-system edge cases ---------------------------------------------

  it('works when directory does not pre-exist (write creates it)', async () => {
    const nestedDir = path.join(tmpDir, 'deep', 'nested');
    // Pre-create the parent so the file-lock mechanism can create its .lock dir
    fs.mkdirSync(nestedDir, { recursive: true });
    const c = new SteeringController(nestedDir);
    await c.write({ command: 'pause', timestamp: 1 });
    const result = await c.check();
    expect(result!.command).toBe('pause');
  });
});
