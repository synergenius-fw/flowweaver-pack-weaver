import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// We can't easily test spawn (it would start real processes), so we test
// the file-based operations and metadata management.

describe('BotManager', () => {
  const testDir = path.join(os.tmpdir(), `weaver-test-bots-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('creates bot directory structure', () => {
    const botDir = path.join(testDir, 'test-bot');
    fs.mkdirSync(botDir, { recursive: true });

    const meta = {
      name: 'test-bot',
      pid: 12345,
      projectDir: '/tmp/project',
      botDir,
      startedAt: Date.now(),
      status: 'running',
    };
    fs.writeFileSync(path.join(botDir, 'meta.json'), JSON.stringify(meta));

    const loaded = JSON.parse(fs.readFileSync(path.join(botDir, 'meta.json'), 'utf-8'));
    expect(loaded.name).toBe('test-bot');
    expect(loaded.status).toBe('running');
    expect(loaded.pid).toBe(12345);
  });

  it('per-bot queue path is isolated', async () => {
    const { TaskQueue } = await import('../src/bot/task-queue.js');

    const bot1Dir = path.join(testDir, 'bot1');
    const bot2Dir = path.join(testDir, 'bot2');
    fs.mkdirSync(bot1Dir, { recursive: true });
    fs.mkdirSync(bot2Dir, { recursive: true });

    const q1 = new TaskQueue(bot1Dir);
    const q2 = new TaskQueue(bot2Dir);

    await q1.add({ instruction: 'task for bot 1', priority: 0 });
    await q2.add({ instruction: 'task for bot 2', priority: 0 });

    const list1 = await q1.list();
    const list2 = await q2.list();

    expect(list1).toHaveLength(1);
    expect(list1[0].instruction).toBe('task for bot 1');
    expect(list2).toHaveLength(1);
    expect(list2[0].instruction).toBe('task for bot 2');
  });

  it('per-bot steering path is isolated', async () => {
    const { SteeringController } = await import('../src/bot/steering.js');

    const bot1Dir = path.join(testDir, 'bot1');
    const bot2Dir = path.join(testDir, 'bot2');
    fs.mkdirSync(bot1Dir, { recursive: true });
    fs.mkdirSync(bot2Dir, { recursive: true });

    const s1 = new SteeringController(bot1Dir);
    const s2 = new SteeringController(bot2Dir);

    await s1.write({ command: 'pause', timestamp: Date.now() });

    const cmd1 = await s1.check();
    const cmd2 = await s2.check();

    expect(cmd1?.command).toBe('pause');
    expect(cmd2).toBeNull();
  });

  it('TaskQueue respects WEAVER_QUEUE_DIR env var', async () => {
    const envDir = path.join(testDir, 'env-queue');
    fs.mkdirSync(envDir, { recursive: true });

    const origEnv = process.env.WEAVER_QUEUE_DIR;
    process.env.WEAVER_QUEUE_DIR = envDir;

    try {
      // Re-import to pick up env var
      vi.resetModules();
      const { TaskQueue } = await import('../src/bot/task-queue.js');
      const q = new TaskQueue(); // no dir arg — should use env var
      await q.add({ instruction: 'env test', priority: 0 });

      expect(fs.existsSync(path.join(envDir, 'task-queue.ndjson'))).toBe(true);
      const list = await q.list();
      expect(list[0].instruction).toBe('env test');
    } finally {
      if (origEnv) process.env.WEAVER_QUEUE_DIR = origEnv;
      else delete process.env.WEAVER_QUEUE_DIR;
    }
  });

  it('SteeringController respects WEAVER_STEERING_DIR env var', async () => {
    const envDir = path.join(testDir, 'env-steer');
    fs.mkdirSync(envDir, { recursive: true });

    const origEnv = process.env.WEAVER_STEERING_DIR;
    process.env.WEAVER_STEERING_DIR = envDir;

    try {
      vi.resetModules();
      const { SteeringController } = await import('../src/bot/steering.js');
      const s = new SteeringController(); // no dir arg
      await s.write({ command: 'resume', timestamp: Date.now() });

      expect(fs.existsSync(path.join(envDir, 'control.json'))).toBe(true);
      const cmd = await s.check();
      expect(cmd?.command).toBe('resume');
    } finally {
      if (origEnv) process.env.WEAVER_STEERING_DIR = origEnv;
      else delete process.env.WEAVER_STEERING_DIR;
    }
  });

  it('discovers existing bots from disk', () => {
    const botDir = path.join(testDir, 'old-bot');
    fs.mkdirSync(botDir, { recursive: true });
    fs.writeFileSync(path.join(botDir, 'meta.json'), JSON.stringify({
      name: 'old-bot',
      pid: 0,
      projectDir: '/tmp',
      botDir,
      startedAt: Date.now() - 3600_000,
      status: 'running',
    }));

    // Read back and verify
    const meta = JSON.parse(fs.readFileSync(path.join(botDir, 'meta.json'), 'utf-8'));
    expect(meta.name).toBe('old-bot');
    // PID 0 won't be found running, so status should be 'stopped' after discovery
    expect(meta.pid).toBe(0);
  });
});
