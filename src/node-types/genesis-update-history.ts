import type { WeaverEnv, GenesisFingerprint, GenesisProposal, GenesisCycleRecord } from '../bot/types.js';
import { GenesisStore } from '../bot/genesis-store.js';

/**
 * Builds a cycle record from all available data, determines the outcome,
 * appends it to the genesis history, and saves the current fingerprint.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Genesis Update History
 * @input env [order:0] - Weaver environment bundle
 * @input genesisConfigJson [order:1] - Genesis configuration (JSON)
 * @input cycleId [order:2] - Cycle identifier
 * @input fingerprintJson [order:3] - Current fingerprint (JSON)
 * @input [proposalJson] [order:4] - Genesis proposal (JSON, optional)
 * @input [snapshotPath] [order:5] - Path to the snapshot (optional)
 * @input [approved] [order:6] - Whether approved (optional)
 * @input [applyResultJson] [order:7] - Apply result (JSON, optional)
 * @input [startTimeMs] [order:8] - Cycle start time in milliseconds (optional)
 * @output env [order:0] - Weaver environment bundle (pass-through)
 * @output cycleRecordJson [order:1] - Cycle record (JSON)
 */
export function genesisUpdateHistory(
  env: WeaverEnv,
  genesisConfigJson: string,
  cycleId: string,
  fingerprintJson: string,
  proposalJson?: string,
  snapshotPath?: string,
  approved?: boolean,
  applyResultJson?: string,
  startTimeMs?: number,
): {
  env: WeaverEnv;
  cycleRecordJson: string;
} {
  const fingerprint = JSON.parse(fingerprintJson) as GenesisFingerprint;
  const proposal = proposalJson ? JSON.parse(proposalJson) as GenesisProposal : null;
  const applyResult = applyResultJson ? JSON.parse(applyResultJson) as { applied: number; failed: number; errors: string[] } : null;

  const durationMs = startTimeMs ? Date.now() - startTimeMs : 0;

  // Determine outcome
  let outcome: GenesisCycleRecord['outcome'];
  if (!proposal || proposal.operations.length === 0) {
    outcome = 'no-change';
  } else if (approved === false) {
    outcome = 'rejected';
  } else if (applyResult && applyResult.failed > 0) {
    outcome = 'rolled-back';
  } else if (approved === true && applyResult && applyResult.failed === 0) {
    outcome = 'applied';
  } else {
    outcome = 'error';
  }

  const record: GenesisCycleRecord = {
    id: cycleId,
    timestamp: new Date().toISOString(),
    durationMs,
    fingerprint,
    proposal,
    outcome,
    diffSummary: proposal?.summary ?? null,
    approvalRequired: approved !== undefined,
    approved: approved ?? null,
    error: applyResult?.errors?.length ? applyResult.errors.join('; ') : null,
    snapshotFile: snapshotPath ?? null,
  };

  const store = new GenesisStore(env.projectDir);
  store.appendCycle(record);
  store.saveFingerprint(fingerprint);

  console.log(`\x1b[36m→ Cycle ${cycleId}: ${outcome} (${durationMs}ms)\x1b[0m`);

  return { env, cycleRecordJson: JSON.stringify(record) };
}
