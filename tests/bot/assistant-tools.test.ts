import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as childProcess from 'node:child_process';
import type { BotManager } from '../../src/bot/bot-manager.js';
import type { ConversationStore } from '../../src/bot/conversation-store.js';

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../src/bot/bot-manager.js', () => ({ BotManager: vi.fn() }));
vi.mock('../../src/bot/conversation-store.js', () => ({ ConversationStore: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn() };
});

// ── Imports (after mocks) ──────────────────────────────────────────────────

import { BotManager as BotManagerCtor } from '../../src/bot/bot-manager.js';
import { ConversationStore as ConversationStoreCtor } from '../../src/bot/conversation-store.js';
import { createAssistantExecutor } from '../../src/bot/assistant-tools.js';

const MockBotManager = vi.mocked(BotManagerCtor);
const MockConversationStore = vi.mocked(ConversationStoreCtor);
const mockExecFileSync = vi.mocked(childProcess.execFileSync);

// ── Shared mock objects (const — same reference throughout all tests) ──────

const mockQueue = {
  add: vi.fn<[], Promise<{ id: string; duplicate: boolean }>>(),
  list: vi.fn<[], Promise<unknown[]>>(),
  retryAll: vi.fn<[], Promise<number>>(),
};

const mockMgr = {
  spawn: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  getQueue: vi.fn(),
  steer: vi.fn(),
  stop: vi.fn(),
  logs: vi.fn(),
};

const mockStore = {
  list: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
  getMostRecent: vi.fn(),
};

// ── Setup ──────────────────────────────────────────────────────────────────

