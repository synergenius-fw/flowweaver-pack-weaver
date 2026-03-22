import { describe, it, expect, vi, afterEach } from 'vitest';
import { safeJsonParse, jsonParseOr, parseNdjson } from '../src/bot/safe-json.js';

describe('safeJsonParse', () => {
  it('parses valid JSON and returns ok result', () => {
    const result = safeJsonParse('{"name":"test","value":42}');
    expect(result).toEqual({ ok: true, value: { name: 'test', value: 42 } });
  });

  it('parses valid JSON arrays', () => {
    const result = safeJsonParse('[1,2,3]');
    expect(result).toEqual({ ok: true, value: [1, 2, 3] });
  });

  it('parses valid JSON primitives', () => {
    expect(safeJsonParse('"hello"')).toEqual({ ok: true, value: 'hello' });
    expect(safeJsonParse('42')).toEqual({ ok: true, value: 42 });
    expect(safeJsonParse('true')).toEqual({ ok: true, value: true });
    expect(safeJsonParse('null')).toEqual({ ok: true, value: null });
  });

  it('returns error for invalid JSON without context', () => {
    const result = safeJsonParse('{bad json}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Invalid JSON');
      expect(result.error).not.toContain(':'); // no prefix when no context
    }
  });

  it('returns error with context prefix for invalid JSON', () => {
    const result = safeJsonParse('{bad}', 'config.json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/^config\.json: Invalid JSON/);
    }
  });

  it('returns error for empty string', () => {
    const result = safeJsonParse('');
    expect(result.ok).toBe(false);
  });

  it('preserves generic type in return value', () => {
    const result = safeJsonParse<{ id: number }>('{"id":1}');
    if (result.ok) {
      // TypeScript compile-time check: result.value should be { id: number }
      expect(result.value.id).toBe(1);
    }
  });
});

describe('jsonParseOr', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns parsed value on valid JSON', () => {
    const result = jsonParseOr('{"a":1}', { a: 0 });
    expect(result).toEqual({ a: 1 });
  });

  it('returns fallback on invalid JSON', () => {
    const result = jsonParseOr('not json', 'default');
    expect(result).toBe('default');
  });

  it('returns fallback on empty string', () => {
    const result = jsonParseOr('', []);
    expect(result).toEqual([]);
  });

  it('logs error to console.error when context is provided and parsing fails', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    jsonParseOr('{bad}', null, 'session.json');
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toContain('[weaver]');
    expect(spy.mock.calls[0][0]).toContain('session.json');
  });

  it('does NOT log when context is omitted and parsing fails', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    jsonParseOr('{bad}', null);
    expect(spy).not.toHaveBeenCalled();
  });

  it('does NOT log when parsing succeeds even with context', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    jsonParseOr('{"ok":true}', null, 'test');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('parseNdjson', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses multiple valid NDJSON lines', () => {
    const input = '{"id":1}\n{"id":2}\n{"id":3}';
    const { records, errors } = parseNdjson<{ id: number }>(input);
    expect(records).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(errors).toBe(0);
  });

  it('skips empty lines', () => {
    const input = '{"id":1}\n\n\n{"id":2}\n';
    const { records, errors } = parseNdjson<{ id: number }>(input);
    expect(records).toEqual([{ id: 1 }, { id: 2 }]);
    expect(errors).toBe(0);
  });

  it('skips whitespace-only lines', () => {
    const input = '{"id":1}\n   \n{"id":2}';
    const { records, errors } = parseNdjson<{ id: number }>(input);
    expect(records).toEqual([{ id: 1 }, { id: 2 }]);
    expect(errors).toBe(0);
  });

  it('counts corrupt lines as errors and skips them', () => {
    const input = '{"id":1}\n{corrupt}\n{"id":3}';
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { records, errors } = parseNdjson<{ id: number }>(input);
    expect(records).toEqual([{ id: 1 }, { id: 3 }]);
    expect(errors).toBe(1);
    spy.mockRestore();
  });

  it('logs warning when context is provided and errors exist', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const input = '{"ok":true}\nbad line\nalso bad';
    const { records, errors } = parseNdjson(input, 'queue.ndjson');
    expect(records).toEqual([{ ok: true }]);
    expect(errors).toBe(2);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toContain('queue.ndjson');
    expect(spy.mock.calls[0][0]).toContain('2 corrupt line(s)');
  });

  it('does NOT log when context is provided but no errors', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    parseNdjson('{"ok":true}', 'queue.ndjson');
    expect(spy).not.toHaveBeenCalled();
  });

  it('does NOT log when errors exist but no context', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    parseNdjson('bad line');
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns empty records for completely empty input', () => {
    const { records, errors } = parseNdjson('');
    expect(records).toEqual([]);
    expect(errors).toBe(0);
  });

  it('returns empty records when all lines are corrupt', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { records, errors } = parseNdjson('bad\nalso bad\nstill bad');
    expect(records).toEqual([]);
    expect(errors).toBe(3);
    spy.mockRestore();
  });
});
