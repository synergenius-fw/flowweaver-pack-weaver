import type { WeaverEnv, GenesisConfig, GenesisProposal, GenesisImpactLevel } from '../bot/types.js';

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
 * @input env [order:0] - Weaver environment bundle
 * @input genesisConfigJson [order:1] - Genesis configuration (JSON)
 * @input proposalJson [order:2] - Genesis proposal (JSON)
 * @output env [order:0] - Weaver environment bundle (pass-through)
 * @output genesisConfigJson [order:1] - Genesis configuration (pass-through)
 * @output proposalJson [order:2] - Genesis proposal (pass-through)
 * @output approvalRequired [order:3] - Whether human approval is needed
 */
export function genesisCheckThreshold(
  env: WeaverEnv,
  genesisConfigJson: string,
  proposalJson: string,
): {
  env: WeaverEnv;
  genesisConfigJson: string;
  proposalJson: string;
  approvalRequired: boolean;
} {
  const config = JSON.parse(genesisConfigJson) as GenesisConfig;
  const proposal = JSON.parse(proposalJson) as GenesisProposal;

  const proposalLevel = IMPACT_ORDER[proposal.impactLevel] ?? 0;
  const thresholdLevel = IMPACT_ORDER[config.approvalThreshold] ?? 0;
  const approvalRequired = proposalLevel >= thresholdLevel;

  console.log(`\x1b[36m→ Impact ${proposal.impactLevel} vs threshold ${config.approvalThreshold}: approval ${approvalRequired ? 'required' : 'not required'}\x1b[0m`);

  return { env, genesisConfigJson, proposalJson, approvalRequired };
}
