import type { GenesisConfig, GenesisProposal, GenesisOperation, GenesisContext } from '../bot/types.js';

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
 * @input ctx [order:0] - Genesis context (JSON)
 * @output ctx [order:0] - Genesis context with validated proposalJson (JSON)
 * @output onFailure [hidden]
 */
export function genesisValidateProposal(ctx: string): { ctx: string } {
  const context = JSON.parse(ctx) as GenesisContext;
  const config = JSON.parse(context.genesisConfigJson) as GenesisConfig;
  const proposal = JSON.parse(context.proposalJson!) as GenesisProposal;

  let ops = proposal.operations;

  // In stabilize mode, hard-reject addNode and addConnection
  if (context.stabilized) {
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

  context.proposalJson = JSON.stringify(validated);
  return { ctx: JSON.stringify(context) };
}
