/**
 * Actionable error guidance — maps cryptic error messages
 * to human-readable explanations with fix suggestions.
 */

const GUIDES: Array<{ pattern: RegExp; guidance: string }> = [
  { pattern: /ETIMEDOUT/i, guidance: 'Network timeout. Check internet connection or increase timeout with --timeout.' },
  { pattern: /ECONNRESET/i, guidance: 'Connection reset. The server closed the connection. Retry in a few seconds.' },
  { pattern: /ECONNREFUSED/i, guidance: 'Connection refused. Is the service running? Check the provider URL.' },
  { pattern: /401|authentication|invalid.*key/i, guidance: 'Authentication failed. Check ANTHROPIC_API_KEY or run "weaver init" to reconfigure.' },
  { pattern: /403|forbidden/i, guidance: 'Access denied. Your API key may not have permission for this model.' },
  { pattern: /429|rate.?limit|too many requests/i, guidance: 'Rate limited. Wait a few minutes or reduce --parallel.' },
  { pattern: /502|bad gateway/i, guidance: 'Server error (502). The API is temporarily unavailable. Will auto-retry.' },
  { pattern: /503|service unavailable|overloaded/i, guidance: 'Service overloaded. Will auto-retry with backoff.' },
  { pattern: /exit code 143/i, guidance: 'Process was killed (SIGTERM). Likely our timeout or Ctrl+C.' },
  { pattern: /exit code 137/i, guidance: 'Process was killed (OOM or SIGKILL). System may be low on memory.' },
  { pattern: /ENOMEM/i, guidance: 'Out of memory. Close other applications or increase available RAM.' },
  { pattern: /ENOSPC/i, guidance: 'Disk full. Free up disk space.' },
  { pattern: /lock.*retries|failed to acquire.*lock/i, guidance: 'File lock contention. Another weaver process may be running. Check with "ps aux | grep weaver".' },
  { pattern: /not a workflow|No @flowWeaver/i, guidance: 'File is not a Flow Weaver workflow. Ensure it has @flowWeaver annotations.' },
  { pattern: /parse.*json|unexpected token/i, guidance: 'JSON parse error. The AI may have returned malformed output. Retry the task.' },
  { pattern: /Queue full/i, guidance: 'Too many pending tasks (200 max). Process or clear existing tasks first.' },
];

/**
 * Get actionable guidance for an error message.
 * Returns null if no guidance is available.
 */
export function getErrorGuidance(msg: string): string | null {
  for (const { pattern, guidance } of GUIDES) {
    if (pattern.test(msg)) return guidance;
  }
  return null;
}
