import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as childProcess from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

// --- Mock child_process so we never actually spawn processes ---
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(), execFileSync: vi.fn() };
});

const mockSpawn = vi.mocked(childProcess.spawn);
const mockExecFileSync = vi.mocked(childProcess.execFileSync);

/** Create a fake ChildProcess that behaves like a real one for our tests. */
function makeFakeProcess(pid = 12345): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  (proc as unknown as { pid: number }).pid = pid;
  (proc as unknown as { killed: boolean }).killed = false;
  (proc as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
  (proc as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
  // pipe() is called by BotManager — provide a no-op stub
  (proc.stdout as unknown as { pipe: (s: unknown) => void }).pipe = vi.fn();
  (proc.stderr as unknown as { pipe: (s: unknown) => void }).pipe = vi.fn();
  proc.kill = vi.fn((signal?: NodeJS.Signals | number) => {
    (proc as unknown as { killed: boolean }).killed = true;
    return true;
  }) as ChildProcess['kill'];
  return proc;
}

// Override BOTS_DIR to use a tmpdir so tests are isolated from ~/.weaver/bots
let tmpDir: string;
let botsDir: string;
let projectDir: string;

// We need to override the BOTS_DIR used by BotManager. Since it's a module-level
// constant, we override it via a workaround: set HOME to tmpDir before importing.
let BotManager: typeof import('../../src/bot/bot-manager.js').BotManager;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-manager-test-'));
  botsDir = path.join(tmpDir, '.weaver', 'bots');
  projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });

  // Point HOME at tmpDir so BOTS_DIR resolves to tmpDir/.weaver/bots
  process.env.HOME = tmpDir;

  // Re-import fresh module each test (reset module cache)
  vi.resetModules();
  const mod = await import('../../src/bot/bot-manager.js');
  BotManager = mod.BotManager;

  mockSpawn.mockReset();
  mockExecFileSync.mockReset();
});

