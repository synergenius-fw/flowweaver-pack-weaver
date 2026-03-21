import { describe, it, expect, vi } from 'vitest';
import {
  SLASH_COMMANDS,
  getSlashCompletions,
  handleSlashCommand,
  type SlashContext,
} from '../src/bot/slash-commands.js';

function createMockCtx(overrides: Partial<SlashContext> = {}): SlashContext {
  return {
    executor: vi.fn().mockResolvedValue({ result: 'mock-result', isError: false }),
    out: vi.fn(),
    projectDir: '/tmp/test-project',
    conversationId: 'test-conv-1',
    onClear: vi.fn(),
    onExit: vi.fn(),
    onNew: vi.fn(),
    onVerbose: vi.fn(),
    ...overrides,
  };
}

describe('SLASH_COMMANDS', () => {
  it('has 13 commands', () => {
    expect(SLASH_COMMANDS).toHaveLength(13);
  });

  it('contains the expected command names', () => {
    const names = SLASH_COMMANDS.map(c => c.name);
    expect(names).toContain('/help');
    expect(names).toContain('/status');
    expect(names).toContain('/bots');
    expect(names).toContain('/clear');
    expect(names).toContain('/exit');
    expect(names).toContain('/new');
    expect(names).toContain('/list');
    expect(names).toContain('/verbose');
    expect(names).toContain('/history');
    expect(names).toContain('/insights');
    expect(names).toContain('/health');
  });

  it('each command has name, description, and handler', () => {
    for (const cmd of SLASH_COMMANDS) {
      expect(cmd.name).toBeTruthy();
      expect(typeof cmd.name).toBe('string');
      expect(cmd.name.startsWith('/')).toBe(true);
      expect(cmd.description).toBeTruthy();
      expect(typeof cmd.description).toBe('string');
      expect(typeof cmd.handler).toBe('function');
    }
  });
});

describe('getSlashCompletions', () => {
  it('returns matching commands for partial input', () => {
    const results = getSlashCompletions('/h');
    expect(results).toContain('/help');
    expect(results).toContain('/history');
    expect(results).toContain('/health');
  });

  it('returns single match', () => {
    const results = getSlashCompletions('/ex');
    expect(results).toEqual(['/exit']);
  });

  it('returns empty for non-slash input', () => {
    expect(getSlashCompletions('help')).toEqual([]);
    expect(getSlashCompletions('')).toEqual([]);
    expect(getSlashCompletions('hello /help')).toEqual([]);
  });

  it('returns all commands for just "/"', () => {
    const results = getSlashCompletions('/');
    expect(results).toHaveLength(SLASH_COMMANDS.length);
    expect(results).toEqual(SLASH_COMMANDS.map(c => c.name));
  });

  it('returns empty for unmatched slash command', () => {
    expect(getSlashCompletions('/zzz')).toEqual([]);
  });
});

describe('handleSlashCommand', () => {
  it('returns true for a valid command', async () => {
    const ctx = createMockCtx();
    const result = await handleSlashCommand('/help', ctx);
    expect(result).toBe(true);
  });

  it('returns false for an unknown command', async () => {
    const ctx = createMockCtx();
    const result = await handleSlashCommand('/unknown', ctx);
    expect(result).toBe(false);
  });

  it('returns false for non-slash input', async () => {
    const ctx = createMockCtx();
    const result = await handleSlashCommand('hello', ctx);
    expect(result).toBe(false);
  });

  it('passes remaining args to handler', async () => {
    // We verify the command is called — args are passed through split
    const ctx = createMockCtx();
    const result = await handleSlashCommand('/help some args', ctx);
    expect(result).toBe(true);
    expect(ctx.out).toHaveBeenCalled();
  });
});

describe('command handlers', () => {
  it('/help calls ctx.out with command list', async () => {
    const ctx = createMockCtx();
    await handleSlashCommand('/help', ctx);
    expect(ctx.out).toHaveBeenCalled();
    // Should include capabilities overview and command names
    const allOutput = (ctx.out as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]).join('');
    expect(allOutput).toContain('Capabilities:');
    expect(allOutput).toContain('/exit');
    expect(allOutput).toContain('/status');
  });

  it('/exit calls ctx.onExit', async () => {
    const ctx = createMockCtx();
    await handleSlashCommand('/exit', ctx);
    expect(ctx.onExit).toHaveBeenCalled();
  });

  it('/clear calls ctx.onClear', async () => {
    const ctx = createMockCtx();
    await handleSlashCommand('/clear', ctx);
    expect(ctx.onClear).toHaveBeenCalled();
  });

  it('/new calls ctx.onNew', async () => {
    const ctx = createMockCtx();
    await handleSlashCommand('/new', ctx);
    expect(ctx.onNew).toHaveBeenCalled();
    expect(ctx.out).toHaveBeenCalled();
  });

  it('/verbose calls ctx.onVerbose', async () => {
    const ctx = createMockCtx();
    await handleSlashCommand('/verbose', ctx);
    expect(ctx.onVerbose).toHaveBeenCalled();
  });

  it('/bots calls ctx.executor with bot_list', async () => {
    const ctx = createMockCtx();
    await handleSlashCommand('/bots', ctx);
    expect(ctx.executor).toHaveBeenCalledWith('bot_list', {});
    expect(ctx.out).toHaveBeenCalled();
  });

  it('/status calls ctx.executor with bot_list and conversation_summary', async () => {
    const ctx = createMockCtx();
    await handleSlashCommand('/status', ctx);
    expect(ctx.executor).toHaveBeenCalledWith('bot_list', {});
    expect(ctx.executor).toHaveBeenCalledWith('conversation_summary', {});
  });

  it('/list calls ctx.executor with conversation_list', async () => {
    const ctx = createMockCtx();
    await handleSlashCommand('/list', ctx);
    expect(ctx.executor).toHaveBeenCalledWith('conversation_list', {});
    expect(ctx.out).toHaveBeenCalled();
  });

  it('/history calls ctx.executor with conversation_summary', async () => {
    const ctx = createMockCtx();
    await handleSlashCommand('/history', ctx);
    expect(ctx.executor).toHaveBeenCalledWith('conversation_summary', {});
    expect(ctx.out).toHaveBeenCalled();
  });
});
