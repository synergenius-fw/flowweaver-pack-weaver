import { describe, it, expect, vi } from 'vitest';
import { isTransientError, withRetry } from '../src/bot/retry-utils.js';

describe('isTransientError', () => {
  it('detects HTTP 502', () => {
    expect(isTransientError(new Error('Anthropic API error 502: Bad Gateway'))).toBe(true);
  });

  it('detects HTTP 429', () => {
    expect(isTransientError(new Error('429 Too Many Requests'))).toBe(true);
  });

  it('detects HTTP 503', () => {
    expect(isTransientError(new Error('Service unavailable 503'))).toBe(true);
  });

  it('detects ETIMEDOUT', () => {
    const err = new Error('connect ETIMEDOUT');
    (err as NodeJS.ErrnoException).code = 'ETIMEDOUT';
    expect(isTransientError(err)).toBe(true);
  });

  it('detects ETIMEDOUT in message without code', () => {
    expect(isTransientError(new Error('spawnSync claude ETIMEDOUT'))).toBe(true);
  });

  it('detects ECONNRESET', () => {
    const err = new Error('socket hang up');
    (err as NodeJS.ErrnoException).code = 'ECONNRESET';
    expect(isTransientError(err)).toBe(true);
  });

  it('detects rate limit messages', () => {
    expect(isTransientError(new Error('Rate limit exceeded, please retry'))).toBe(true);
  });

  it('detects overloaded messages', () => {
    expect(isTransientError(new Error('API is overloaded'))).toBe(true);
  });

  it('detects exit code 143 (SIGTERM)', () => {
    expect(isTransientError(new Error('claude CLI exited with code 143'))).toBe(true);
  });

  it('rejects 401 auth errors', () => {
    expect(isTransientError(new Error('Anthropic API error 401: invalid x-api-key'))).toBe(false);
  });

  it('rejects 403 forbidden', () => {
    expect(isTransientError(new Error('403 Forbidden'))).toBe(false);
  });

  it('rejects parse errors', () => {
    expect(isTransientError(new Error('Failed to parse AI response as JSON'))).toBe(false);
  });

  it('rejects generic errors', () => {
    expect(isTransientError(new Error('Something went wrong'))).toBe(false);
  });

  it('handles string errors', () => {
    expect(isTransientError('502 bad gateway')).toBe(true);
    expect(isTransientError('unknown error')).toBe(false);
  });
});

describe('withRetry', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on transient error and succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('502 Bad Gateway'))
      .mockResolvedValue('ok');

    const onRetry = vi.fn();
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 1, onRetry });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Number), expect.any(Error));
  });

  it('does not retry on non-transient error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('401 Unauthorized'));

    await expect(withRetry(fn, { maxRetries: 3, baseDelayMs: 1 })).rejects.toThrow('401 Unauthorized');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('502 Bad Gateway'));

    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 1 })).rejects.toThrow('502 Bad Gateway');
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('calls onRetry with correct attempt numbers', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('502'))
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValue('ok');

    const onRetry = vi.fn();
    await withRetry(fn, { maxRetries: 3, baseDelayMs: 1, onRetry });

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][0]).toBe(1);
    expect(onRetry.mock.calls[1][0]).toBe(2);
  });

  it('uses exponential backoff delays', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('429'))
      .mockRejectedValueOnce(new Error('429'))
      .mockResolvedValue('ok');

    const onRetry = vi.fn();
    await withRetry(fn, { maxRetries: 3, baseDelayMs: 100, multiplier: 3, onRetry });

    // First retry: 100 * 3^0 = 100ms
    expect(onRetry.mock.calls[0][1]).toBe(100);
    // Second retry: 100 * 3^1 = 300ms
    expect(onRetry.mock.calls[1][1]).toBe(300);
  });
});
