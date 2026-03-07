import type { GenesisCycleRecord, GenesisContext } from '../bot/types.js';

/**
 * Formats a genesis cycle summary for console output. Receives context
 * from either the success path or the fail path. Fires from any
 * incoming path.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Genesis Report
 * @executeWhen DISJUNCTION
 * @input [successCtx] [order:0] - Genesis context from success path (JSON)
 * @input [failCtx] [order:1] - Genesis context from fail path (JSON)
 * @output summary [order:1] - Formatted summary text
 * @output onFailure [hidden]
 */
export function genesisReport(successCtx?: string, failCtx?: string): { summary: string } {
  const ctx = successCtx ?? failCtx;
  if (!ctx) {
    const summary = 'Genesis cycle completed with no record';
    console.log(`\n\x1b[33m${summary}\x1b[0m\n`);
    return { summary };
  }

  const context = JSON.parse(ctx) as GenesisContext;

  if (context.error) {
    let summary = `Genesis cycle failed: ${context.error}`;
    if (context.applyResultJson) {
      try {
        const result = JSON.parse(context.applyResultJson) as { applied: number; failed: number; errors: string[] };
        summary += ` (applied: ${result.applied}, failed: ${result.failed})`;
      } catch { /* ignore parse errors */ }
    }
    console.log(`\n\x1b[31m${summary}\x1b[0m\n`);
    return { summary };
  }

  if (!context.cycleRecordJson) {
    const summary = 'Genesis cycle completed with no record';
    console.log(`\n\x1b[33m${summary}\x1b[0m\n`);
    return { summary };
  }

  const record = JSON.parse(context.cycleRecordJson) as GenesisCycleRecord;

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

  return { summary };
}
