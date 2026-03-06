import type { WeaverEnv, GenesisConfig, GenesisProposal } from '../bot/types.js';
import { callCli, callApi, parseJsonResponse } from '../bot/ai-client.js';

/**
 * Sends project context and diff information to the AI provider, which
 * returns a structured proposal of workflow operations to apply.
 *
 * @flowWeaver nodeType
 * @label Genesis Propose
 * @input env [order:0] - Weaver environment bundle
 * @input genesisConfigJson [order:1] - Genesis configuration (JSON)
 * @input fingerprintJson [order:2] - Current fingerprint (JSON)
 * @input diffJson [order:3] - Diff summary (JSON)
 * @input stabilized [order:4] - Whether stabilize mode is active
 * @output env [order:0] - Weaver environment bundle (pass-through)
 * @output genesisConfigJson [order:1] - Genesis configuration (pass-through)
 * @output proposalJson [order:2] - Genesis proposal (JSON)
 * @output stabilized [order:3] - Whether stabilize mode is active (pass-through)
 * @output onSuccess [order:-2] - On Success
 * @output onFailure [order:-1] - On Failure
 */
export async function genesisPropose(
  execute: boolean,
  env: WeaverEnv,
  genesisConfigJson: string,
  fingerprintJson: string,
  diffJson: string,
  stabilized: boolean,
): Promise<{
  onSuccess: boolean; onFailure: boolean;
  env: WeaverEnv;
  genesisConfigJson: string;
  proposalJson: string;
  stabilized: boolean;
}> {
  if (!execute) {
    const empty: GenesisProposal = { operations: [], totalCost: 0, impactLevel: 'COSMETIC', summary: 'dry run', rationale: '' };
    return { onSuccess: true, onFailure: false, env, genesisConfigJson, proposalJson: JSON.stringify(empty), stabilized };
  }

  const { providerInfo: pInfo } = env;
  const config = JSON.parse(genesisConfigJson) as GenesisConfig;
  const diff = JSON.parse(diffJson);

  const stabilizeClause = stabilized
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
    fingerprintJson,
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
      text = callCli(pInfo.type, systemPrompt + '\n\n' + userPrompt);
    }

    const proposal = parseJsonResponse(text) as unknown as GenesisProposal;
    console.log(`\x1b[36m→ Proposal: ${proposal.summary} (${proposal.operations.length} ops, impact=${proposal.impactLevel})\x1b[0m`);

    return {
      onSuccess: true, onFailure: false,
      env, genesisConfigJson,
      proposalJson: JSON.stringify(proposal),
      stabilized,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m→ Proposal failed: ${msg}\x1b[0m`);
    return {
      onSuccess: false, onFailure: true,
      env, genesisConfigJson,
      proposalJson: JSON.stringify({ operations: [], totalCost: 0, impactLevel: 'COSMETIC', summary: `Failed: ${msg}`, rationale: '' }),
      stabilized,
    };
  }
}
