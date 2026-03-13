import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { safeJsonParse, jsonParseOr, parseNdjson } from '../src/bot/safe-json.js';
import { safePath, safePathOrThrow } from '../src/bot/safe-path.js';

// ---------------------------------------------------------------------------
// safe-json
// ---------------------------------------------------------------------------

describe('safeJsonParse', () => {
  it('parses a plain object', () => {
    const result = safeJsonParse('{"a":1}');
    expect(result).toEqual({ ok: true, value: { a: 1 } });
  });

  it('parses an array', () => {
    const result = safeJsonParse('[1,2,3]');
    expect(result).toEqual({ ok: true, value: [1, 2, 3] });
  });

  it('parses a string literal', () => {
    const result = safeJsonParse('"hello"');
    expect(result).toEqual({ ok: true, value: 'hello' });
  });

  it('parses a number literal', () => {
    const result = safeJsonParse('42');
    expect(result).toEqual({ ok: true, value: 42 });
  });

  it('parses null', () => {
    const result = safeJsonParse('null');
    expect(result).toEqual({ ok: true, value: null });
  });

  it('parses boolean values', () => {
    expect(safeJsonParse('true')).toEqual({ ok: true, value: true });
    expect(safeJsonParse('false')).toEqual({ ok: true, value: false });
  });

  it('parses nested structures', () => {
    const input = JSON.stringify({ items: [{ id: 1 }, { id: 2 }], meta: { total: 2 } });
    const result = safeJsonParse(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ items: [{ id: 1 }, { id: 2 }], meta: { total: 2 } });
    }
  });

  it('returns error for invalid JSON syntax', () => {
    const result = safeJsonParse('{bad}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Invalid JSON');
    }
  });

  it('returns error for empty string', () => {
    const result = safeJsonParse('');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Invalid JSON');
    }
  });

  it('returns error for bare undefined', () => {
    const result = safeJsonParse('undefined');
    expect(result.ok).toBe(false);
  });

  it('returns error for trailing comma', () => {
    const result = safeJsonParse('{"a":1,}');
    expect(result.ok).toBe(false);
  });

  it('includes context prefix in error message', () => {
    const result = safeJsonParse('{', 'loading config');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/^loading config: Invalid JSON/);
    }
  });

  it('omits context prefix when context is not provided', () => {
    const result = safeJsonParse('{');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/^Invalid JSON/);
    }
  });

  it('respects the generic type parameter', () => {
    const result = safeJsonParse<{ name: string }>('{"name":"test"}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      // TypeScript narrows to { name: string }
      expect(result.value.name).toBe('test');
    }
  });
});

