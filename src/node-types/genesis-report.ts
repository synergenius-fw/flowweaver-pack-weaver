import type { WeaverEnv, GenesisCycleRecord } from '../bot/types.js';

/**
 * Formats a genesis cycle summary for console output. Handles both the
 * success path (with a cycle record) and the error path (with an error
 * string).
 *
 * @flowWeaver nodeType
 * @expression
 * @label Genesis Report
 * @executeWhen DISJUNCTION
 * @input env [order:0] - Weaver environment bundle
 * @input [cycleRecordJson] [order:1] - Cycle record (JSON, optional)
 * @input [error] [order:2] - Error message (optional)
 * @output env [order:0] - Weaver environment bundle (pass-through)
 * @output summary [order:1] - Formatted summary text
 */
export function genesisReport(
  env: WeaverEnv,
  cycleRecordJson?: string,
  error?: string,
): {
  env: WeaverEnv;
  summary: string;
} {
  if (error) {
    const summary = `Genesis cycle failed: ${error}`;
    console.log(`\n\x1b[31m${summary}\x1b[0m\n`);
    return { env, summary };
  }

  if (!cycleRecordJson) {
    const summary = 'Genesis cycle completed with no record';
    console.log(`\n\x1b[33m${summary}\x1b[0m\n`);
    return { env, summary };
  }

  const record = JSON.parse(cycleRecordJson) as GenesisCycleRecord;

  const parts: string[] = [
    `Cycle: ${record.id}`,
    `Outcome: ${record.outcome}`,
    `Duration: ${record.durationMs}ms`,
  ];

  if (record.proposal) {
    parts.push(`Operations: ${record.proposal.operations.length}`);
    parts.push(`Impact: ${record.proposal.impactLevel}`);
  }

  if (record.approved !== null) {
    parts.push(`Approved: ${record.approved}`);
  }

  if (record.error) {
    parts.push(`Errors: ${record.error}`);
  }

  const summary = parts.join(' | ');
  const color = record.outcome === 'applied' ? '\x1b[32m' : record.outcome === 'error' ? '\x1b[31m' : '\x1b[33m';

  console.log(`\n\x1b[1m${color}Genesis: ${summary}\x1b[0m\n`);

  return { env, summary };
}
