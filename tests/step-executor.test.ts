import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { executeStep, resetPlanFileCounter } from '../src/bot/step-executor.js';

// ---------------------------------------------------------------------------
// Tests for step-executor.ts
// Focus: safety guards, error handling, reliability gaps
// ---------------------------------------------------------------------------

describe('step-executor', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-executor-test-'));
    resetPlanFileCounter();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  // =========================================================================
  // resetPlanFileCounter
  // =========================================================================
  describe('resetPlanFileCounter', () => {
    it('resets the file counter so writes are allowed again', async () => {
      // Write a file to increment the counter
      fs.writeFileSync(path.join(tmpDir, 'dummy.txt'), 'hello', 'utf-8');
      const result = await executeStep(
        { operation: 'write-file', args: { file: 'test.txt', content: 'content here' } },
        tmpDir,
      );
      expect(result.blocked).toBeFalsy();

      // Reset and verify we can still write
      resetPlanFileCounter();
      const result2 = await executeStep(
        { operation: 'write-file', args: { file: 'test2.txt', content: 'more content' } },
        tmpDir,
      );
      expect(result2.blocked).toBeFalsy();
    });
  });

  // =========================================================================
  // Path safety
  // =========================================================================
  describe('path traversal', () => {
    it('blocks paths that escape the project directory', async () => {
      await expect(
        executeStep({ operation: 'read-file', args: { file: '../../etc/passwd' } }, tmpDir),
      ).rejects.toThrow(/Path traversal blocked/);
    });

    it('blocks symlinks that escape the project directory', async () => {
      const linkPath = path.join(tmpDir, 'sneaky-link');
      fs.symlinkSync('/etc', linkPath);
      await expect(
        executeStep({ operation: 'read-file', args: { file: 'sneaky-link/passwd' } }, tmpDir),
      ).rejects.toThrow(/Path traversal blocked/);
    });
  });

  // =========================================================================
  // read-file: race condition fix
  // =========================================================================
  describe('read-file', () => {
    it('returns file content for a normal file', async () => {
      fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'world', 'utf-8');
      const result = await executeStep(
        { operation: 'read-file', args: { file: 'hello.txt' } },
        tmpDir,
      );
      expect(result.output).toBe('world');
    });

    it('returns "File not found" for missing file', async () => {
      const result = await executeStep(
        { operation: 'read-file', args: { file: 'nope.txt' } },
        tmpDir,
      );
      expect(result.output).toContain('File not found');
    });

    it('returns directory listing when path is a directory', async () => {
      fs.mkdirSync(path.join(tmpDir, 'subdir'));
      fs.writeFileSync(path.join(tmpDir, 'subdir', 'a.txt'), 'a', 'utf-8');
      const result = await executeStep(
        { operation: 'read-file', args: { file: 'subdir' } },
        tmpDir,
      );
      expect(result.output).toContain('is a directory');
      expect(result.output).toContain('a.txt');
    });

    it('returns clean error when file cannot be read (e.g. permission denied)', async () => {
      // BUG: read-file calls existsSync, statSync, statSync, readFileSync
      // with no try-catch. If any of these throw (EACCES, ENOENT race),
      // the exception propagates uncaught instead of returning a clean result.
      const filePath = path.join(tmpDir, 'unreadable.txt');
      fs.writeFileSync(filePath, 'secret content here', 'utf-8');
      // Make file unreadable
      fs.chmodSync(filePath, 0o000);

      try {
        // This should return a clean error result, NOT throw an uncaught exception
        const result = await executeStep(
          { operation: 'read-file', args: { file: 'unreadable.txt' } },
          tmpDir,
        );
        expect(result.output).toBeDefined();
        expect(result.output).toMatch(/error|cannot|permission|denied/i);
      } finally {
        // Restore permissions for cleanup
        fs.chmodSync(filePath, 0o644);
      }
    });
  });

  // =========================================================================
  // list-files: permission error handling
  // =========================================================================
  describe('list-files', () => {
    it('lists files in a directory', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'a', 'utf-8');
      fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'b', 'utf-8');
      const result = await executeStep(
        { operation: 'list-files', args: { directory: '.' } },
        tmpDir,
      );
      expect(result.files).toContain(path.join('.', 'a.txt'));
      expect(result.files).toContain(path.join('.', 'b.txt'));
    });

    it('returns clean error when directory does not exist', async () => {
      const result = await executeStep(
        { operation: 'list-files', args: { directory: 'nope' } },
        tmpDir,
      );
      expect(result.output).toContain('Directory not found');
    });

    it('returns clean error when directory is unreadable (permission error)', async () => {
      // BUG: readdirSync with { recursive: true } can throw EACCES on
      // subdirectories. Currently this propagates as an uncaught exception
      // instead of returning a clean error result.
      const subDir = path.join(tmpDir, 'restricted');
      fs.mkdirSync(subDir);
      fs.writeFileSync(path.join(subDir, 'secret.txt'), 'hidden', 'utf-8');
      // Make directory unreadable
      fs.chmodSync(subDir, 0o000);

      try {
        // Should return a clean error, not throw
        const result = await executeStep(
          { operation: 'list-files', args: { directory: 'restricted' } },
          tmpDir,
        );
        expect(result.output).toBeDefined();
        expect(result.blocked || result.output!.toLowerCase().includes('error') || result.output!.toLowerCase().includes('permission')).toBe(true);
      } finally {
        fs.chmodSync(subDir, 0o755);
      }
    });

    it('filters files by regex pattern', async () => {
      fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'code', 'utf-8');
      fs.writeFileSync(path.join(tmpDir, 'app.js'), 'code', 'utf-8');
      fs.writeFileSync(path.join(tmpDir, 'readme.md'), 'docs', 'utf-8');
      const result = await executeStep(
        { operation: 'list-files', args: { directory: '.', pattern: '\\.ts$' } },
        tmpDir,
      );
      expect(result.files).toContain(path.join('.', 'app.ts'));
      expect(result.files).not.toContain(path.join('.', 'app.js'));
    });

    it('returns error for invalid regex pattern', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'a', 'utf-8');
      const result = await executeStep(
        { operation: 'list-files', args: { directory: '.', pattern: '[invalid' } },
        tmpDir,
      );
      expect(result.output).toContain('Invalid regex');
    });
  });

  // =========================================================================
  // write-file: safety guards
  // =========================================================================
  describe('write-file', () => {
    it('blocks empty content writes', async () => {
      const result = await executeStep(
        { operation: 'write-file', args: { file: 'empty.txt', content: '' } },
        tmpDir,
      );
      expect(result.blocked).toBe(true);
      expect(result.blockReason).toContain('empty');
    });

    it('blocks shrink writes exceeding threshold', async () => {
      const bigContent = 'x'.repeat(500);
      fs.writeFileSync(path.join(tmpDir, 'big.txt'), bigContent, 'utf-8');
      const result = await executeStep(
        { operation: 'write-file', args: { file: 'big.txt', content: 'tiny' } },
        tmpDir,
      );
      expect(result.blocked).toBe(true);
      expect(result.blockReason).toContain('smaller');
    });

    it('requires a file argument', async () => {
      const result = await executeStep(
        { operation: 'write-file', args: { content: 'hello' } },
        tmpDir,
      );
      expect(result.blocked).toBe(true);
      expect(result.blockReason).toContain('file');
    });

    it('creates directories as needed', async () => {
      const result = await executeStep(
        { operation: 'write-file', args: { file: 'deep/nested/file.txt', content: 'hello world' } },
        tmpDir,
      );
      expect(result.blocked).toBeFalsy();
      expect(result.created).toBe(true);
      expect(fs.readFileSync(path.join(tmpDir, 'deep/nested/file.txt'), 'utf-8')).toBe('hello world');
    });
  });

  // =========================================================================
  // patch-file
  // =========================================================================
  describe('patch-file', () => {
    it('applies find-and-replace patches', async () => {
      fs.writeFileSync(path.join(tmpDir, 'code.ts'), 'const x = 1;\nconst y = 2;\n', 'utf-8');
      const result = await executeStep(
        {
          operation: 'patch-file',
          args: {
            file: 'code.ts',
            patches: [{ find: 'const x = 1;', replace: 'const x = 42;' }],
          },
        },
        tmpDir,
      );
      expect(result.output).toContain('Applied 1/1');
      expect(fs.readFileSync(path.join(tmpDir, 'code.ts'), 'utf-8')).toContain('const x = 42;');
    });

    it('reports patches not found', async () => {
      fs.writeFileSync(path.join(tmpDir, 'code.ts'), 'const x = 1;\n', 'utf-8');
      const result = await executeStep(
        {
          operation: 'patch-file',
          args: {
            file: 'code.ts',
            patches: [{ find: 'nonexistent string', replace: 'something' }],
          },
        },
        tmpDir,
      );
      expect(result.output).toContain('No patches applied');
    });

    it('blocks file not found', async () => {
      const result = await executeStep(
        {
          operation: 'patch-file',
          args: { file: 'nope.ts', patches: [{ find: 'a', replace: 'b' }] },
        },
        tmpDir,
      );
      expect(result.blocked).toBe(true);
    });
  });

  // =========================================================================
  // run-shell: safety guards
  // =========================================================================
  describe('run-shell', () => {
    it('executes a safe command', async () => {
      const result = await executeStep(
        { operation: 'run-shell', args: { command: 'echo hello' } },
        tmpDir,
      );
      expect(result.output).toBe('hello');
    });

    it('blocks dangerous commands', async () => {
      const result = await executeStep(
        { operation: 'run-shell', args: { command: 'rm -rf /' } },
        tmpDir,
      );
      expect(result.blocked).toBe(true);
      expect(result.blockReason).toContain('blocked');
    });

    it('blocks git push', async () => {
      const result = await executeStep(
        { operation: 'run-shell', args: { command: 'git push origin main' } },
        tmpDir,
      );
      expect(result.blocked).toBe(true);
    });

    it('returns stderr on non-zero exit', async () => {
      const result = await executeStep(
        { operation: 'run-shell', args: { command: 'ls /nonexistent_dir_abc123' } },
        tmpDir,
      );
      expect(result.output).toBeDefined();
      expect(result.output!.length).toBeGreaterThan(0);
    });

    it('blocks empty command', async () => {
      const result = await executeStep(
        { operation: 'run-shell', args: { command: '' } },
        tmpDir,
      );
      expect(result.blocked).toBe(true);
    });
  });
});
