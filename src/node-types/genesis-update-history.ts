import type { GenesisFingerprint, GenesisProposal, GenesisCycleRecord, GenesisContext } from '../bot/types.js';
import { GenesisStore } from '../bot/genesis-store.js';

/**
 * Builds a cycle record from all available data, determines the outcome,
 * appends it to the genesis history, and saves the current fingerprint.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Genesis Update History
 * @input ctx [order:0] - Genesis context (JSON)
 * @output ctx [order:0] - Genesis context with cycleRecordJson (JSON)
 * @output onFailure [hidden]
 */
export function genesisUpdateHistory(ctx: string): { ctx: string } {
  const context = JSON.parse(ctx) as GenesisContext;
  const { env } = context;

  const fingerprint = context.fingerprintJson
    ? JSON.parse(context.fingerprintJson) as GenesisFingerprint
    : null;
  const proposal = context.proposalJson ? JSON.parse(context.proposalJson) as GenesisProposal : null;
  const applyResult = context.applyResultJson ? JSON.parse(context.applyResultJson) as { applied: number; failed: number; errors: string[] } : null;

  const durationMs = context.startTimeMs ? Date.now() - context.startTimeMs : 0;

  // Determine outcome
  let outcome: GenesisCycleRecord['outcome'];
  if (context.error) {
    outcome = 'error';
  } else if (!proposal || proposal.operations.length === 0) {
    outcome = 'no-change';
  } else if (context.approved === false) {
    outcome = 'rejected';
  } else if (applyResult && applyResult.failed > 0) {
    outcome = 'rolled-back';
  } else if (context.approved === true && applyResult && applyResult.failed === 0) {
    outcome = 'applied';
  } else {
    outcome = 'error';
  }

  const record: GenesisCycleRecord = {
    id: context.cycleId,
    timestamp: new Date().toISOString(),
    durationMs,
    fingerprint: fingerprint!,
    proposal,
    outcome,
    diffSummary: proposal?.summary ?? null,
    approvalRequired: context.approved !== undefined,
    approved: context.approved ?? null,
    error: context.error ?? (applyResult?.errors?.length ? applyResult.errors.join('; ') : null),
    snapshotFile: context.snapshotPath ?? null,
  };

  try {
    const store = new GenesisStore(env.projectDir);
    store.appendCycle(record);
    if (fingerprint) {
      store.saveFingerprint(fingerprint);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m→ Failed to save history: ${msg}\x1b[0m`);
  }

  console.log(`\x1b[36m→ Cycle ${context.cycleId}: ${outcome} (${durationMs}ms)\x1b[0m`);

  context.cycleRecordJson = JSON.stringify(record);
  return { ctx: JSON.stringify(context) };
}
