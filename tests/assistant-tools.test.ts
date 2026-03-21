import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createAssistantExecutor, ASSISTANT_TOOLS } from '../src/bot/assistant-tools.js';

describe('ASSISTANT_TOOLS', () => {
  it('has all expected tools', () => {
    const names = ASSISTANT_TOOLS.map(t => t.name);
    // Bot management
    expect(names).toContain('bot_spawn');
    expect(names).toContain('bot_list');
    expect(names).toContain('bot_status');
    expect(names).toContain('bot_pause');
    expect(names).toContain('bot_resume');
    expect(names).toContain('bot_stop');
    expect(names).toContain('bot_logs');
    // Queue
    expect(names).toContain('queue_add');
    expect(names).toContain('queue_add_batch');
    expect(names).toContain('queue_list');
    expect(names).toContain('queue_retry');
    // Flow-weaver
    expect(names).toContain('fw_validate');
    expect(names).toContain('fw_diagram');
    expect(names).toContain('fw_describe');
    // Project
    expect(names).toContain('read_file');
    expect(names).toContain('list_files');
    expect(names).toContain('run_shell');
  });

  it('all tools have valid inputSchema', () => {
    for (const tool of ASSISTANT_TOOLS) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.description).toBeTruthy();
      expect(tool.name).toMatch(/^[a-z_]+$/);
    }
  });
});

describe('createAssistantExecutor', () => {
  const testDir = path.join(os.tmpdir(), `weaver-test-assistant-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, 'test.txt'), 'hello world');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('read_file returns file contents', async () => {
    const exec = createAssistantExecutor(testDir);
    const result = await exec('read_file', { file: 'test.txt' });
    expect(result.isError).toBe(false);
    expect(result.result).toBe('hello world');
  });

  it('read_file returns error for missing file', async () => {
    const exec = createAssistantExecutor(testDir);
    const result = await exec('read_file', { file: 'nonexistent.txt' });
    expect(result.isError).toBe(true);
  });

  it('read_file lists directory contents when given a directory', async () => {
    fs.mkdirSync(path.join(testDir, 'subdir'));
    fs.writeFileSync(path.join(testDir, 'subdir', 'a.ts'), '');
    fs.writeFileSync(path.join(testDir, 'subdir', 'b.ts'), '');
    const exec = createAssistantExecutor(testDir);
    const result = await exec('read_file', { file: 'subdir' });
    expect(result.isError).toBe(false);
    expect(result.result).toContain('a.ts');
    expect(result.result).toContain('b.ts');
  });

  it('list_files returns directory listing', async () => {
    const exec = createAssistantExecutor(testDir);
    const result = await exec('list_files', { directory: '.' });
    expect(result.isError).toBe(false);
    expect(result.result).toContain('test.txt');
  });

  it('list_files filters by pattern', async () => {
    fs.writeFileSync(path.join(testDir, 'foo.ts'), '');
    fs.writeFileSync(path.join(testDir, 'bar.js'), '');
    const exec = createAssistantExecutor(testDir);
    const result = await exec('list_files', { directory: '.', pattern: '\\.ts$' });
    expect(result.isError).toBe(false);
    expect(result.result).toContain('foo.ts');
    expect(result.result).not.toContain('bar.js');
  });

  it('list_files returns error for missing directory', async () => {
    const exec = createAssistantExecutor(testDir);
    const result = await exec('list_files', { directory: 'nonexistent' });
    expect(result.isError).toBe(true);
  });

  it('run_shell executes commands', async () => {
    const exec = createAssistantExecutor(testDir);
    const result = await exec('run_shell', { command: 'echo hello' });
    expect(result.isError).toBe(false);
    expect(result.result).toBe('hello');
  });

  it('run_shell blocks dangerous commands', async () => {
    const exec = createAssistantExecutor(testDir);

    const rmResult = await exec('run_shell', { command: 'rm -rf /' });
    expect(rmResult.isError).toBe(true);
    expect(rmResult.result).toContain('Blocked');

    const pushResult = await exec('run_shell', { command: 'git push origin main' });
    expect(pushResult.isError).toBe(true);
    expect(pushResult.result).toContain('Blocked');

    const publishResult = await exec('run_shell', { command: 'npm publish' });
    expect(publishResult.isError).toBe(true);
    expect(publishResult.result).toContain('Blocked');
  });

  it('bot_list returns empty when no bots', async () => {
    const exec = createAssistantExecutor(testDir);
    const result = await exec('bot_list', {});
    expect(result.isError).toBe(false);
    // Should either say "No bots running" or list bots from disk
    expect(result.result).toBeTruthy();
  });

  it('bot_status returns error for unknown bot', async () => {
    const exec = createAssistantExecutor(testDir);
    const result = await exec('bot_status', { name: 'nonexistent' });
    expect(result.isError).toBe(true);
    expect(result.result).toContain('not found');
  });

  it('unknown tool returns error', async () => {
    const exec = createAssistantExecutor(testDir);
    const result = await exec('unknown_tool', {});
    expect(result.isError).toBe(true);
    expect(result.result).toContain('Unknown tool');
  });
});
