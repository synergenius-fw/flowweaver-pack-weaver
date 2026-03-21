import * as path from 'node:path';
import type { GenesisConfig, GenesisProposal, GenesisContext } from '../bot/types.js';
import { callAI, parseJsonResponse } from '../bot/ai-client.js';
import { getGenesisSystemPrompt, getOperationExamples } from '../bot/genesis-prompt-context.js';

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
  const targetPath = path.resolve(env.projectDir, config.targetWorkflow);

  const systemPrompt = await getGenesisSystemPrompt(config, !!context.stabilized, {
    selfEvolveLocked: !!context.escrowGraceLocked,
    graceRemaining: context.escrowGraceRemaining ?? 0,
  });

  // Inject project intelligence
  let insightContext = '';
  try {
    const { getGenesisInsightContext } = await import('../bot/genesis-prompt-context.js');
    insightContext = await getGenesisInsightContext(env.projectDir);
  } catch { /* insights not available */ }

  const userPrompt = [
    '## Current Workflow Structure',
    context.workflowDescription || '(no description available)',
    '',
    ...(insightContext ? [insightContext, ''] : []),
    '## Project Diff Since Last Cycle',
    JSON.stringify(diff, null, 2),
    '',
    '## Current Fingerprint',
    context.fingerprintJson!,
    '',
    getOperationExamples(targetPath),
    '',
    'Propose workflow evolution operations within the budget. Use node IDs and port names that exist in the workflow structure above.',
  ].join('\n');

  const maxAttempts = 2;
  let lastError = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const text = await callAI(pInfo, systemPrompt, userPrompt, 8192);

      const proposal = parseJsonResponse(text) as unknown as GenesisProposal;
      console.log(`\x1b[36m→ Proposal: ${proposal.summary} (${proposal.operations.length} ops, impact=${proposal.impactLevel})\x1b[0m`);

      context.proposalJson = JSON.stringify(proposal);
      return { onSuccess: true, onFailure: false, ctx: JSON.stringify(context) };
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
      const isTransient = /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up/i.test(lastError);

      if (isTransient && attempt < maxAttempts) {
        console.log(`\x1b[33m→ Proposal attempt ${attempt} failed (transient): ${lastError.slice(0, 100)}. Retrying...\x1b[0m`);
        continue;
      }

      console.error(`\x1b[31m→ Proposal failed: ${lastError}\x1b[0m`);
    }
  }

  context.error = `Proposal failed: ${lastError}`;
  context.proposalJson = JSON.stringify({ operations: [], totalCost: 0, impactLevel: 'COSMETIC', summary: `Failed: ${lastError}`, rationale: '' });
  return { onSuccess: false, onFailure: true, ctx: JSON.stringify(context) };
}
