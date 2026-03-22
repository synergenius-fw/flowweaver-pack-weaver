/**
 * Tests for write_file and patch_file assistant tool executors.
 * 100% coverage on all paths: success, safety guards, edge cases.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createAssistantExecutor } from '../src/bot/assistant-tools.js';

describe('write_file tool', () => {
  let tmpDir: string;
  let executor: ReturnType<typeof createAssistantExecutor>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-write-test-'));
    executor = createAssistantExecutor(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a file with relative path', async () => {
    const result = await executor('write_file', { file: 'test.ts', content: 'const x = 1;' });
    expect(result.isError).toBe(false);
    expect(result.result).toContain('test.ts');
    expect(fs.readFileSync(path.join(tmpDir, 'test.ts'), 'utf-8')).toBe('const x = 1;');
  });

  it('writes a file with absolute path inside projectDir', async () => {
    const absPath = path.join(tmpDir, 'abs-test.ts');
    const result = await executor('write_file', { file: absPath, content: 'const y = 2;' });
    expect(result.isError).toBe(false);
    expect(fs.readFileSync(absPath, 'utf-8')).toBe('const y = 2;');
  });

  it('creates nested directories automatically', async () => {
    const result = await executor('write_file', { file: 'src/deep/nested/file.ts', content: 'export {}' });
    expect(result.isError).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'src/deep/nested/file.ts'))).toBe(true);
  });

  it('blocks writes outside projectDir', async () => {
    const result = await executor('write_file', { file: '/etc/test.txt', content: 'hack' });
    expect(result.isError).toBe(true);
    expect(result.result).toContain('outside project directory');
  });

  it('blocks path traversal with ../', async () => {
    const result = await executor('write_file', { file: '../../../etc/test.txt', content: 'hack' });
    expect(result.isError).toBe(true);
    expect(result.result).toContain('outside project directory');
  });

  it('blocks empty content', async () => {
    const result = await executor('write_file', { file: 'empty.ts', content: '' });
    expect(result.isError).toBe(true);
    expect(result.result).toContain('empty');
  });

  it('blocks whitespace-only content', async () => {
    const result = await executor('write_file', { file: 'whitespace.ts', content: '   \n  \n  ' });
    expect(result.isError).toBe(true);
    expect(result.result).toContain('empty');
  });

  it('blocks shrink >50% on existing file', async () => {
    const filePath = path.join(tmpDir, 'big.ts');
    fs.writeFileSync(filePath, 'x'.repeat(1000), 'utf-8');
    const result = await executor('write_file', { file: 'big.ts', content: 'small' });
    expect(result.isError).toBe(true);
    expect(result.result).toContain('shrink');
  });

  it('allows replacing file of similar size', async () => {
    const filePath = path.join(tmpDir, 'replace.ts');
    fs.writeFileSync(filePath, 'const old = 1;', 'utf-8');
    const result = await executor('write_file', { file: 'replace.ts', content: 'const new = 2;' });
    expect(result.isError).toBe(false);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('const new = 2;');
  });

  it('reports character count in success message', async () => {
    const result = await executor('write_file', { file: 'count.ts', content: 'hello world' });
    expect(result.isError).toBe(false);
    expect(result.result).toContain('11');
  });

  it('handles absolute path to different project dir as blocked', async () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-other-'));
    try {
      const result = await executor('write_file', { file: path.join(otherDir, 'steal.ts'), content: 'stolen' });
      expect(result.isError).toBe(true);
      expect(result.result).toContain('outside project directory');
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });
});

describe('patch_file tool', () => {
  let tmpDir: string;
  let executor: ReturnType<typeof createAssistantExecutor>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-patch-test-'));
    executor = createAssistantExecutor(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('applies a single patch', async () => {
    fs.writeFileSync(path.join(tmpDir, 'target.ts'), 'const x = 1;\nconst y = 2;\n', 'utf-8');
    const result = await executor('patch_file', {
      file: 'target.ts',
      patches: [{ find: 'const y = 2;', replace: 'const y = 10;' }],
    });
    expect(result.isError).toBe(false);
    expect(result.result).toContain('1/1');
    expect(fs.readFileSync(path.join(tmpDir, 'target.ts'), 'utf-8')).toContain('const y = 10;');
  });

  it('applies multiple patches', async () => {
    fs.writeFileSync(path.join(tmpDir, 'multi.ts'), 'aaa bbb ccc', 'utf-8');
    const result = await executor('patch_file', {
      file: 'multi.ts',
      patches: [
        { find: 'aaa', replace: 'AAA' },
        { find: 'ccc', replace: 'CCC' },
      ],
    });
    expect(result.isError).toBe(false);
    expect(result.result).toContain('2/2');
    expect(fs.readFileSync(path.join(tmpDir, 'multi.ts'), 'utf-8')).toBe('AAA bbb CCC');
  });

  it('reports partial matches', async () => {
    fs.writeFileSync(path.join(tmpDir, 'partial.ts'), 'aaa bbb', 'utf-8');
    const result = await executor('patch_file', {
      file: 'partial.ts',
      patches: [
        { find: 'aaa', replace: 'AAA' },
        { find: 'zzz', replace: 'ZZZ' }, // won't match
      ],
    });
    expect(result.isError).toBe(false);
    expect(result.result).toContain('1/2');
  });

  it('fails if no patches match', async () => {
    fs.writeFileSync(path.join(tmpDir, 'nomatch.ts'), 'hello', 'utf-8');
    const result = await executor('patch_file', {
      file: 'nomatch.ts',
      patches: [{ find: 'goodbye', replace: 'hi' }],
    });
    expect(result.isError).toBe(true);
    expect(result.result).toContain('No patches matched');
  });

  it('blocks patches outside projectDir', async () => {
    const result = await executor('patch_file', {
      file: '/etc/passwd',
      patches: [{ find: 'root', replace: 'hacked' }],
    });
    expect(result.isError).toBe(true);
    expect(result.result).toContain('outside project directory');
  });

  it('fails on nonexistent file', async () => {
    const result = await executor('patch_file', {
      file: 'nonexistent.ts',
      patches: [{ find: 'x', replace: 'y' }],
    });
    expect(result.isError).toBe(true);
    expect(result.result).toContain('not found');
  });

  it('works with absolute path inside projectDir', async () => {
    const absPath = path.join(tmpDir, 'abs-patch.ts');
    fs.writeFileSync(absPath, 'old value', 'utf-8');
    const result = await executor('patch_file', {
      file: absPath,
      patches: [{ find: 'old', replace: 'new' }],
    });
    expect(result.isError).toBe(false);
    expect(fs.readFileSync(absPath, 'utf-8')).toBe('new value');
  });

  it('blocks path traversal', async () => {
    const result = await executor('patch_file', {
      file: '../../etc/passwd',
      patches: [{ find: 'root', replace: 'hacked' }],
    });
    expect(result.isError).toBe(true);
    expect(result.result).toContain('outside project directory');
  });
});

describe('write_file with worktree-like projectDir', () => {
  let worktreeDir: string;
  let mainDir: string;
  let executor: ReturnType<typeof createAssistantExecutor>;

  beforeEach(() => {
    mainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-main-'));
    worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-worktree-'));
    // Executor targets worktree, not main
    executor = createAssistantExecutor(worktreeDir);
  });

  afterEach(() => {
    fs.rmSync(mainDir, { recursive: true, force: true });
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  });

  it('writes to worktree when given relative path', async () => {
    const result = await executor('write_file', { file: 'src/test.ts', content: 'worktree content' });
    expect(result.isError).toBe(false);
    expect(fs.existsSync(path.join(worktreeDir, 'src/test.ts'))).toBe(true);
    expect(fs.existsSync(path.join(mainDir, 'src/test.ts'))).toBe(false);
  });

  it('blocks writes to main dir when executor targets worktree', async () => {
    const result = await executor('write_file', { file: path.join(mainDir, 'leaked.ts'), content: 'leaked' });
    expect(result.isError).toBe(true);
    expect(result.result).toContain('outside project directory');
    expect(fs.existsSync(path.join(mainDir, 'leaked.ts'))).toBe(false);
  });

  it('patches files in worktree, not main', async () => {
    // Same file exists in both
    fs.writeFileSync(path.join(mainDir, 'shared.ts'), 'main content', 'utf-8');
    fs.writeFileSync(path.join(worktreeDir, 'shared.ts'), 'worktree content', 'utf-8');

    const result = await executor('patch_file', {
      file: 'shared.ts',
      patches: [{ find: 'worktree', replace: 'PATCHED' }],
    });
    expect(result.isError).toBe(false);
    // Worktree was patched
    expect(fs.readFileSync(path.join(worktreeDir, 'shared.ts'), 'utf-8')).toBe('PATCHED content');
    // Main was NOT touched
    expect(fs.readFileSync(path.join(mainDir, 'shared.ts'), 'utf-8')).toBe('main content');
  });
});
