import type { GenesisProposal, GenesisContext } from '../bot/types.js';

/**
 * Handles approval for genesis proposals. Auto-approves when approval
 * is not required or when config approval mode is 'auto'. Otherwise
 * displays the proposal summary and diff, then rejects (non-interactive
 * environments cannot prompt).
 *
 * @flowWeaver nodeType
 * @label Genesis Approve
 * @input ctx [order:0] - Genesis context (JSON)
 * @output ctx [order:0] - Genesis context with approved (JSON)
 * @output onSuccess [order:-2] - On Success
 * @output onFailure [order:-1] [hidden] - On Failure
 */
export async function genesisApprove(
  execute: boolean,
  ctx: string,
): Promise<{
  onSuccess: boolean; onFailure: boolean;
  ctx: string;
}> {
  const context = JSON.parse(ctx) as GenesisContext;

  if (!execute) {
    context.approved = true;
    return { onSuccess: true, onFailure: false, ctx: JSON.stringify(context) };
  }

  // Auto-approve when approval is not required
  if (!context.approvalRequired) {
    console.log('\x1b[32m→ Auto-approved (below threshold)\x1b[0m');
    context.approved = true;
    return { onSuccess: true, onFailure: false, ctx: JSON.stringify(context) };
  }

  const { config } = context.env;
  // Match the same default as runner.ts resolveApproval: no approval field = 'auto'
  const approvalMode = !config.approval || config.approval === 'auto'
    ? 'auto'
    : typeof config.approval === 'string'
      ? config.approval
      : config.approval.mode;

  // Display proposal summary
  const proposal = JSON.parse(context.proposalJson!) as GenesisProposal;
  const diffData = JSON.parse(context.workflowDiffJson!) as { diff: string };

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
    context.approved = true;
    return { onSuccess: true, onFailure: false, ctx: JSON.stringify(context) };
  }

  // Non-auto modes reject in non-interactive context
  console.log('\x1b[33m→ Rejected (approval required, non-auto mode)\x1b[0m');
  context.approved = false;
  return { onSuccess: true, onFailure: false, ctx: JSON.stringify(context) };
}
