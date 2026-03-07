import type { GenesisConfig, GenesisProposal, GenesisImpactLevel, GenesisContext } from '../bot/types.js';

const IMPACT_ORDER: Record<GenesisImpactLevel, number> = {
  COSMETIC: 0,
  MINOR: 1,
  BREAKING: 2,
  CRITICAL: 3,
};

/**
 * Compares the proposal's impact level against the configured approval
 * threshold to decide if human approval is required.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Genesis Check Threshold
 * @input ctx [order:0] - Genesis context (JSON)
 * @output ctx [order:0] - Genesis context with approvalRequired (JSON)
 * @output onFailure [hidden]
 */
export function genesisCheckThreshold(ctx: string): { ctx: string } {
  const context = JSON.parse(ctx) as GenesisContext;
  const config = JSON.parse(context.genesisConfigJson) as GenesisConfig;
  const proposal = JSON.parse(context.proposalJson!) as GenesisProposal;

  const proposalLevel = IMPACT_ORDER[proposal.impactLevel] ?? 0;
  const thresholdLevel = IMPACT_ORDER[config.approvalThreshold] ?? 0;
  const approvalRequired = proposalLevel >= thresholdLevel;

  console.log(`\x1b[36m→ Impact ${proposal.impactLevel} vs threshold ${config.approvalThreshold}: approval ${approvalRequired ? 'required' : 'not required'}\x1b[0m`);

  context.approvalRequired = approvalRequired;
  return { ctx: JSON.stringify(context) };
}
