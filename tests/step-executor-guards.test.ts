import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { executeStep, resetPlanFileCounter } from '../src/bot/step-executor.js';

const tmpDir = path.join(os.tmpdir(), 'weaver-test-' + Date.now());

beforeEach(() => {
  resetPlanFileCounter();
  fs.mkdirSync(tmpDir, { recursive: true });
});

// ---------------------------------------------------------------------------
// Write safety guards
// ---------------------------------------------------------------------------

describe('write-file safety guards', () => {
  it('blocks empty content', async () => {
    const result = await executeStep(
      { operation: 'write-file', args: { file: 'test.ts', content: '' } },
      tmpDir,
    );
    expect(result.blocked).toBe(true);
    expect(result.blockReason).toContain('empty content');
  });

  it('blocks whitespace-only content', async () => {
    const result = await executeStep(
      { operation: 'write-file', args: { file: 'test.ts', content: '   \n  \n  ' } },
      tmpDir,
    );
    expect(result.blocked).toBe(true);
    expect(result.blockReason).toContain('empty content');
  });

  it('blocks >50% shrink', async () => {
    const filePath = path.join(tmpDir, 'big.ts');
    fs.writeFileSync(filePath, 'x'.repeat(1000), 'utf-8');

    const result = await executeStep(
      { operation: 'write-file', args: { file: 'big.ts', content: 'small' } },
      tmpDir,
    );
    expect(result.blocked).toBe(true);
    expect(result.blockReason).toContain('smaller');
  });

  it('allows writes within shrink threshold', async () => {
    const filePath = path.join(tmpDir, 'ok.ts');
    fs.writeFileSync(filePath, 'x'.repeat(100), 'utf-8');

    const result = await executeStep(
      { operation: 'write-file', args: { file: 'ok.ts', content: 'x'.repeat(60) } },
      tmpDir,
    );
    expect(result.blocked).toBeUndefined();
    expect(result.file).toBeTruthy();
  });

  it('allows new file creation', async () => {
    const result = await executeStep(
      { operation: 'write-file', args: { file: 'new.ts', content: 'export const x = 1;' } },
      tmpDir,
    );
    expect(result.blocked).toBeUndefined();
    expect(result.created).toBe(true);
  });

  it('blocks path traversal', async () => {
    await expect(executeStep(
      { operation: 'write-file', args: { file: '../../etc/passwd', content: 'hack' } },
      tmpDir,
    )).rejects.toThrow('Path traversal');
  });

  it('requires file argument', async () => {
    const result = await executeStep(
      { operation: 'write-file', args: { content: 'hello' } },
      tmpDir,
    );
    expect(result.blocked).toBe(true);
    expect(result.blockReason).toContain('requires a "file"');
  });
});

// ---------------------------------------------------------------------------
// Patch file
// ---------------------------------------------------------------------------

