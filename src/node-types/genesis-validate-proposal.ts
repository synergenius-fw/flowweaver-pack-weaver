import type { WeaverEnv, GenesisConfig, GenesisProposal, GenesisOperation } from '../bot/types.js';

const COST_MAP: Record<string, number> = {
  addNode: 1,
  removeNode: 1,
  addConnection: 1,
  removeConnection: 1,
  implementNode: 2,
};

/**
 * Validates and trims a genesis proposal to fit within the budget.
 * Recalculates costs (never trusts the AI), filters out disallowed
 * operations in stabilize mode, and trims from the end if over budget.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Genesis Validate Proposal
 * @input env [order:0] - Weaver environment bundle
 * @input genesisConfigJson [order:1] - Genesis configuration (JSON)
 * @input proposalJson [order:2] - Genesis proposal (JSON)
 * @input stabilized [order:3] - Whether stabilize mode is active
 * @output env [order:0] - Weaver environment bundle (pass-through)
 * @output genesisConfigJson [order:1] - Genesis configuration (pass-through)
 * @output proposalJson [order:2] - Validated/trimmed proposal (JSON)
 * @output stabilized [order:3] - Whether stabilize mode is active (pass-through)
 */
export function genesisValidateProposal(
  env: WeaverEnv,
  genesisConfigJson: string,
  proposalJson: string,
  stabilized: boolean,
): {
  env: WeaverEnv;
  genesisConfigJson: string;
  proposalJson: string;
  stabilized: boolean;
} {
  const config = JSON.parse(genesisConfigJson) as GenesisConfig;
  const proposal = JSON.parse(proposalJson) as GenesisProposal;

  let ops = proposal.operations;

  // In stabilize mode, hard-reject addNode and addConnection
  if (stabilized) {
    const before = ops.length;
    ops = ops.filter(op => op.type !== 'addNode' && op.type !== 'addConnection');
    if (ops.length < before) {
      console.log(`\x1b[33m→ Stabilize: filtered ${before - ops.length} disallowed operations\x1b[0m`);
    }
  }

  // Recalculate costs (never trust the AI values)
  for (const op of ops) {
    op.costUnits = COST_MAP[op.type] ?? 1;
  }

  // Trim from end if over budget
  let totalCost = ops.reduce((sum, op) => sum + op.costUnits, 0);
  while (totalCost > config.budgetPerCycle && ops.length > 0) {
    ops.pop();
    totalCost = ops.reduce((sum, op) => sum + op.costUnits, 0);
  }

  const validated: GenesisProposal = {
    ...proposal,
    operations: ops,
    totalCost,
  };

  console.log(`\x1b[36m→ Validated proposal: ${ops.length} ops, cost=${totalCost}/${config.budgetPerCycle}\x1b[0m`);

  return {
    env, genesisConfigJson,
    proposalJson: JSON.stringify(validated),
    stabilized,
  };
}
