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
 * @input [failCtx] [order:1] - Genesis context from apply-retry fail path (JSON)
 * @input [proposeFailCtx] [order:2] - Genesis context from propose failure (JSON)
 * @input [commitFailCtx] [order:3] - Genesis context from commit failure (JSON)
 * @output summary [order:1] - Formatted summary text
 * @output onFailure [hidden]
 */
export function genesisReport(successCtx?: string, failCtx?: string, proposeFailCtx?: string, commitFailCtx?: string): { summary: string } {
  const ctx = successCtx ?? failCtx ?? proposeFailCtx ?? commitFailCtx;
  if (!ctx) {
    const summary = 'Genesis cycle completed with no record';
    console.log(`\n\x1b[33m${summary}\x1b[0m\n`);
    return { summary };
  }

  const context = JSON.parse(ctx) as GenesisContext;
  const elapsed = formatElapsed(context.startTimeMs);

  if (context.error) {
    const reason = categorizeFailure(context);
    let summary = `Genesis: ${reason}`;
    if (context.applyResultJson) {
      try {
        const result = JSON.parse(context.applyResultJson) as { applied: number; failed: number };
        summary += ` (applied: ${result.applied}, failed: ${result.failed})`;
      } catch (err) { if (process.env.WEAVER_VERBOSE) console.error('[genesis-report] applyResultJson parse failed:', err); }
    }
    summary += elapsed ? ` [${elapsed}]` : '';
    console.log(`\n\x1b[31m${summary}\x1b[0m\n`);
    return { summary };
  }

  if (!context.cycleRecordJson) {
    const summary = `Genesis: no changes proposed${elapsed ? ` [${elapsed}]` : ''}`;
    console.log(`\n\x1b[33m${summary}\x1b[0m\n`);
    return { summary };
  }

  const record = JSON.parse(context.cycleRecordJson) as GenesisCycleRecord;

  const parts: string[] = [`Cycle ${record.id}`];

  if (record.proposal) {
    parts.push(`${record.proposal.operations.length} ops`);
    parts.push(`impact=${record.proposal.impactLevel}`);
  }

  parts.push(record.outcome);

  if (record.approved !== null) {
    parts.push(record.approved ? 'approved' : 'rejected');
  }

  if (elapsed) parts.push(elapsed);

  if (record.error) {
    parts.push(record.error);
  }

  const summary = `Genesis: ${parts.join(' | ')}`;
  const color = record.outcome === 'applied' ? '\x1b[32m' : record.outcome === 'error' ? '\x1b[31m' : '\x1b[33m';

  console.log(`\n\x1b[1m${color}${summary}\x1b[0m\n`);

  return { summary };
}

function formatElapsed(startTimeMs?: number): string {
  if (!startTimeMs) return '';
  const seconds = (Date.now() - startTimeMs) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m${remaining.toFixed(0)}s`;
}

function categorizeFailure(context: GenesisContext): string {
  const err = context.error ?? '';
  if (err.startsWith('Proposal failed')) return 'proposal failed';
  if (err.includes('not approved') || err.includes('rejected')) return 'proposal rejected';
  if (err.startsWith('Commit failed')) return 'commit failed';
  if (err.includes('Apply') || err.includes('compile')) return 'apply/compile failed';
  return err.slice(0, 120);
}
