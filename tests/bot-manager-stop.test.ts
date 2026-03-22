/**
 * Tests that BotManager.stop() and kill() work for discovered bots
 * (bots from a previous assistant session, where process handle is null).
 *
 * Bug: stop()/kill() only sent signals via bot.process, which is null for
 * discovered bots. The process keeps running even though status says 'stopped'.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';

// Redirect BOTS_DIR to a temp dir so BotManager doesn't touch the real home
let tmpHome: string;

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => tmpHome,
  };
});

describe('BotManager stop/kill for discovered bots', () => {
  let botsDir: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-bm-stop-'));
    botsDir = path.join(tmpHome, '.weaver', 'bots');
    fs.mkdirSync(botsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('stop() sends SIGTERM to a discovered bot via PID when process handle is null', async () => {
    // Start a real sleep process so we have a valid PID to signal
    const child = spawn('sleep', ['60'], { stdio: 'ignore', detached: true });
    const pid = child.pid!;
    child.unref();

    try {
      // Write meta.json as if this bot was spawned by a previous session
      const botDir = path.join(botsDir, 'old-worker');
      fs.mkdirSync(botDir, { recursive: true });
      fs.writeFileSync(
        path.join(botDir, 'meta.json'),
        JSON.stringify({
          name: 'old-worker',
          pid,
          projectDir: '/tmp',
          botDir,
          startedAt: Date.now() - 60_000,
          status: 'running',
        }),
      );

      // Import BotManager fresh (after os mock is set up)
      vi.resetModules();
      const { BotManager } = await import('../src/bot/bot-manager.js');
      const mgr = new BotManager();

      // list() triggers discovery of existing bots
      const bots = mgr.list();
      const found = bots.find(b => b.name === 'old-worker');
      expect(found).toBeDefined();
      expect(found!.status).toBe('running');

      // Stop the discovered bot — this should send SIGTERM via PID
      mgr.stop('old-worker');

      // Verify the process was killed
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      // Give a short window for signal delivery
      if (alive) {
        await new Promise(r => setTimeout(r, 100));
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    } finally {
      // Ensure cleanup even if test fails
      try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
    }
  });

  it('kill() sends SIGKILL to a discovered bot via PID when process handle is null', async () => {
    const child = spawn('sleep', ['60'], { stdio: 'ignore', detached: true });
    const pid = child.pid!;
    child.unref();

    try {
      const botDir = path.join(botsDir, 'zombie-bot');
      fs.mkdirSync(botDir, { recursive: true });
      fs.writeFileSync(
        path.join(botDir, 'meta.json'),
        JSON.stringify({
          name: 'zombie-bot',
          pid,
          projectDir: '/tmp',
          botDir,
          startedAt: Date.now() - 60_000,
          status: 'running',
        }),
      );

      vi.resetModules();
      const { BotManager } = await import('../src/bot/bot-manager.js');
      const mgr = new BotManager();
      mgr.list(); // discover

      mgr.kill('zombie-bot');

      // SIGKILL is immediate
      await new Promise(r => setTimeout(r, 50));
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
    }
  });

  it('stop() is a no-op for discovered bots with pid=0 (does not throw)', async () => {
    const botDir = path.join(botsDir, 'no-pid-bot');
    fs.mkdirSync(botDir, { recursive: true });
    fs.writeFileSync(
      path.join(botDir, 'meta.json'),
      JSON.stringify({
        name: 'no-pid-bot',
        pid: 0,
        projectDir: '/tmp',
        botDir,
        startedAt: Date.now() - 60_000,
        status: 'stopped',
      }),
    );

    vi.resetModules();
    const { BotManager } = await import('../src/bot/bot-manager.js');
    const mgr = new BotManager();
    mgr.list(); // discover

    // Should not throw even though pid is 0
    expect(() => mgr.stop('no-pid-bot')).not.toThrow();
  });
});