let tmpDir: string;
let projectDir: string;
let executor: ReturnType<typeof createAssistantExecutor>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-tools-test-'));
  projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });

  // Reset all mocks (clears call history AND implementations)
  vi.resetAllMocks();

  // Default queue behaviour
  mockQueue.add.mockResolvedValue({ id: 'task-abc', duplicate: false });
  mockQueue.list.mockResolvedValue([]);
  mockQueue.retryAll.mockResolvedValue(0);

  // Default manager behaviour
  mockMgr.list.mockReturnValue([]);
  mockMgr.get.mockReturnValue(null);
  mockMgr.getQueue.mockReturnValue(mockQueue);
  mockMgr.steer.mockResolvedValue(undefined);
  mockMgr.logs.mockReturnValue('');
  mockMgr.spawn.mockImplementation((name: string, opts: { projectDir: string }) => ({
    name,
    pid: 99,
    projectDir: opts.projectDir,
    botDir: `/tmp/bots/${name}`,
    startedAt: Date.now(),
    status: 'running',
  }));

  // Default store behaviour
  mockStore.list.mockReturnValue([]);
  mockStore.get.mockReturnValue(null);
  mockStore.getMostRecent.mockReturnValue(null);

  // Wire constructors → shared objects (regular functions, not arrow — Vitest v4 requirement)
  MockBotManager.mockImplementation(function () { return mockMgr; } as unknown as new () => InstanceType<typeof BotManager>);
  MockConversationStore.mockImplementation(function () { return mockStore; } as unknown as new () => InstanceType<typeof ConversationStore>);

  executor = createAssistantExecutor(projectDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── bot_spawn ──────────────────────────────────────────────────────────────

describe('bot_spawn', () => {
  it('spawns a bot and returns readable status message', async () => {
    const result = await executor('bot_spawn', { name: 'my-bot', project_dir: projectDir });

    expect(result.isError).toBe(false);
    expect(result.result).toContain('my-bot');
    expect(result.result).toContain('started');
    expect(mockMgr.spawn).toHaveBeenCalledWith('my-bot', expect.objectContaining({ projectDir }));
  });

  it('returns isError when bot name already exists', async () => {
    mockMgr.spawn.mockImplementation(() => {
      throw new Error('Bot "dup" already exists. Stop it first or use a different name.');
    });

    const result = await executor('bot_spawn', { name: 'dup' });

    expect(result.isError).toBe(true);
    expect(result.result).toContain('already exists');
  });

  it('uses project_dir arg when provided', async () => {
    const customDir = path.join(tmpDir, 'custom');
    await executor('bot_spawn', { name: 'x', project_dir: customDir });

    expect(mockMgr.spawn).toHaveBeenCalledWith('x', expect.objectContaining({ projectDir: customDir }));
  });
});

// ── bot_list ───────────────────────────────────────────────────────────────

describe('bot_list', () => {
  it('returns "No bots running" when no bots exist', async () => {
    mockMgr.list.mockReturnValue([]);

    const result = await executor('bot_list', {});

    expect(result.isError).toBe(false);
    expect(result.result).toBe('No bots running.');
  });

  it('lists bots with name, status and pid', async () => {
    mockMgr.list.mockReturnValue([
      { name: 'alpha', pid: 1234, status: 'running', startedAt: Date.now() - 5000 },
      { name: 'beta', pid: 5678, status: 'paused', startedAt: Date.now() - 10000 },
    ]);

    const result = await executor('bot_list', {});

    expect(result.isError).toBe(false);
    expect(result.result).toContain('alpha');
    expect(result.result).toContain('running');
    expect(result.result).toContain('beta');
    expect(result.result).toContain('paused');
  });
});

// ── bot_status ─────────────────────────────────────────────────────────────

describe('bot_status', () => {
  it('returns isError when bot is not found', async () => {
    mockMgr.get.mockReturnValue(null);

    const result = await executor('bot_status', { name: 'ghost' });

    expect(result.isError).toBe(true);
    expect(result.result).toContain('"ghost" not found');
  });

  it('returns task counts in the status output', async () => {
    mockMgr.get.mockReturnValue({ name: 'worker', status: 'running', pid: 42, startedAt: Date.now() });
    mockQueue.list.mockResolvedValue([
      { id: '1', status: 'completed', instruction: 'Task A' },
      { id: '2', status: 'failed', instruction: 'Task B that failed with an error' },
      { id: '3', status: 'pending', instruction: 'Task C' },
    ]);

    const result = await executor('bot_status', { name: 'worker' });

    expect(result.isError).toBe(false);
    expect(result.result).toContain('1 completed');
    expect(result.result).toContain('1 failed');
    expect(result.result).toContain('1 pending');
  });

  it('lists failed task instructions in the status output', async () => {
    mockMgr.get.mockReturnValue({ name: 'worker', status: 'running', pid: 42, startedAt: Date.now() });
    mockQueue.list.mockResolvedValue([
      { id: '1', status: 'failed', instruction: 'Fix the broken pipeline' },
    ]);

    const result = await executor('bot_status', { name: 'worker' });

    expect(result.result).toContain('Fix the broken pipeline');
  });
});

// ── bot_pause / bot_resume / bot_stop ──────────────────────────────────────

describe('bot_pause', () => {
  it('calls steer(pause) and returns confirmation', async () => {
    const result = await executor('bot_pause', { name: 'my-bot' });

    expect(result.isError).toBe(false);
    expect(mockMgr.steer).toHaveBeenCalledWith('my-bot', 'pause');
    expect(result.result).toContain('Paused');
  });
});

describe('bot_resume', () => {
  it('calls steer(resume) and returns confirmation', async () => {
    const result = await executor('bot_resume', { name: 'my-bot' });

    expect(result.isError).toBe(false);
    expect(mockMgr.steer).toHaveBeenCalledWith('my-bot', 'resume');
    expect(result.result).toContain('Resumed');
  });
});

describe('bot_stop', () => {
  it('calls stop and returns confirmation', async () => {
    const result = await executor('bot_stop', { name: 'my-bot' });

    expect(result.isError).toBe(false);
    expect(mockMgr.stop).toHaveBeenCalledWith('my-bot');
    expect(result.result).toContain('Stopping');
  });
});

// ── bot_logs ───────────────────────────────────────────────────────────────

describe('bot_logs', () => {
  it('returns log output from the bot', async () => {
    mockMgr.logs.mockReturnValue('line1\nline2\n');

    const result = await executor('bot_logs', { name: 'my-bot', lines: 20 });

    expect(result.isError).toBe(false);
    expect(result.result).toContain('line1');
    expect(mockMgr.logs).toHaveBeenCalledWith('my-bot', 20);
  });

  it('returns placeholder when no output yet', async () => {
    mockMgr.logs.mockReturnValue('');

    const result = await executor('bot_logs', { name: 'my-bot' });

    expect(result.result).toBe('(no output yet)');
  });
});

// ── queue_add ──────────────────────────────────────────────────────────────

describe('queue_add', () => {
  it('adds a task and includes the task id in the result', async () => {
    mockQueue.add.mockResolvedValue({ id: 'abc123', duplicate: false });

    const result = await executor('queue_add', { bot: 'my-bot', instruction: 'Fix the bug' });

    expect(result.isError).toBe(false);
    expect(result.result).toContain('abc123');
    expect(mockQueue.add).toHaveBeenCalledWith(
      expect.objectContaining({ instruction: 'Fix the bug' }),
    );
  });

  it('passes optional targets to the queue', async () => {
    await executor('queue_add', { bot: 'my-bot', instruction: 'Check files', targets: ['a.ts', 'b.ts'] });

    expect(mockQueue.add).toHaveBeenCalledWith(
      expect.objectContaining({ targets: ['a.ts', 'b.ts'] }),
    );
  });
});

// ── queue_add_batch ────────────────────────────────────────────────────────

describe('queue_add_batch', () => {
  it('adds multiple tasks and reports the count', async () => {
    mockQueue.add.mockResolvedValueOnce({ id: 'id1', duplicate: false }).mockResolvedValueOnce({ id: 'id2', duplicate: false });

    const result = await executor('queue_add_batch', {
      bot: 'my-bot',
      tasks: [{ instruction: 'Task 1' }, { instruction: 'Task 2' }],
    });

    expect(result.isError).toBe(false);
    expect(result.result).toContain('2 tasks');
    expect(mockQueue.add).toHaveBeenCalledTimes(2);
  });
});

// ── queue_list ─────────────────────────────────────────────────────────────

describe('queue_list', () => {
  it('returns "Queue is empty" when there are no tasks', async () => {
    mockQueue.list.mockResolvedValue([]);

    const result = await executor('queue_list', { bot: 'my-bot' });

    expect(result.isError).toBe(false);
    expect(result.result).toBe('Queue is empty.');
  });

  it('lists tasks with their status prefix', async () => {
    mockQueue.list.mockResolvedValue([
      { id: '1', status: 'pending', instruction: 'Do something' },
      { id: '2', status: 'completed', instruction: 'Done task' },
    ]);

    const result = await executor('queue_list', { bot: 'my-bot' });

    expect(result.result).toContain('[pending]');
    expect(result.result).toContain('Do something');
    expect(result.result).toContain('[completed]');
    expect(result.result).toContain('Done task');
  });
});

// ── queue_retry ────────────────────────────────────────────────────────────

describe('queue_retry', () => {
  it('resets failed tasks and returns the count', async () => {
    mockQueue.retryAll.mockResolvedValue(3);

    const result = await executor('queue_retry', { bot: 'my-bot' });

    expect(result.isError).toBe(false);
    expect(result.result).toContain('3');
    expect(result.result).toContain('pending');
  });

  it('reports zero when no failed tasks exist', async () => {
    mockQueue.retryAll.mockResolvedValue(0);

    const result = await executor('queue_retry', { bot: 'my-bot' });

    expect(result.result).toContain('0');
  });
});

// ── fw_validate ────────────────────────────────────────────────────────────

describe('fw_validate', () => {
  it('runs flow-weaver validate and returns output', async () => {
    mockExecFileSync.mockReturnValue('No errors found.' as unknown as Buffer);

    const result = await executor('fw_validate', { path: 'my-workflow.ts' });

    expect(result.isError).toBe(false);
    expect(result.result).toBe('No errors found.');
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'npx',
      ['flow-weaver', 'validate', 'my-workflow.ts'],
      expect.any(Object),
    );
  });

  it('returns "Validation complete." when output is empty', async () => {
    mockExecFileSync.mockReturnValue('' as unknown as Buffer);

    const result = await executor('fw_validate', { path: 'ok.ts' });

    expect(result.result).toBe('Validation complete.');
  });

  it('returns isError when validation command throws', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('UNKNOWN_NODE_TYPE at line 5'); });

    const result = await executor('fw_validate', { path: 'bad.ts' });

    expect(result.isError).toBe(true);
    expect(result.result).toContain('UNKNOWN_NODE_TYPE');
  });
});