afterEach(async () => {
  vi.resetModules();
  // Wait a tick so any pending createWriteStream open() calls can complete
  // before we delete tmpDir (prevents uncaught ENOENT on async fd open).
  await new Promise(r => setTimeout(r, 50));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Spawn metadata
// ---------------------------------------------------------------------------

describe('spawn metadata', () => {
  it('returns ManagedBot with correct fields', () => {
    const proc = makeFakeProcess(9001);
    mockSpawn.mockReturnValue(proc);

    const mgr = new BotManager();
    const meta = mgr.spawn('alpha', { projectDir });

    expect(meta.name).toBe('alpha');
    expect(meta.pid).toBe(9001);
    expect(meta.projectDir).toBe(projectDir);
    expect(meta.status).toBe('running');
    expect(meta.startedAt).toBeGreaterThan(0);
    expect(meta.botDir).toContain('alpha');
  });

  it('writes meta.json to botDir on spawn', () => {
    const proc = makeFakeProcess(9002);
    mockSpawn.mockReturnValue(proc);

    const mgr = new BotManager();
    const meta = mgr.spawn('bravo', { projectDir });

    const metaPath = path.join(meta.botDir, 'meta.json');
    expect(fs.existsSync(metaPath)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    expect(saved.name).toBe('bravo');
    expect(saved.pid).toBe(9002);
    expect(saved.status).toBe('running');
  });

  it('creates output.log file in botDir', async () => {
    const proc = makeFakeProcess(9003);
    mockSpawn.mockReturnValue(proc);

    const mgr = new BotManager();
    const meta = mgr.spawn('charlie', { projectDir });

    // createWriteStream opens the fd asynchronously; wait a tick for it to land
    await new Promise(r => setImmediate(r));
    expect(fs.existsSync(path.join(meta.botDir, 'output.log'))).toBe(true);
  });

  it('updates meta status to stopped when process exits', () => {
    const proc = makeFakeProcess(9004);
    mockSpawn.mockReturnValue(proc);

    const mgr = new BotManager();
    const meta = mgr.spawn('delta', { projectDir });

    // Simulate process exit
    proc.emit('exit', 0);

    const saved = JSON.parse(fs.readFileSync(path.join(meta.botDir, 'meta.json'), 'utf-8'));
    expect(saved.status).toBe('stopped');
  });

  it('throws when spawning a bot with a duplicate name', () => {
    const proc1 = makeFakeProcess(9005);
    const proc2 = makeFakeProcess(9006);
    mockSpawn.mockReturnValueOnce(proc1).mockReturnValueOnce(proc2);

    const mgr = new BotManager();
    mgr.spawn('echo', { projectDir });

    expect(() => mgr.spawn('echo', { projectDir })).toThrow(/already exists/);
  });

  it('calls git checkout when branch option is provided', () => {
    const proc = makeFakeProcess(9007);
    mockSpawn.mockReturnValue(proc);
    mockExecFileSync.mockReturnValue('' as unknown as Buffer);

    const mgr = new BotManager();
    mgr.spawn('foxtrot', { projectDir, branch: 'feature/test' });

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['checkout', '-B', 'feature/test'],
      expect.objectContaining({ cwd: projectDir }),
    );
  });

  it('does not throw if git checkout fails (branch may already exist)', () => {
    const proc = makeFakeProcess(9008);
    mockSpawn.mockReturnValue(proc);
    mockExecFileSync.mockImplementation(() => { throw new Error('already exists'); });

    const mgr = new BotManager();
    expect(() => mgr.spawn('golf', { projectDir, branch: 'existing-branch' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Per-bot queue isolation
// ---------------------------------------------------------------------------

describe('per-bot queue isolation', () => {
  it('getQueue returns a TaskQueue rooted at the bot botDir', async () => {
    const proc = makeFakeProcess(8001);
    mockSpawn.mockReturnValue(proc);

    const mgr = new BotManager();
    const meta = mgr.spawn('queue-bot-a', { projectDir });
    const queue = mgr.getQueue('queue-bot-a');

    // The queue dir should be the bot's own botDir, not a shared dir
    expect(meta.botDir).toContain('queue-bot-a');
    // Adding a task should land in the bot's own botDir
    await queue.add({ instruction: 'task-for-a', priority: 0 });

    const queueFile = path.join(meta.botDir, 'task-queue.ndjson');
    expect(fs.existsSync(queueFile)).toBe(true);
  });

  it('two bots have separate queues with no cross-contamination', async () => {
    const procA = makeFakeProcess(8002);
    const procB = makeFakeProcess(8003);
    mockSpawn.mockReturnValueOnce(procA).mockReturnValueOnce(procB);

    const mgr = new BotManager();
    mgr.spawn('queue-bot-b', { projectDir });
    mgr.spawn('queue-bot-c', { projectDir });

    const queueB = mgr.getQueue('queue-bot-b');
    const queueC = mgr.getQueue('queue-bot-c');

    await queueB.add({ instruction: 'only-for-b', priority: 0 });

    const tasksB = await queueB.list();
    const tasksC = await queueC.list();

    expect(tasksB).toHaveLength(1);
    expect(tasksC).toHaveLength(0);
  });

  it('getQueue throws for unknown bot', () => {
    const mgr = new BotManager();
    expect(() => mgr.getQueue('no-such-bot')).toThrow(/not found/);
  });

  it('spawned process inherits WEAVER_QUEUE_DIR set to botDir', () => {
    const proc = makeFakeProcess(8004);
    mockSpawn.mockReturnValue(proc);

    const mgr = new BotManager();
    const meta = mgr.spawn('queue-env-bot', { projectDir });

    const spawnCall = mockSpawn.mock.calls[0]!;
    const spawnEnv = (spawnCall[2] as { env: Record<string, string> }).env;
    expect(spawnEnv['WEAVER_QUEUE_DIR']).toBe(meta.botDir);
  });
});

// ---------------------------------------------------------------------------
// Per-bot steering isolation
// ---------------------------------------------------------------------------

describe('per-bot steering isolation', () => {
  it('getSteering returns a SteeringController rooted at the bot botDir', async () => {
    const proc = makeFakeProcess(7001);
    mockSpawn.mockReturnValue(proc);

    const mgr = new BotManager();
    const meta = mgr.spawn('steer-bot-a', { projectDir });
    const steering = mgr.getSteering('steer-bot-a');

    await steering.write({ command: 'pause', timestamp: Date.now() });

    const controlFile = path.join(meta.botDir, 'control.json');
    expect(fs.existsSync(controlFile)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(controlFile, 'utf-8'));
    expect(saved.command).toBe('pause');
  });

  it('steering commands for one bot do not affect another', async () => {
    const procA = makeFakeProcess(7002);
    const procB = makeFakeProcess(7003);
    mockSpawn.mockReturnValueOnce(procA).mockReturnValueOnce(procB);

    const mgr = new BotManager();
    const metaA = mgr.spawn('steer-bot-b', { projectDir });
    const metaB = mgr.spawn('steer-bot-c', { projectDir });

    await mgr.steer('steer-bot-b', 'pause');

    // Bot B's control file should exist
    expect(fs.existsSync(path.join(metaA.botDir, 'control.json'))).toBe(true);
    // Bot C's control file should NOT exist
    expect(fs.existsSync(path.join(metaB.botDir, 'control.json'))).toBe(false);
  });

  it('steer(pause) sets bot status to paused', async () => {
    const proc = makeFakeProcess(7004);
    mockSpawn.mockReturnValue(proc);

    const mgr = new BotManager();
    mgr.spawn('steer-pause-bot', { projectDir });

    await mgr.steer('steer-pause-bot', 'pause');

    expect(mgr.get('steer-pause-bot')?.status).toBe('paused');
  });

  it('steer(resume) sets bot status back to running', async () => {
    const proc = makeFakeProcess(7005);
    mockSpawn.mockReturnValue(proc);

    const mgr = new BotManager();
    mgr.spawn('steer-resume-bot', { projectDir });

    await mgr.steer('steer-resume-bot', 'pause');
    await mgr.steer('steer-resume-bot', 'resume');

    expect(mgr.get('steer-resume-bot')?.status).toBe('running');
  });

  it('getSteering throws for unknown bot', () => {
    const mgr = new BotManager();
    expect(() => mgr.getSteering('no-such-bot')).toThrow(/not found/);
  });

  it('spawned process inherits WEAVER_STEERING_DIR set to botDir', () => {
    const proc = makeFakeProcess(7006);
    mockSpawn.mockReturnValue(proc);

    const mgr = new BotManager();
    const meta = mgr.spawn('steer-env-bot', { projectDir });

    const spawnCall = mockSpawn.mock.calls[0]!;
    const spawnEnv = (spawnCall[2] as { env: Record<string, string> }).env;
    expect(spawnEnv['WEAVER_STEERING_DIR']).toBe(meta.botDir);
  });
});

// ---------------------------------------------------------------------------
// Log capture
// ---------------------------------------------------------------------------

describe('log capture', () => {
  it('logs() reads from output.log in botDir', () => {
    const proc = makeFakeProcess(6001);
    mockSpawn.mockReturnValue(proc);

    const mgr = new BotManager();
    const meta = mgr.spawn('log-bot-a', { projectDir });

    const logPath = path.join(meta.botDir, 'output.log');
    fs.writeFileSync(logPath, 'line1\nline2\nline3\n');

    const result = mgr.logs('log-bot-a', 10);
    expect(result).toContain('line1');
    expect(result).toContain('line3');
  });

  it('logs() returns only the last N lines', () => {
    const proc = makeFakeProcess(6002);
    mockSpawn.mockReturnValue(proc);

    const mgr = new BotManager();
    const meta = mgr.spawn('log-bot-b', { projectDir });

    const logPath = path.join(meta.botDir, 'output.log');
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`);
    fs.writeFileSync(logPath, lines.join('\n') + '\n');

    const result = mgr.logs('log-bot-b', 5);
    const returnedLines = result.split('\n').filter(Boolean);
    expect(returnedLines.length).toBeLessThanOrEqual(5);
    expect(result).toContain('line-20');
    expect(result).not.toContain('line-1\n');
  });

  it('logs() returns placeholder when no log file exists yet', () => {
    const proc = makeFakeProcess(6003);
    mockSpawn.mockReturnValue(proc);

    const mgr = new BotManager();
    const meta = mgr.spawn('log-bot-c', { projectDir });

    // Remove the log file that was created on spawn
    const logPath = path.join(meta.botDir, 'output.log');
    fs.rmSync(logPath, { force: true });

    expect(mgr.logs('log-bot-c')).toBe('(no logs yet)');
  });

  it('logs() throws for unknown bot', () => {
    const mgr = new BotManager();
    expect(() => mgr.logs('no-such-bot')).toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// Stop / Kill lifecycle
// ---------------------------------------------------------------------------

describe('stop/kill lifecycle', () => {
  it('stop() sends SIGTERM to the process', () => {
    const proc = makeFakeProcess(5001);
    mockSpawn.mockReturnValue(proc);

    const mgr = new BotManager();
    mgr.spawn('stop-bot', { projectDir });
    mgr.stop('stop-bot');

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('stop() sets bot status to stopped', () => {
    const proc = makeFakeProcess(5002);
    mockSpawn.mockReturnValue(proc);

    const mgr = new BotManager();
    mgr.spawn('stop-status-bot', { projectDir });
    mgr.stop('stop-status-bot');

    expect(mgr.get('stop-status-bot')?.status).toBe('stopped');
  });

  it('kill() sends SIGKILL to the process', () => {
    const proc = makeFakeProcess(5003);
    mockSpawn.mockReturnValue(proc);

    const mgr = new BotManager();
    mgr.spawn('kill-bot', { projectDir });
    mgr.kill('kill-bot');

    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('kill() sets bot status to stopped', () => {
    const proc = makeFakeProcess(5004);
    mockSpawn.mockReturnValue(proc);

    const mgr = new BotManager();
    mgr.spawn('kill-status-bot', { projectDir });
    mgr.kill('kill-status-bot');

    expect(mgr.get('kill-status-bot')?.status).toBe('stopped');
  });

  it('stop() does not kill if process is already dead', () => {
    const proc = makeFakeProcess(5005);
    (proc as unknown as { killed: boolean }).killed = true;
    mockSpawn.mockReturnValue(proc);

    const mgr = new BotManager();
    mgr.spawn('already-dead-bot', { projectDir });
    mgr.stop('already-dead-bot');

    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('stop() throws for unknown bot', () => {
    const mgr = new BotManager();
    expect(() => mgr.stop('no-such-bot')).toThrow(/not found/);
  });

  it('kill() throws for unknown bot', () => {
    const mgr = new BotManager();
    expect(() => mgr.kill('no-such-bot')).toThrow(/not found/);
  });

  it('cleanup() sends SIGTERM to all running bots', () => {
    const proc1 = makeFakeProcess(5006);
    const proc2 = makeFakeProcess(5007);
    mockSpawn.mockReturnValueOnce(proc1).mockReturnValueOnce(proc2);

    const mgr = new BotManager();
    mgr.spawn('cleanup-bot-1', { projectDir });
    mgr.spawn('cleanup-bot-2', { projectDir });

    mgr.cleanup();

    expect(proc1.kill).toHaveBeenCalledWith('SIGTERM');
    expect(proc2.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('cleanup() skips already-killed processes', () => {
    const proc = makeFakeProcess(5008);
    (proc as unknown as { killed: boolean }).killed = true;
    mockSpawn.mockReturnValue(proc);

    const mgr = new BotManager();
    mgr.spawn('cleanup-dead-bot', { projectDir });

    expect(() => mgr.cleanup()).not.toThrow();
    expect(proc.kill).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// List and discovery
// ---------------------------------------------------------------------------

describe('list and get', () => {
  it('list() returns all spawned bots', () => {
    const proc1 = makeFakeProcess(4001);
    const proc2 = makeFakeProcess(4002);
    mockSpawn.mockReturnValueOnce(proc1).mockReturnValueOnce(proc2);

    const mgr = new BotManager();
    mgr.spawn('list-bot-a', { projectDir });
    mgr.spawn('list-bot-b', { projectDir });

    const bots = mgr.list();
    const names = bots.map((b) => b.name);
    expect(names).toContain('list-bot-a');
    expect(names).toContain('list-bot-b');
  });

  it('get() returns null for unknown bot', () => {
    const mgr = new BotManager();
    expect(mgr.get('no-such-bot')).toBeNull();
  });

  it('get() returns the ManagedBot for a known bot', () => {
    const proc = makeFakeProcess(4003);
    mockSpawn.mockReturnValue(proc);

    const mgr = new BotManager();
    mgr.spawn('get-bot', { projectDir });

    const meta = mgr.get('get-bot');
    expect(meta).not.toBeNull();
    expect(meta?.name).toBe('get-bot');
  });

  it('list() discovers bots written to disk by a previous instance', () => {
    // Write a meta.json directly to botsDir as if a previous assistant had spawned it
    const ghostDir = path.join(botsDir, 'ghost-bot');
    fs.mkdirSync(ghostDir, { recursive: true });
    const ghostMeta = {
      name: 'ghost-bot',
      pid: 99999,
      projectDir,
      botDir: ghostDir,
      startedAt: Date.now(),
      status: 'running',
    };
    fs.writeFileSync(path.join(ghostDir, 'meta.json'), JSON.stringify(ghostMeta));

    const mgr = new BotManager();
    const bots = mgr.list();
    const names = bots.map((b) => b.name);
    expect(names).toContain('ghost-bot');
  });
});
