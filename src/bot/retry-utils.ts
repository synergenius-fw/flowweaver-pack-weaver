/**
 * Retry utilities for transient error handling with exponential backoff.
 */

const TRANSIENT_STATUS_CODES = [429, 502, 503, 504];
const TRANSIENT_ERROR_CODES = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND'];
const TRANSIENT_MESSAGES = ['rate limit', 'too many requests', 'overloaded', 'bad gateway', 'service unavailable'];

/**
 * Check if an error is transient (retriable) vs permanent.
 * Transient: network issues, rate limits, server errors.
 * Permanent: auth failures, parse errors, validation errors.
 */
export function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  // Check for HTTP status codes in message
  for (const code of TRANSIENT_STATUS_CODES) {
    if (msg.includes(String(code))) return true;
  }

  // Check for Node.js error codes
  if (err instanceof Error && 'code' in err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code && TRANSIENT_ERROR_CODES.includes(code)) return true;
  }

  // Also check message for error code strings (e.g. "ETIMEDOUT" in message)
  for (const code of TRANSIENT_ERROR_CODES) {
    if (msg.includes(code)) return true;
  }

  // Check for rate limit / overload messages
  for (const phrase of TRANSIENT_MESSAGES) {
    if (lower.includes(phrase)) return true;
  }

  // Check for exit code 143 (SIGTERM — likely our timeout killed the process)
  if (msg.includes('exit code 143') || msg.includes('exited with code 143')) return true;

  return false;
}

/**
 * Run a function with exponential backoff retry on transient errors.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: {
    maxRetries?: number;
    baseDelayMs?: number;
    multiplier?: number;
    onRetry?: (attempt: number, delay: number, err: Error) => void;
  },
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3;
  const baseDelay = options?.baseDelayMs ?? 5_000;
  const multiplier = options?.multiplier ?? 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const isLast = attempt >= maxRetries;
      if (isLast || !isTransientError(err)) throw err;

      const delay = baseDelay * Math.pow(multiplier, attempt);
      options?.onRetry?.(attempt + 1, delay, err instanceof Error ? err : new Error(String(err)));
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // Unreachable, but TypeScript needs it
  throw new Error('withRetry: exhausted retries');
}