// ── read_file ──────────────────────────────────────────────────────────────

describe('read_file', () => {
  it('returns file contents for a normal file', async () => {
    const filePath = path.join(projectDir, 'test.txt');
    fs.writeFileSync(filePath, 'hello world');

    const result = await executor('read_file', { file: filePath });

    expect(result.isError).toBe(false);
    expect(result.result).toBe('hello world');
  });

  it('returns a directory listing when path is a directory', async () => {
    fs.writeFileSync(path.join(projectDir, 'a.ts'), '');
    fs.writeFileSync(path.join(projectDir, 'b.ts'), '');

    const result = await executor('read_file', { file: projectDir });

    expect(result.isError).toBe(false);
    expect(result.result).toContain('Directory listing');
    expect(result.result).toContain('a.ts');
    expect(result.result).toContain('b.ts');
  });

  it('returns isError for files larger than 1 MB', async () => {
    const filePath = path.join(projectDir, 'big.bin');
    fs.writeFileSync(filePath, Buffer.alloc(1_100_000));

    const result = await executor('read_file', { file: filePath });

    expect(result.isError).toBe(true);
    expect(result.result).toContain('too large');
  });

  it('resolves relative paths against projectDir', async () => {
    fs.writeFileSync(path.join(projectDir, 'relative.txt'), 'relative content');

    const result = await executor('read_file', { file: 'relative.txt' });

    expect(result.isError).toBe(false);
    expect(result.result).toBe('relative content');
  });
});

