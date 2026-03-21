/**
 * Unified error classification — merges error-guide.ts and retry-utils.ts
 * into a single source of truth for error handling.
 */

export interface ErrorClassification {
  isTransient: boolean;
  guidance: string | null;
  category: 'auth' | 'network' | 'rate-limit' | 'timeout' | 'parse' | 'system' | 'unknown';
}

const PATTERNS: Array<{ pattern: RegExp; isTransient: boolean; guidance: string; category: ErrorClassification['category'] }> = [
  { pattern: /ETIMEDOUT/i, isTransient: true, guidance: 'Network timeout. Check internet or increase timeout.', category: 'timeout' },
  { pattern: /ECONNRESET/i, isTransient: true, guidance: 'Connection reset. Retry in a few seconds.', category: 'network' },
  { pattern: /ECONNREFUSED/i, isTransient: true, guidance: 'Connection refused. Is the service running?', category: 'network' },
  { pattern: /EPIPE|ENOTFOUND/i, isTransient: true, guidance: 'Network error.', category: 'network' },
  { pattern: /401|authentication|invalid.*key/i, isTransient: false, guidance: 'Authentication failed. Check API key or run "weaver init".', category: 'auth' },
  { pattern: /403|forbidden/i, isTransient: false, guidance: 'Access denied. API key may lack permissions.', category: 'auth' },
  { pattern: /429|rate.?limit|too many requests/i, isTransient: true, guidance: 'Rate limited. Wait a few minutes or reduce --parallel.', category: 'rate-limit' },
  { pattern: /502|bad gateway/i, isTransient: true, guidance: 'Server error (502). Will auto-retry.', category: 'network' },
  { pattern: /503|service unavailable|overloaded/i, isTransient: true, guidance: 'Service overloaded. Will auto-retry.', category: 'network' },
  { pattern: /504|gateway timeout/i, isTransient: true, guidance: 'Gateway timeout (504). Will auto-retry.', category: 'timeout' },
  { pattern: /exit(?:ed with)? code 143/i, isTransient: true, guidance: 'Process killed (SIGTERM). Likely timeout or Ctrl+C.', category: 'timeout' },
  { pattern: /exit code 137/i, isTransient: false, guidance: 'Process killed (OOM). System may be low on memory.', category: 'system' },
  { pattern: /ENOMEM/i, isTransient: false, guidance: 'Out of memory.', category: 'system' },
  { pattern: /ENOSPC/i, isTransient: false, guidance: 'Disk full.', category: 'system' },
  { pattern: /lock.*retries|failed to acquire.*lock/i, isTransient: true, guidance: 'File lock contention. Another weaver process may be running.', category: 'system' },
  { pattern: /not a workflow|No @flowWeaver/i, isTransient: false, guidance: 'Not a Flow Weaver workflow. Ensure @flowWeaver annotations exist.', category: 'parse' },
  { pattern: /parse.*json|unexpected token/i, isTransient: false, guidance: 'JSON parse error. AI may have returned malformed output.', category: 'parse' },
  { pattern: /Queue full/i, isTransient: false, guidance: 'Too many pending tasks (200 max). Process or clear first.', category: 'system' },
];

/**
 * Classify an error into transient/permanent with guidance and category.
 */
export function classifyError(err: unknown): ErrorClassification {
  const msg = err instanceof Error ? err.message : String(err);
  // Also check Node.js error codes
  const code = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
  const fullMsg = code ? `${msg} ${code}` : msg;

  for (const p of PATTERNS) {
    if (p.pattern.test(fullMsg)) {
      return { isTransient: p.isTransient, guidance: p.guidance, category: p.category };
    }
  }
  return { isTransient: false, guidance: null, category: 'unknown' };
}

/** Convenience: check if an error is transient (retriable). */
export function isTransientError(err: unknown): boolean {
  return classifyError(err).isTransient;
}

/** Convenience: get actionable guidance for an error message. */
export function getErrorGuidance(msg: string): string | null {
  return classifyError(new Error(msg)).guidance;
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
