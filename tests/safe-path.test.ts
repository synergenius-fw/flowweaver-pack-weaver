import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { safePath, safePathOrThrow } from '../src/bot/safe-path.js';

describe('safe-path', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-path-test-'));
    // Create some subdirectories and files for testing
    fs.mkdirSync(path.join(tmpDir, 'subdir'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'hello');
    fs.writeFileSync(path.join(tmpDir, 'subdir', 'nested.txt'), 'nested');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('safePath', () => {
    it('resolves valid relative path within base', () => {
      const result = safePath(tmpDir, 'file.txt');
      expect(result).toBe(path.join(tmpDir, 'file.txt'));
    });

    it('resolves nested relative path', () => {
      const result = safePath(tmpDir, 'subdir/nested.txt');
      expect(result).toBe(path.join(tmpDir, 'subdir', 'nested.txt'));
    });

    it('resolves non-existent file within base (for writes)', () => {
      const result = safePath(tmpDir, 'newfile.txt');
      expect(result).toBe(path.join(tmpDir, 'newfile.txt'));
    });

    it('resolves non-existent nested path within base', () => {
      const result = safePath(tmpDir, 'a/b/c.txt');
      expect(result).toBe(path.join(tmpDir, 'a', 'b', 'c.txt'));
    });

    it('rejects absolute paths', () => {
      expect(safePath(tmpDir, '/etc/passwd')).toBeNull();
    });

    it('rejects simple .. traversal', () => {
      expect(safePath(tmpDir, '../etc/passwd')).toBeNull();
    });

    it('rejects normalized traversal via intermediate ..', () => {
      expect(safePath(tmpDir, 'subdir/../../etc/passwd')).toBeNull();
    });

    it('rejects bare ..', () => {
      expect(safePath(tmpDir, '..')).toBeNull();
    });

    it('accepts path equal to baseDir (dot path)', () => {
      const result = safePath(tmpDir, '.');
      expect(result).toBe(path.resolve(tmpDir));
    });

    it('accepts path with redundant ./ prefix', () => {
      const result = safePath(tmpDir, './file.txt');
      expect(result).toBe(path.join(tmpDir, 'file.txt'));
    });

    it('rejects symlink that escapes base directory', () => {
      // Create a directory outside the base
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-path-outside-'));
      fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'secret');

      // Create symlink inside base pointing outside
      const symlinkPath = path.join(tmpDir, 'escape-link');
      fs.symlinkSync(outsideDir, symlinkPath);

      const result = safePath(tmpDir, 'escape-link/secret.txt');
      expect(result).toBeNull();

      // Cleanup
      fs.rmSync(outsideDir, { recursive: true, force: true });
    });

    it('allows symlink that stays within base directory', () => {
      // Create symlink within base pointing to subdir
      const symlinkPath = path.join(tmpDir, 'internal-link');
      fs.symlinkSync(path.join(tmpDir, 'subdir'), symlinkPath);

      const result = safePath(tmpDir, 'internal-link/nested.txt');
      expect(result).not.toBeNull();
    });
  });

  describe('safePathOrThrow', () => {
    it('returns resolved path for valid input', () => {
      const result = safePathOrThrow(tmpDir, 'file.txt');
      expect(result).toBe(path.join(tmpDir, 'file.txt'));
    });

    it('throws on traversal attempt', () => {
      expect(() => safePathOrThrow(tmpDir, '../etc/passwd')).toThrow(
        'Unsafe file path rejected: "../etc/passwd"'
      );
    });

    it('throws on absolute path', () => {
      expect(() => safePathOrThrow(tmpDir, '/etc/passwd')).toThrow(
        'Unsafe file path rejected: "/etc/passwd"'
      );
    });

    it('includes context prefix in error message when provided', () => {
      expect(() => safePathOrThrow(tmpDir, '..', 'read_file')).toThrow(
        'read_file: Unsafe file path rejected: ".."'
      );
    });

    it('omits prefix when context is undefined', () => {
      expect(() => safePathOrThrow(tmpDir, '..')).toThrow(
        'Unsafe file path rejected: ".."'
      );
      // Verify no leading colon/space
      try {
        safePathOrThrow(tmpDir, '..');
      } catch (e: unknown) {
        expect((e as Error).message).not.toMatch(/^:/);
      }
    });

    it('returns nested path for valid nested input', () => {
      const result = safePathOrThrow(tmpDir, 'subdir/nested.txt', 'patch_file');
      expect(result).toBe(path.join(tmpDir, 'subdir', 'nested.txt'));
    });
  });
});
