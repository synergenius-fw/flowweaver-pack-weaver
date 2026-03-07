import type { GenesisConfig, GenesisProposal, GenesisContext } from '../bot/types.js';
import { callCli, callApi, parseJsonResponse } from '../bot/ai-client.js';

/**
 * Sends project context and diff information to the AI provider, which
 * returns a structured proposal of workflow operations to apply.
 *
 * @flowWeaver nodeType
 * @label Genesis Propose
 * @input ctx [order:0] - Genesis context (JSON)
 * @output ctx [order:0] - Genesis context with proposalJson (JSON)
 * @output onSuccess [order:-2] - On Success
 * @output onFailure [order:-1] [hidden] - On Failure
 */
export async function genesisPropose(
  execute: boolean,
  ctx: string,
): Promise<{
  onSuccess: boolean; onFailure: boolean;
  ctx: string;
}> {
  const context = JSON.parse(ctx) as GenesisContext;
  const { env } = context;

  if (!execute) {
    const empty: GenesisProposal = { operations: [], totalCost: 0, impactLevel: 'COSMETIC', summary: 'dry run', rationale: '' };
    context.proposalJson = JSON.stringify(empty);
    return { onSuccess: true, onFailure: false, ctx: JSON.stringify(context) };
  }

  const { providerInfo: pInfo } = env;
  const config = JSON.parse(context.genesisConfigJson) as GenesisConfig;
  const diff = JSON.parse(context.diffJson!);

  const stabilizeClause = context.stabilized
    ? '\n\nSTABILIZE MODE: Only removeNode, removeConnection, and implementNode operations are allowed. Do NOT propose addNode or addConnection.'
    : '';

  const systemPrompt = [
    'You are Genesis, a workflow self-evolution engine.',
    `Intent: ${config.intent}`,
    config.focus.length > 0 ? `Focus areas: ${config.focus.join(', ')}` : '',
    config.constraints.length > 0 ? `Constraints: ${config.constraints.join(', ')}` : '',
    `Budget: ${config.budgetPerCycle} cost units per cycle.`,
    'Cost map: addNode=1, removeNode=1, addConnection=1, removeConnection=1, implementNode=2.',
    stabilizeClause,
    '',
    'Return a JSON object with: operations (array of {type, args, costUnits, rationale}), totalCost (number), impactLevel ("COSMETIC"|"MINOR"|"BREAKING"|"CRITICAL"), summary (string), rationale (string).',
  ].filter(Boolean).join('\n');

  const userPrompt = [
    'Project diff since last cycle:',
    JSON.stringify(diff, null, 2),
    '',
    'Current fingerprint:',
    context.fingerprintJson!,
    '',
    'Propose workflow evolution operations within the budget.',
  ].join('\n');

  try {
    let text: string;
    if (pInfo.type === 'anthropic') {
      text = await callApi(
        pInfo.apiKey!,
        pInfo.model ?? 'claude-sonnet-4-6',
        pInfo.maxTokens ?? 8192,
        systemPrompt,
        userPrompt,
      );
    } else {
      text = callCli(pInfo.type, systemPrompt + '\n\n' + userPrompt, pInfo.model);
    }

    const proposal = parseJsonResponse(text) as unknown as GenesisProposal;
    console.log(`\x1b[36m→ Proposal: ${proposal.summary} (${proposal.operations.length} ops, impact=${proposal.impactLevel})\x1b[0m`);

    context.proposalJson = JSON.stringify(proposal);
    return { onSuccess: true, onFailure: false, ctx: JSON.stringify(context) };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m→ Proposal failed: ${msg}\x1b[0m`);
    context.proposalJson = JSON.stringify({ operations: [], totalCost: 0, impactLevel: 'COSMETIC', summary: `Failed: ${msg}`, rationale: '' });
    return { onSuccess: false, onFailure: true, ctx: JSON.stringify(context) };
  }
}
