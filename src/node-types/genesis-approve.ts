import type { WeaverEnv, GenesisProposal } from '../bot/types.js';

/**
 * Handles approval for genesis proposals. Auto-approves when approval
 * is not required or when config approval mode is 'auto'. Otherwise
 * displays the proposal summary and diff, then rejects (non-interactive
 * environments cannot prompt).
 *
 * @flowWeaver nodeType
 * @label Genesis Approve
 * @input env [order:0] - Weaver environment bundle
 * @input genesisConfigJson [order:1] - Genesis configuration (JSON)
 * @input proposalJson [order:2] - Genesis proposal (JSON)
 * @input workflowDiffJson [order:3] - Workflow diff (JSON)
 * @input approvalRequired [order:4] - Whether approval is needed
 * @output env [order:0] - Weaver environment bundle (pass-through)
 * @output genesisConfigJson [order:1] - Genesis configuration (pass-through)
 * @output proposalJson [order:2] - Genesis proposal (pass-through)
 * @output approved [order:3] - Whether the proposal was approved
 * @output onSuccess [order:-2] - On Success
 * @output onFailure [order:-1] - On Failure
 */
export async function genesisApprove(
  execute: boolean,
  env: WeaverEnv,
  genesisConfigJson: string,
  proposalJson: string,
  workflowDiffJson: string,
  approvalRequired: boolean,
): Promise<{
  onSuccess: boolean; onFailure: boolean;
  env: WeaverEnv;
  genesisConfigJson: string;
  proposalJson: string;
  approved: boolean;
}> {
  if (!execute) {
    return { onSuccess: true, onFailure: false, env, genesisConfigJson, proposalJson, approved: true };
  }

  // Auto-approve when approval is not required
  if (!approvalRequired) {
    console.log('\x1b[32m→ Auto-approved (below threshold)\x1b[0m');
    return { onSuccess: true, onFailure: false, env, genesisConfigJson, proposalJson, approved: true };
  }

  const { config } = env;
  const approvalMode = typeof config.approval === 'string' ? config.approval : config.approval?.mode ?? 'prompt';

  // Display proposal summary
  const proposal = JSON.parse(proposalJson) as GenesisProposal;
  const diffData = JSON.parse(workflowDiffJson) as { diff: string };

  console.log('\n\x1b[1m┌─ Genesis Proposal ─────────────────────┐\x1b[0m');
  console.log(`\x1b[1m│\x1b[0m Impact: ${proposal.impactLevel}`);
  console.log(`\x1b[1m│\x1b[0m Summary: ${proposal.summary}`);
  console.log(`\x1b[1m│\x1b[0m Operations: ${proposal.operations.length} (cost: ${proposal.totalCost})`);
  for (const op of proposal.operations) {
    console.log(`\x1b[1m│\x1b[0m  ${op.type}: ${op.rationale}`);
  }
  console.log('\x1b[1m├─ Diff ─────────────────────────────────┤\x1b[0m');
  for (const line of diffData.diff.split('\n').slice(0, 20)) {
    console.log(`\x1b[1m│\x1b[0m ${line}`);
  }
  console.log('\x1b[1m└────────────────────────────────────────┘\x1b[0m\n');

  // Auto mode approves automatically
  if (approvalMode === 'auto') {
    console.log('\x1b[32m→ Auto-approved (approval mode: auto)\x1b[0m');
    return { onSuccess: true, onFailure: false, env, genesisConfigJson, proposalJson, approved: true };
  }

  // Non-auto modes reject in non-interactive context
  console.log('\x1b[33m→ Rejected (approval required, non-auto mode)\x1b[0m');
  return { onSuccess: true, onFailure: false, env, genesisConfigJson, proposalJson, approved: false };
}