describe('jsonParseOr', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('returns parsed value on valid JSON', () => {
    expect(jsonParseOr('{"x":1}', {})).toEqual({ x: 1 });
  });

  it('returns fallback on invalid JSON', () => {
    const fallback = { default: true };
    expect(jsonParseOr('not-json', fallback)).toBe(fallback);
  });

  it('returns fallback on empty string', () => {
    expect(jsonParseOr('', 42)).toBe(42);
  });

  it('logs to console.error when context is provided and parse fails', () => {
    jsonParseOr('{bad}', null, 'AI response');
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0][0]).toContain('[weaver]');
    expect(errorSpy.mock.calls[0][0]).toContain('AI response');
  });

  it('does not log when context is omitted', () => {
    jsonParseOr('{bad}', null);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('does not log when parse succeeds even with context', () => {
    jsonParseOr('"ok"', null, 'ctx');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('returns the actual parsed value, not the fallback, on success', () => {
    const fallback = [1, 2, 3];
    const result = jsonParseOr('[4,5]', fallback);
    expect(result).toEqual([4, 5]);
    expect(result).not.toBe(fallback);
  });
});

describe('parseNdjson', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('parses multiple valid NDJSON lines', () => {
    const input = '{"id":1}\n{"id":2}\n{"id":3}';
    const { records, errors } = parseNdjson<{ id: number }>(input);
    expect(records).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(errors).toBe(0);
  });

  it('skips corrupt lines and counts errors', () => {
    const input = '{"id":1}\nBAD LINE\n{"id":2}';
    const { records, errors } = parseNdjson<{ id: number }>(input);
    expect(records).toEqual([{ id: 1 }, { id: 2 }]);
    expect(errors).toBe(1);
  });

  it('returns empty records for empty content', () => {
    const { records, errors } = parseNdjson('');
    expect(records).toEqual([]);
    expect(errors).toBe(0);
  });

  it('handles whitespace-only content', () => {
    const { records, errors } = parseNdjson('   \n  \n\n');
    expect(records).toEqual([]);
    expect(errors).toBe(0);
  });

  it('returns all errors when every line is corrupt', () => {
    const input = 'aaa\nbbb\nccc';
    const { records, errors } = parseNdjson(input);
    expect(records).toEqual([]);
    expect(errors).toBe(3);
  });

  it('ignores blank lines between valid records', () => {
    const input = '{"a":1}\n\n\n{"a":2}\n';
    const { records, errors } = parseNdjson(input);
    expect(records).toEqual([{ a: 1 }, { a: 2 }]);
    expect(errors).toBe(0);
  });

  it('logs a summary warning when context is provided and errors exist', () => {
    parseNdjson('bad\n{"ok":true}', 'audit log');
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0][0]).toContain('[weaver]');
    expect(errorSpy.mock.calls[0][0]).toContain('audit log');
    expect(errorSpy.mock.calls[0][0]).toContain('1 corrupt line');
  });

  it('does not log when context is provided but there are no errors', () => {
    parseNdjson('{"ok":true}', 'audit log');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('does not log when there are errors but no context', () => {
    parseNdjson('bad\nworse');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('handles lines with varied JSON types', () => {
    const input = '"string"\n42\nnull\n[1,2]\n{"k":"v"}';
    const { records, errors } = parseNdjson(input);
    expect(records).toEqual(['string', 42, null, [1, 2], { k: 'v' }]);
    expect(errors).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// safe-path
// ---------------------------------------------------------------------------

describe('safePath', () => {
  const base = '/project/workspace';

  it('resolves a simple relative file path', () => {
    const result = safePath(base, 'src/index.ts');
    expect(result).toBe(path.resolve(base, 'src/index.ts'));
  });

  it('resolves a file directly in the base directory', () => {
    const result = safePath(base, 'file.txt');
    expect(result).toBe(path.resolve(base, 'file.txt'));
  });

  it('resolves a deeply nested path', () => {
    const result = safePath(base, 'a/b/c/d/e.txt');
    expect(result).toBe(path.resolve(base, 'a/b/c/d/e.txt'));
  });

  it('rejects simple parent traversal (../)', () => {
    expect(safePath(base, '../escape')).toBeNull();
  });

  it('rejects deep traversal (../../etc/passwd)', () => {
    expect(safePath(base, '../../etc/passwd')).toBeNull();
  });

  it('rejects traversal hidden inside a subpath', () => {
    // "foo/../../escape" normalizes to "../escape"
    expect(safePath(base, 'foo/../../escape')).toBeNull();
  });

  it('rejects absolute paths', () => {
    expect(safePath(base, '/etc/passwd')).toBeNull();
  });

  it('rejects absolute paths on the same filesystem', () => {
    expect(safePath(base, '/project/workspace/still-absolute')).toBeNull();
  });

  it('allows a path with ./ prefix (current-dir reference)', () => {
    const result = safePath(base, './src/index.ts');
    expect(result).toBe(path.resolve(base, 'src/index.ts'));
  });

  it('allows a path that stays inside after partial traversal', () => {
    // "src/../lib/util.ts" normalizes to "lib/util.ts" — inside the base
    const result = safePath(base, 'src/../lib/util.ts');
    expect(result).toBe(path.resolve(base, 'lib/util.ts'));
  });

  it('rejects bare ".."', () => {
    expect(safePath(base, '..')).toBeNull();
  });

  it('handles single dot (resolves to base itself)', () => {
    const result = safePath(base, '.');
    expect(result).toBe(path.resolve(base));
  });

  it('handles empty string (resolves to base itself)', () => {
    // path.normalize('') returns '.' which resolves to base
    const result = safePath(base, '');
    expect(result).toBe(path.resolve(base));
  });

  it('rejects path that starts with ../ after normalization', () => {
    expect(safePath(base, 'a/b/../../../../root')).toBeNull();
  });
});

describe('safePathOrThrow', () => {
  const base = '/project/workspace';

  it('returns resolved path for a safe relative path', () => {
    const result = safePathOrThrow(base, 'src/app.ts');
    expect(result).toBe(path.resolve(base, 'src/app.ts'));
  });

  it('throws on path traversal', () => {
    expect(() => safePathOrThrow(base, '../escape')).toThrow('Unsafe file path rejected');
  });

  it('throws on absolute path', () => {
    expect(() => safePathOrThrow(base, '/etc/shadow')).toThrow('Unsafe file path rejected');
  });

  it('includes the rejected path in the error message', () => {
    expect(() => safePathOrThrow(base, '../../secrets')).toThrow('"../../secrets"');
  });

  it('includes context prefix in error when provided', () => {
    expect(() => safePathOrThrow(base, '../x', 'pack install')).toThrow(
      /^pack install: Unsafe file path rejected/,
    );
  });

  it('omits context prefix when context is not provided', () => {
    expect(() => safePathOrThrow(base, '../x')).toThrow(/^Unsafe file path rejected/);
  });

  it('does not throw for valid nested paths', () => {
    expect(() => safePathOrThrow(base, 'deep/nested/path/file.json')).not.toThrow();
  });
});