// ── list_files ─────────────────────────────────────────────────────────────

describe('list_files', () => {
  it('lists files in a directory', async () => {
    fs.writeFileSync(path.join(projectDir, 'alpha.ts'), '');
    fs.writeFileSync(path.join(projectDir, 'beta.ts'), '');

    const result = await executor('list_files', { directory: projectDir });

    expect(result.isError).toBe(false);
    expect(result.result).toContain('alpha.ts');
    expect(result.result).toContain('beta.ts');
  });

  it('filters files by regex pattern', async () => {
    fs.writeFileSync(path.join(projectDir, 'foo.ts'), '');
    fs.writeFileSync(path.join(projectDir, 'foo.test.ts'), '');
    fs.writeFileSync(path.join(projectDir, 'bar.ts'), '');

    const result = await executor('list_files', { directory: projectDir, pattern: '\\.test\\.ts$' });

    expect(result.result).toContain('foo.test.ts');
    expect(result.result).not.toContain('bar.ts');
  });

  it('returns isError for a non-existent directory', async () => {
    const result = await executor('list_files', { directory: '/no/such/dir/ever' });

    expect(result.isError).toBe(true);
    expect(result.result).toContain('Directory not found');
  });

  it('returns "(empty)" for an empty directory', async () => {
    const emptyDir = path.join(projectDir, 'empty');
    fs.mkdirSync(emptyDir);

    const result = await executor('list_files', { directory: emptyDir });

    expect(result.result).toBe('(empty)');
  });
});

// ── run_shell ──────────────────────────────────────────────────────────────

