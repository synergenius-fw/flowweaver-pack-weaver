import type { GenesisConfig, GenesisProposal, GenesisOperation, GenesisContext } from '../bot/types.js';

const COST_MAP: Record<string, number> = {
  addNode: 1,
  removeNode: 1,
  addConnection: 1,
  removeConnection: 1,
  implementNode: 2,
  selfModifyWorkflow: 3,
  selfModifyNodeType: 2,
  selfModifyModule: 2,
};

const SELF_MODIFY_TYPES = new Set(['selfModifyWorkflow', 'selfModifyNodeType', 'selfModifyModule']);

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

  // Filter self-modify ops if selfEvolve is disabled
  if (!config.selfEvolve) {
    const before = ops.length;
    ops = ops.filter(op => !SELF_MODIFY_TYPES.has(op.type));
    if (ops.length < before) {
      console.log(`\x1b[33m→ Self-evolve disabled: filtered ${before - ops.length} self-modify operations\x1b[0m`);
    }
  }

  // Validate self-modify ops have required args
  ops = ops.filter(op => {
    if (SELF_MODIFY_TYPES.has(op.type)) {
      if (!op.args.file || !op.args.content) {
        console.log(`\x1b[33m→ Filtered ${op.type}: missing file or content\x1b[0m`);
        return false;
      }
    }
    return true;
  });

  // Recalculate costs (never trust the AI values)
  for (const op of ops) {
    op.costUnits = COST_MAP[op.type] ?? 1;
  }

  // Split into regular and self-modify ops for separate budget enforcement
  const regularOps = ops.filter(op => !SELF_MODIFY_TYPES.has(op.type));
  let selfOps = ops.filter(op => SELF_MODIFY_TYPES.has(op.type));

  // Trim regular ops to regular budget
  let regularCost = regularOps.reduce((sum, op) => sum + op.costUnits, 0);
  while (regularCost > config.budgetPerCycle && regularOps.length > 0) {
    regularOps.pop();
    regularCost = regularOps.reduce((sum, op) => sum + op.costUnits, 0);
  }

  // Trim self-modify ops to self-evolve budget
  const selfBudget = config.selfEvolveBudget ?? 2;
  let selfCost = selfOps.reduce((sum, op) => sum + op.costUnits, 0);
  while (selfCost > selfBudget && selfOps.length > 0) {
    selfOps.pop();
    selfCost = selfOps.reduce((sum, op) => sum + op.costUnits, 0);
  }

  ops = [...regularOps, ...selfOps];
  let totalCost = regularCost + selfCost;

  const validated: GenesisProposal = {
    ...proposal,
    operations: ops,
    totalCost,
  };

  console.log(`\x1b[36m→ Validated proposal: ${ops.length} ops, cost=${totalCost}/${config.budgetPerCycle}\x1b[0m`);

  context.proposalJson = JSON.stringify(validated);
  return { ctx: JSON.stringify(context) };
}
