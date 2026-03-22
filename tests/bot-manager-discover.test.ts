/**
 * Tests that BotManager discovers bots from previous sessions
 * when accessed directly via get(), stop(), logs() — without
 * needing to call list() first.
 *
 * Bug: Only list() calls discoverExistingBots(). Other methods
 * like get(), stop(), logs() fail with "Bot not found" for bots
 * spawned by a previous assistant session.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Redirect BOTS_DIR to a temp dir so BotManager doesn't touch the real home
let tmpHome: string;

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => tmpHome,
  };
});

describe('BotManager discovers bots without calling list() first', () => {
  let botsDir: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-bm-disc-'));
    botsDir = path.join(tmpHome, '.weaver', 'bots');
    fs.mkdirSync(botsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  /** Write a fake bot meta.json to disk. */
  function writeBotMeta(name: string, overrides: Record<string, unknown> = {}): string {
    const botDir = path.join(botsDir, name);
    fs.mkdirSync(botDir, { recursive: true });
    fs.writeFileSync(
      path.join(botDir, 'meta.json'),
      JSON.stringify({
        name,
        pid: 0,
        projectDir: '/tmp',
        botDir,
        startedAt: Date.now() - 60_000,
        status: 'stopped',
        ...overrides,
      }),
    );
    return botDir;
  }

  it('get() discovers a bot from disk without calling list() first', async () => {
    writeBotMeta('disk-bot');

    vi.resetModules();
    const { BotManager } = await import('../src/bot/bot-manager.js');
    const mgr = new BotManager();

    // Direct get() without list() should still find the bot
    const bot = mgr.get('disk-bot');
    expect(bot).not.toBeNull();
    expect(bot!.name).toBe('disk-bot');
  });

  it('logs() works for a discovered bot without calling list() first', async () => {
    const botDir = writeBotMeta('log-bot');
    fs.writeFileSync(path.join(botDir, 'output.log'), 'hello from log-bot\n');

    vi.resetModules();
    const { BotManager } = await import('../src/bot/bot-manager.js');
    const mgr = new BotManager();

    // logs() without prior list() should discover the bot and return logs
    const logs = mgr.logs('log-bot');
    expect(logs).toContain('hello from log-bot');
  });

  it('stop() works for a discovered bot without calling list() first', async () => {
    writeBotMeta('stop-bot');

    vi.resetModules();
    const { BotManager } = await import('../src/bot/bot-manager.js');
    const mgr = new BotManager();

    // stop() without prior list() should not throw "Bot not found"
    expect(() => mgr.stop('stop-bot')).not.toThrow();
  });
});
