/**
 * Safe JSON parsing utilities.
 *
 * Wraps JSON.parse with proper error handling and optional context for
 * meaningful error messages. Prevents crashes from malformed config files,
 * corrupt NDJSON lines, or unexpected AI output.
 */

export type SafeParseResult<T> = {
  ok: true;
  value: T;
} | {
  ok: false;
  error: string;
};

/**
 * Parse JSON safely, returning a discriminated result instead of throwing.
 */
export function safeJsonParse<T = unknown>(
  text: string,
  context?: string,
): SafeParseResult<T> {
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const prefix = context ? `${context}: ` : '';
    return { ok: false, error: `${prefix}Invalid JSON — ${msg}` };
  }
}

/**
 * Parse JSON or return a fallback value on failure.
 * Optionally logs a warning when parsing fails.
 */
export function jsonParseOr<T>(
  text: string,
  fallback: T,
  context?: string,
): T {
  const result = safeJsonParse<T>(text, context);
  if (result.ok) return result.value;
  if (context) {
    console.error(`[weaver] ${result.error}`);
  }
  return fallback;
}

/**
 * Parse NDJSON (newline-delimited JSON) safely.
 * Skips corrupt lines and optionally reports them.
 */
export function parseNdjson<T>(
  content: string,
  context?: string,
): { records: T[]; errors: number } {
  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  const records: T[] = [];
  let errors = 0;

  for (const line of lines) {
    const result = safeJsonParse<T>(line);
    if (result.ok) {
      records.push(result.value);
    } else {
      errors++;
    }
  }

  if (errors > 0 && context) {
    console.error(`[weaver] ${context}: skipped ${errors} corrupt line(s)`);
  }

  return { records, errors };
}
