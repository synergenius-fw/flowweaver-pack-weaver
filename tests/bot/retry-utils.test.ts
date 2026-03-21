/**
 * Tests for src/bot/retry-utils.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isTransientError, withRetry } from '../../src/bot/retry-utils.js';

// ---------------------------------------------------------------------------
// isTransientError
// ---------------------------------------------------------------------------

describe('isTransientError — HTTP status codes in message', () => {
  it('returns true for 429 in message', () => {
    expect(isTransientError(new Error('HTTP 429 Too Many Requests'))).toBe(true);
  });

  it('returns true for 502 in message', () => {
    expect(isTransientError(new Error('Request failed with status 502'))).toBe(true);
  });

  it('returns true for 503 in message', () => {
    expect(isTransientError(new Error('503 Service Unavailable'))).toBe(true);
  });

  it('returns true for 504 in message', () => {
    expect(isTransientError(new Error('Got 504 from upstream'))).toBe(true);
  });

  it('returns false for 400 in message', () => {
    expect(isTransientError(new Error('HTTP 400 Bad Request'))).toBe(false);
  });

  it('returns false for 401 in message', () => {
    expect(isTransientError(new Error('401 Unauthorized'))).toBe(false);
  });

  it('returns false for 404 in message', () => {
    expect(isTransientError(new Error('404 Not Found'))).toBe(false);
  });

  it('returns true for 500 in message (treated as transient for retry)', () => {
    expect(isTransientError(new Error('500 Internal Server Error'))).toBe(true);
  });
});

describe('isTransientError — Node.js error codes on .code property', () => {
  function nodeError(message: string, code: string): Error {
    const err = new Error(message);
    (err as NodeJS.ErrnoException).code = code;
    return err;
  }

  it('returns true for ETIMEDOUT code', () => {
    expect(isTransientError(nodeError('connect ETIMEDOUT', 'ETIMEDOUT'))).toBe(true);
  });

  it('returns true for ECONNRESET code', () => {
    expect(isTransientError(nodeError('socket hang up', 'ECONNRESET'))).toBe(true);
  });

  it('returns true for ECONNREFUSED code', () => {
    expect(isTransientError(nodeError('connect ECONNREFUSED', 'ECONNREFUSED'))).toBe(true);
  });

  it('returns true for EPIPE code', () => {
    expect(isTransientError(nodeError('write EPIPE', 'EPIPE'))).toBe(true);
  });

  it('returns true for ENOTFOUND code', () => {
    expect(isTransientError(nodeError('getaddrinfo ENOTFOUND', 'ENOTFOUND'))).toBe(true);
  });

  it('returns false for ENOENT code', () => {
    const err = nodeError('no such file', 'ENOENT');
    expect(isTransientError(err)).toBe(false);
  });
});

describe('isTransientError — error code strings in message text', () => {
  it('returns true when message contains ETIMEDOUT', () => {
    expect(isTransientError(new Error('connect ETIMEDOUT 10.0.0.1:443'))).toBe(true);
  });

  it('returns true when message contains ECONNRESET', () => {
    expect(isTransientError(new Error('read ECONNRESET'))).toBe(true);
  });

  it('returns true when message contains ECONNREFUSED', () => {
    expect(isTransientError(new Error('connect ECONNREFUSED 127.0.0.1:5432'))).toBe(true);
  });

  it('returns true when message contains EPIPE', () => {
    expect(isTransientError(new Error('write EPIPE'))).toBe(true);
  });

  it('returns true when message contains ENOTFOUND', () => {
    expect(isTransientError(new Error('getaddrinfo ENOTFOUND api.example.com'))).toBe(true);
  });
});

describe('isTransientError — rate limit / overload phrases', () => {
  it('returns true for "rate limit" (case-insensitive)', () => {
    expect(isTransientError(new Error('You have exceeded the Rate Limit'))).toBe(true);
  });

  it('returns true for "too many requests"', () => {
    expect(isTransientError(new Error('Too Many Requests'))).toBe(true);
  });

  it('returns true for "overloaded"', () => {
    expect(isTransientError(new Error('The model is currently overloaded'))).toBe(true);
  });

  it('returns true for "bad gateway"', () => {
    expect(isTransientError(new Error('Bad Gateway from proxy'))).toBe(true);
  });

  it('returns true for "service unavailable"', () => {
    expect(isTransientError(new Error('Service Unavailable — try again later'))).toBe(true);
  });

  it('returns false for unrelated permanent error message', () => {
    expect(isTransientError(new Error('Invalid API key'))).toBe(false);
  });
});

describe('isTransientError — exit code 143 (SIGTERM)', () => {
  it('returns true for "exit code 143"', () => {
    expect(isTransientError(new Error('Process exited with exit code 143'))).toBe(true);
  });

  it('returns true for "exited with code 143"', () => {
    expect(isTransientError(new Error('Child process exited with code 143'))).toBe(true);
  });

  it('returns false for exit code 1', () => {
    expect(isTransientError(new Error('Process exited with exit code 1'))).toBe(false);
  });

  it('returns false for exit code 143 that is actually 1143', () => {
    // Contains "143" but not the exact phrases
    expect(isTransientError(new Error('exited with code 1143'))).toBe(false);
  });
});

describe('isTransientError — non-Error inputs', () => {
  it('handles plain string containing 429', () => {
    expect(isTransientError('HTTP 429')).toBe(true);
  });

  it('handles plain string with rate limit', () => {
    expect(isTransientError('rate limit exceeded')).toBe(true);
  });

  it('handles plain string with no match', () => {
    expect(isTransientError('something unknown happened')).toBe(false);
  });

  it('handles number input gracefully', () => {
    expect(isTransientError(42)).toBe(false);
  });

  it('handles null gracefully', () => {
    expect(isTransientError(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

describe('withRetry — success on first attempt', () => {
  it('resolves with the return value immediately', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { baseDelayMs: 0 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('withRetry — success after transient failures', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('retries once then succeeds', async () => {
    const transient = Object.assign(new Error('HTTP 429'), {});
    const fn = vi.fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce('done');

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 100, multiplier: 2 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('done');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries up to maxRetries times then succeeds', async () => {
    const transient = new Error('503 error');
    const fn = vi.fn()
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce('final');

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 10, multiplier: 2 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('final');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting maxRetries on transient errors', async () => {
    const transient = new Error('ETIMEDOUT');
    const fn = vi.fn().mockRejectedValue(transient);

    // Attach rejection handler BEFORE running timers to avoid unhandled rejection warning
    const assertion = expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 10, multiplier: 2 })).rejects.toThrow('ETIMEDOUT');
    await vi.runAllTimersAsync();
    await assertion;

    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});

describe('withRetry — permanent errors are not retried', () => {
  it('throws immediately on permanent error', async () => {
    const permanent = new Error('401 Unauthorized');
    const fn = vi.fn().mockRejectedValue(permanent);

    await expect(withRetry(fn, { maxRetries: 3, baseDelayMs: 0 })).rejects.toThrow('401 Unauthorized');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry on parse/validation errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('JSON parse error'));
    await expect(withRetry(fn, { baseDelayMs: 0 })).rejects.toThrow('JSON parse error');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('withRetry — onRetry callback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('calls onRetry with attempt number, delay, and error', async () => {
    const transient = new Error('502 Bad Gateway');
    const fn = vi.fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce('ok');

    const onRetry = vi.fn();
    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 100, multiplier: 2, onRetry });
    await vi.runAllTimersAsync();
    await promise;

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, 100, transient);
  });

  it('calls onRetry with increasing delays on successive retries', async () => {
    const transient = new Error('rate limit');
    const fn = vi.fn()
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce('done');

    const onRetry = vi.fn();
    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 100, multiplier: 3, onRetry });
    await vi.runAllTimersAsync();
    await promise;

    expect(onRetry).toHaveBeenCalledTimes(2);
    // attempt=1 → delay = 100 * 3^0 = 100
    expect(onRetry.mock.calls[0][1]).toBe(100);
    // attempt=2 → delay = 100 * 3^1 = 300
    expect(onRetry.mock.calls[1][1]).toBe(300);
  });

  it('does not call onRetry on permanent errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('404 Not Found'));
    const onRetry = vi.fn();
    await withRetry(fn, { maxRetries: 3, baseDelayMs: 0, onRetry }).catch(() => {});
    expect(onRetry).not.toHaveBeenCalled();
  });
});

describe('withRetry — defaults', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('defaults to maxRetries=3', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('429'));
    // Attach rejection handler BEFORE running timers to avoid unhandled rejection warning
    const assertion = expect(withRetry(fn)).rejects.toThrow();
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(4); // initial + 3 retries
  });
});