describe('patch-file', () => {
  it('applies single patch', async () => {
    const filePath = path.join(tmpDir, 'patch.ts');
    fs.writeFileSync(filePath, '@input name [order:0]', 'utf-8');

    const result = await executeStep({
      operation: 'patch-file',
      args: { file: 'patch.ts', find: '@input name', replace: '@input [name]' },
    }, tmpDir);

    expect(result.output).toContain('Applied 1/1');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('@input [name] [order:0]');
  });

  it('replaces ALL occurrences', async () => {
    const filePath = path.join(tmpDir, 'multi.ts');
    fs.writeFileSync(filePath, '@input foo\n@input foo\n@input foo', 'utf-8');

    await executeStep({
      operation: 'patch-file',
      args: { file: 'multi.ts', find: '@input foo', replace: '@input [foo]' },
    }, tmpDir);

    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toBe('@input [foo]\n@input [foo]\n@input [foo]');
  });

  it('applies multiple patches', async () => {
    const filePath = path.join(tmpDir, 'multi-patch.ts');
    fs.writeFileSync(filePath, '@input a\n@input b', 'utf-8');

    const result = await executeStep({
      operation: 'patch-file',
      args: {
        file: 'multi-patch.ts',
        patches: [
          { find: '@input a', replace: '@input [a]' },
          { find: '@input b', replace: '@input [b]' },
        ],
      },
    }, tmpDir);

    expect(result.output).toContain('Applied 2/2');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('@input [a]\n@input [b]');
  });

  it('reports not-found patches', async () => {
    const filePath = path.join(tmpDir, 'nf.ts');
    fs.writeFileSync(filePath, 'hello world', 'utf-8');

    const result = await executeStep({
      operation: 'patch-file',
      args: { file: 'nf.ts', find: 'nonexistent', replace: 'x' },
    }, tmpDir);

    expect(result.output).toContain('No patches applied');
  });

  it('blocks on missing file', async () => {
    const result = await executeStep({
      operation: 'patch-file',
      args: { file: 'nofile.ts', find: 'x', replace: 'y' },
    }, tmpDir);
    expect(result.blocked).toBe(true);
    expect(result.blockReason).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// Read file
// ---------------------------------------------------------------------------

describe('read-file', () => {
  it('returns file content', async () => {
    const filePath = path.join(tmpDir, 'read.ts');
    fs.writeFileSync(filePath, 'export const x = 42;', 'utf-8');

    const result = await executeStep({ operation: 'read-file', args: { file: 'read.ts' } }, tmpDir);
    expect(result.output).toBe('export const x = 42;');
  });

  it('returns directory listing for directories', async () => {
    fs.mkdirSync(path.join(tmpDir, 'subdir'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'subdir', 'a.ts'), '', 'utf-8');

    const result = await executeStep({ operation: 'read-file', args: { file: 'subdir' } }, tmpDir);
    expect(result.output).toContain('is a directory');
    expect(result.output).toContain('a.ts');
  });

  it('reports missing file', async () => {
    const result = await executeStep({ operation: 'read-file', args: { file: 'gone.ts' } }, tmpDir);
    expect(result.output).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// Run shell
// ---------------------------------------------------------------------------

describe('run-shell', () => {
  it('runs simple command', async () => {
    const result = await executeStep({ operation: 'run-shell', args: { command: 'echo hello' } }, tmpDir);
    expect(result.output).toBe('hello');
  });

  it('captures stderr on failure', async () => {
    const result = await executeStep({ operation: 'run-shell', args: { command: 'ls /nonexistent' } }, tmpDir);
    expect(result.output).toBeTruthy(); // stderr captured
  });

  it('blocks dangerous commands', async () => {
    const result = await executeStep({ operation: 'run-shell', args: { command: 'sudo rm -rf /' } }, tmpDir);
    expect(result.blocked).toBe(true);
  });

  it('blocks git push', async () => {
    const result = await executeStep({ operation: 'run-shell', args: { command: 'git push origin main' } }, tmpDir);
    expect(result.blocked).toBe(true);
  });

  it('blocks npm publish', async () => {
    const result = await executeStep({ operation: 'run-shell', args: { command: 'npm publish' } }, tmpDir);
    expect(result.blocked).toBe(true);
  });

  it('allows safe commands', async () => {
    const result = await executeStep({ operation: 'run-shell', args: { command: 'echo safe' } }, tmpDir);
    expect(result.blocked).toBeUndefined();
  });

  it('requires command argument', async () => {
    const result = await executeStep({ operation: 'run-shell', args: {} }, tmpDir);
    expect(result.blocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// List files
// ---------------------------------------------------------------------------

describe('list-files', () => {
  it('lists files in directory', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), '', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), '', 'utf-8');

    const result = await executeStep({ operation: 'list-files', args: { directory: '.' } }, tmpDir);
    expect(result.output).toContain('a.ts');
    expect(result.output).toContain('b.ts');
  });

  it('filters by regex pattern', async () => {
    fs.writeFileSync(path.join(tmpDir, 'x.ts'), '', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'x.js'), '', 'utf-8');

    const result = await executeStep({ operation: 'list-files', args: { directory: '.', pattern: '\\.ts$' } }, tmpDir);
    expect(result.output).toContain('x.ts');
    expect(result.output).not.toContain('x.js');
  });

  it('handles invalid regex', async () => {
    const result = await executeStep({ operation: 'list-files', args: { directory: '.', pattern: '[unclosed' } }, tmpDir);
    expect(result.output).toContain('Invalid regex');
  });
});

// ---------------------------------------------------------------------------
// Issue 1: Symlink bypass in assertSafePath
// ---------------------------------------------------------------------------

describe('symlink path traversal', () => {
  const symlinkDir = path.join(tmpDir, 'symlink-test');
  const outsideDir = path.join(os.tmpdir(), 'weaver-outside-' + Date.now());

  beforeEach(() => {
    fs.mkdirSync(symlinkDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'TOP SECRET', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('blocks read through symlink pointing outside project', async () => {
    // Create a symlink inside the project that points to an outside directory
    const linkPath = path.join(symlinkDir, 'escape-link');
    fs.symlinkSync(outsideDir, linkPath);

    const result = await executeStep(
      { operation: 'read-file', args: { file: 'symlink-test/escape-link/secret.txt' } },
      symlinkDir.replace(/\/symlink-test$/, '/symlink-test'),
    );
    // Should be blocked, not return the secret
    expect(result.output).not.toContain('TOP SECRET');
  });

  it('blocks write through symlink pointing outside project', async () => {
    const linkPath = path.join(symlinkDir, 'write-escape');
    fs.symlinkSync(outsideDir, linkPath);

    await expect(executeStep(
      { operation: 'write-file', args: { file: 'write-escape/pwned.txt', content: 'hacked' } },
      symlinkDir,
    )).rejects.toThrow();

    // The file should NOT exist outside
    expect(fs.existsSync(path.join(outsideDir, 'pwned.txt'))).toBe(false);
  });

  it('blocks patch through symlink pointing outside project', async () => {
    const linkPath = path.join(symlinkDir, 'patch-escape');
    fs.symlinkSync(outsideDir, linkPath);

    await expect(executeStep(
      { operation: 'patch-file', args: { file: 'patch-escape/secret.txt', find: 'TOP', replace: 'NO' } },
      symlinkDir,
    )).rejects.toThrow('Path traversal');

    // Original file should be unchanged
    expect(fs.readFileSync(path.join(outsideDir, 'secret.txt'), 'utf-8')).toBe('TOP SECRET');
  });
});

// ---------------------------------------------------------------------------
// Issue 2: Patch-file missing shrink guard
// ---------------------------------------------------------------------------

describe('patch-file shrink guard', () => {
  it('blocks patch that would shrink file by more than 50%', async () => {
    const filePath = path.join(tmpDir, 'shrinkable.ts');
    const originalContent = 'x'.repeat(500) + '\nkeep this line\n' + 'y'.repeat(500);
    fs.writeFileSync(filePath, originalContent, 'utf-8');

    // Patch replaces most of the content with almost nothing
    const result = await executeStep({
      operation: 'patch-file',
      args: {
        file: 'shrinkable.ts',
        patches: [
          { find: 'x'.repeat(500), replace: '' },
          { find: 'y'.repeat(500), replace: '' },
        ],
      },
    }, tmpDir);

    expect(result.blocked).toBe(true);
    expect(result.blockReason).toContain('shrink');

    // Original file unchanged
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(originalContent);
  });

  it('allows patch within shrink threshold', async () => {
    const filePath = path.join(tmpDir, 'ok-patch.ts');
    fs.writeFileSync(filePath, 'aaaa bbbb cccc dddd eeee ffff', 'utf-8');

    const result = await executeStep({
      operation: 'patch-file',
      args: { file: 'ok-patch.ts', find: 'aaaa', replace: 'zz' },
    }, tmpDir);

    expect(result.blocked).toBeUndefined();
    expect(result.output).toContain('Applied 1/1');
  });

  it('skips shrink guard on small files', async () => {
    const filePath = path.join(tmpDir, 'tiny.ts');
    fs.writeFileSync(filePath, 'ab', 'utf-8');

    const result = await executeStep({
      operation: 'patch-file',
      args: { file: 'tiny.ts', find: 'ab', replace: '' },
    }, tmpDir);

    // Small files (< 100 bytes) should not trigger shrink guard
    expect(result.blocked).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Issue 3: Pipe-to-interpreter detection
// ---------------------------------------------------------------------------

describe('pipe-to-interpreter shell blocking', () => {
  it('blocks base64 piped to bash', async () => {
    const result = await executeStep(
      { operation: 'run-shell', args: { command: 'echo dG91Y2ggL3RtcC9wd25lZA== | base64 -d | bash' } },
      tmpDir,
    );
    expect(result.blocked).toBe(true);
  });

  it('blocks base64 piped to sh', async () => {
    const result = await executeStep(
      { operation: 'run-shell', args: { command: 'echo foo | base64 -d | sh' } },
      tmpDir,
    );
    expect(result.blocked).toBe(true);
  });

  it('blocks node -e with inline code', async () => {
    const result = await executeStep(
      { operation: 'run-shell', args: { command: 'node -e "require(\'child_process\').execSync(\'rm -rf /\')"' } },
      tmpDir,
    );
    expect(result.blocked).toBe(true);
  });

  it('blocks node --eval', async () => {
    const result = await executeStep(
      { operation: 'run-shell', args: { command: 'node --eval "process.exit(1)"' } },
      tmpDir,
    );
    expect(result.blocked).toBe(true);
  });

  it('blocks python -c', async () => {
    const result = await executeStep(
      { operation: 'run-shell', args: { command: 'python -c "import os; os.system(\'rm -rf /\')"' } },
      tmpDir,
    );
    expect(result.blocked).toBe(true);
  });

  it('blocks python3 -c', async () => {
    const result = await executeStep(
      { operation: 'run-shell', args: { command: 'python3 -c "import os"' } },
      tmpDir,
    );
    expect(result.blocked).toBe(true);
  });

  it('blocks eval with command substitution', async () => {
    const result = await executeStep(
      { operation: 'run-shell', args: { command: 'eval $(echo dangerous)' } },
      tmpDir,
    );
    expect(result.blocked).toBe(true);
  });

  it('blocks eval with string', async () => {
    const result = await executeStep(
      { operation: 'run-shell', args: { command: 'eval "rm -rf /"' } },
      tmpDir,
    );
    expect(result.blocked).toBe(true);
  });

  it('blocks perl -e', async () => {
    const result = await executeStep(
      { operation: 'run-shell', args: { command: 'perl -e "system(\'whoami\')"' } },
      tmpDir,
    );
    expect(result.blocked).toBe(true);
  });

  it('blocks ruby -e', async () => {
    const result = await executeStep(
      { operation: 'run-shell', args: { command: 'ruby -e "exec(\'id\')"' } },
      tmpDir,
    );
    expect(result.blocked).toBe(true);
  });

  it('allows legitimate node commands', async () => {
    const result = await executeStep(
      { operation: 'run-shell', args: { command: 'node --version' } },
      tmpDir,
    );
    expect(result.blocked).toBeUndefined();
  });

  it('allows legitimate python commands', async () => {
    const result = await executeStep(
      { operation: 'run-shell', args: { command: 'python3 --version' } },
      tmpDir,
    );
    expect(result.blocked).toBeUndefined();
  });
});
