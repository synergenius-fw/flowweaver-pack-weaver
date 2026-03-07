import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GenesisConfig, GenesisContext } from '../bot/types.js';
import { callCli, callApi, parseJsonResponse } from '../bot/ai-client.js';
import { GenesisStore } from '../bot/genesis-store.js';

/**
 * Scoped retry loop for apply + compile. Delegates the actual work to
 * a child node via the attempt callback, and between failures restores
 * the snapshot and asks the AI to revise the proposal.
 *
 * @flowWeaver nodeType
 * @label Genesis Apply Retry
 * @input ctx [order:0] - Genesis context (JSON)
 * @output attemptCtx scope:attempt [order:11] - Context for child (JSON)
 * @input attemptCtx scope:attempt [order:12] - Result context from child (JSON)
 * @output ctx [order:0] - Genesis context with applyResultJson (JSON)
 * @output onSuccess [order:-2] - On Success
 * @output onFailure [order:-1] - On Failure
 */
export async function genesisApplyRetry(
  execute: boolean,
  ctx: string,
  attempt: (
    start: boolean,
    attemptCtx: string,
  ) => { success: boolean; failure: boolean; attemptCtx: string },
): Promise<{
  onSuccess: boolean; onFailure: boolean;
  ctx: string;
}> {
  const context = JSON.parse(ctx) as GenesisContext;

  if (!execute) {
    const result = { applied: 0, failed: 0, errors: [] as string[] };
    context.applyResultJson = JSON.stringify(result);
    context.error = '';
    return { onSuccess: true, onFailure: false, ctx: JSON.stringify(context) };
  }

  const { env } = context;
  const maxAttempts = 3;
  let lastResult = '';
  let lastErrors = '';

  for (let i = 1; i <= maxAttempts; i++) {
    console.log(`\x1b[36m→ Apply attempt ${i}/${maxAttempts}\x1b[0m`);

    const outcome = attempt(true, JSON.stringify(context));
    const childCtx = JSON.parse(outcome.attemptCtx) as GenesisContext;
    lastResult = childCtx.applyResultJson ?? '';
    lastErrors = childCtx.error ?? '';

    if (outcome.success) {
      // Merge child results back
      context.applyResultJson = childCtx.applyResultJson;
      context.error = '';
      return { onSuccess: true, onFailure: false, ctx: JSON.stringify(context) };
    }

    if (i < maxAttempts) {
      console.log('\x1b[33m→ Requesting revised proposal from AI...\x1b[0m');

      const config = JSON.parse(context.genesisConfigJson) as GenesisConfig;
      const targetPath = path.resolve(env.projectDir, config.targetWorkflow);
      const store = new GenesisStore(env.projectDir);
      const snapshot = store.loadSnapshot(context.snapshotPath!);
      if (snapshot) {
        fs.writeFileSync(targetPath, snapshot, 'utf-8');
      }

      try {
        const revisedProposal = await reviseProposal(env, context.proposalJson!, lastErrors);
        context.proposalJson = revisedProposal;
        console.log('\x1b[36m→ Revised proposal received\x1b[0m');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`\x1b[31m→ AI revision failed: ${msg}\x1b[0m`);
        break;
      }
    }
  }

  const errorDesc = lastErrors
    ? `Apply/compile failed after ${maxAttempts} attempts. Last errors: ${lastErrors}`
    : `Apply failed after ${maxAttempts} attempts (all operations failed)`;

  context.applyResultJson = lastResult;
  context.error = errorDesc;
  return { onSuccess: false, onFailure: true, ctx: JSON.stringify(context) };
}

async function reviseProposal(
  env: GenesisContext['env'],
  currentProposal: string,
  compileErrors: string,
): Promise<string> {
  const { providerInfo: pInfo } = env;

  const systemPrompt = 'You are a workflow evolution engine. Return ONLY valid JSON matching the GenesisProposal schema (operations array with type, args, costUnits, rationale; totalCost; impactLevel; summary).';

  const userPrompt = [
    'The following proposal caused compile/validate errors when applied:',
    '',
    '## Current Proposal',
    currentProposal,
    '',
    '## Compile Errors',
    compileErrors,
    '',
    'Revise the proposal to fix these errors. Return the full revised proposal as JSON.',
  ].join('\n');

  let text: string;
  if (pInfo.type === 'anthropic') {
    text = await callApi(pInfo.apiKey!, pInfo.model ?? 'claude-sonnet-4-6', pInfo.maxTokens ?? 8192, systemPrompt, userPrompt);
  } else {
    text = callCli(pInfo.type, systemPrompt + '\n\n' + userPrompt);
  }

  const parsed = parseJsonResponse(text);
  return JSON.stringify(parsed);
}