describe('run_shell', () => {
  it('executes a command and returns trimmed output', async () => {
    mockExecFileSync.mockReturnValue('hello\n' as unknown as Buffer);

    const result = await executor('run_shell', { command: 'echo hello' });

    expect(result.isError).toBe(false);
    expect(result.result).toBe('hello');
    expect(mockExecFileSync).toHaveBeenCalledWith('sh', ['-c', 'echo hello'], expect.any(Object));
  });

  it('returns "(no output)" for commands with empty output', async () => {
    mockExecFileSync.mockReturnValue('' as unknown as Buffer);

    const result = await executor('run_shell', { command: 'true' });

    expect(result.result).toBe('(no output)');
  });

  it('blocks rm -rf without calling execFileSync', async () => {
    const result = await executor('run_shell', { command: 'rm -rf /important' });

    expect(result.isError).toBe(true);
    expect(result.result).toContain('Blocked');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('blocks git push', async () => {
    const result = await executor('run_shell', { command: 'git push origin main' });

    expect(result.isError).toBe(true);
    expect(result.result).toContain('Blocked');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('blocks npm publish', async () => {
    const result = await executor('run_shell', { command: 'npm publish --access public' });

    expect(result.isError).toBe(true);
    expect(result.result).toContain('Blocked');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('blocks sudo', async () => {
    const result = await executor('run_shell', { command: 'sudo apt-get install vim' });

    expect(result.isError).toBe(true);
    expect(result.result).toContain('Blocked');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('returns isError when the shell command throws', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('command not found: nonexistent'); });

    const result = await executor('run_shell', { command: 'nonexistent' });

    expect(result.isError).toBe(true);
    expect(result.result).toContain('command not found');
  });
});

// ── conversation_list ──────────────────────────────────────────────────────

describe('conversation_list', () => {
  it('returns "No saved conversations" when list is empty', async () => {
    mockStore.list.mockReturnValue([]);

    const result = await executor('conversation_list', {});

    expect(result.isError).toBe(false);
    expect(result.result).toBe('No saved conversations.');
  });

  it('lists conversations with id, title, and message count', async () => {
    mockStore.list.mockReturnValue([
      {
        id: 'abc-123',
        title: 'My session',
        messageCount: 5,
        lastMessageAt: Date.now() - 60_000,
        totalTokens: 1000,
        botIds: [],
        createdAt: Date.now() - 120_000,
      },
    ]);

    const result = await executor('conversation_list', {});

    expect(result.isError).toBe(false);
    expect(result.result).toContain('abc-123');
    expect(result.result).toContain('My session');
    expect(result.result).toContain('5 msgs');
  });

  it('shows (untitled) for conversations without a title', async () => {
    mockStore.list.mockReturnValue([
      {
        id: 'xyz-456',
        title: '',
        messageCount: 2,
        lastMessageAt: Date.now() - 3600_000,
        totalTokens: 200,
        botIds: [],
        createdAt: Date.now() - 7200_000,
      },
    ]);

    const result = await executor('conversation_list', {});

    expect(result.result).toContain('(untitled)');
  });
});

// ── conversation_delete ────────────────────────────────────────────────────

describe('conversation_delete', () => {
  it('returns isError when conversation is not found', async () => {
    mockStore.get.mockReturnValue(null);

    const result = await executor('conversation_delete', { id: 'bad-id' });

    expect(result.isError).toBe(true);
    expect(result.result).toContain('"bad-id" not found');
  });

  it('deletes conversation and returns confirmation with id', async () => {
    mockStore.get.mockReturnValue({ id: 'abc-123', title: 'Test conv', messageCount: 3 });

    const result = await executor('conversation_delete', { id: 'abc-123' });

    expect(result.isError).toBe(false);
    expect(mockStore.delete).toHaveBeenCalledWith('abc-123');
    expect(result.result).toContain('abc-123');
  });

  it('includes the conversation title in the confirmation', async () => {
    mockStore.get.mockReturnValue({ id: 'abc-123', title: 'My important session', messageCount: 10 });

    const result = await executor('conversation_delete', { id: 'abc-123' });

    expect(result.result).toContain('My important session');
  });
});

// ── conversation_summary ───────────────────────────────────────────────────

describe('conversation_summary', () => {
  it('returns "No active conversation" when no recent conversation exists', async () => {
    mockStore.getMostRecent.mockReturnValue(null);

    const result = await executor('conversation_summary', {});

    expect(result.isError).toBe(false);
    expect(result.result).toBe('No active conversation.');
  });

  it('returns summary with id, message count, and token count', async () => {
    mockStore.getMostRecent.mockReturnValue({
      id: 'abc-123',
      title: 'Test session',
      messageCount: 10,
      totalTokens: 5000,
      botIds: ['bot-1', 'bot-2'],
      createdAt: Date.now() - 1_800_000,
      lastMessageAt: Date.now(),
    });

    const result = await executor('conversation_summary', {});

    expect(result.isError).toBe(false);
    expect(result.result).toContain('abc-123');
    expect(result.result).toContain('10');
    expect(result.result).toContain('5000');
    expect(result.result).toContain('bot-1');
    expect(result.result).toContain('bot-2');
  });

  it('shows "none" when no bots were spawned in the conversation', async () => {
    mockStore.getMostRecent.mockReturnValue({
      id: 'abc-123',
      title: '',
      messageCount: 1,
      totalTokens: 100,
      botIds: [],
      createdAt: Date.now() - 60_000,
      lastMessageAt: Date.now(),
    });

    const result = await executor('conversation_summary', {});

    expect(result.result).toContain('none');
  });
});

// ── unknown tool ───────────────────────────────────────────────────────────

describe('unknown tool', () => {
  it('returns isError with "Unknown tool" message', async () => {
    const result = await executor('non_existent_tool_xyz', {});

    expect(result.isError).toBe(true);
    expect(result.result).toContain('Unknown tool');
  });
});
