import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GenesisConfig, GenesisContext } from '../bot/types.js';
import { callAI, parseJsonResponse } from '../bot/ai-client.js';
import { GenesisStore } from '../bot/genesis-store.js';
import { getGenesisSystemPrompt, getOperationExamples } from '../bot/genesis-prompt-context.js';

/**
 * Scoped retry loop for apply + compile. Delegates the actual work to
 * a child node via the attempt callback, and between failures restores
 * the snapshot and asks the AI to revise the proposal.
 *
 * @flowWeaver nodeType
 * @label Genesis Apply Retry
 * @input ctx [order:0] - Genesis context (JSON)
 * @output start scope:attempt [order:10] [hidden] - Trigger scope execution (boolean)
 * @output attemptCtx scope:attempt [order:11] - Context for child (JSON)
 * @input success scope:attempt [order:12] [hidden] - Success signal from child (boolean)
 * @input failure scope:attempt [order:13] [hidden] - Failure signal from child (boolean)
 * @input attemptCtx scope:attempt [order:14] - Result context from child (JSON)
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
  ) => Promise<{ success: boolean; failure: boolean; attemptCtx: string }>,
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

    const outcome = await attempt(true, JSON.stringify(context));
    const childCtx = JSON.parse(outcome.attemptCtx) as GenesisContext;
    lastResult = childCtx.applyResultJson ?? '';
    lastErrors = childCtx.error ?? '';

    if (outcome.success) {
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
        const revisedProposal = await reviseProposal(
          env, config, context.proposalJson!, lastErrors,
          targetPath, context.workflowDescription, !!context.stabilized,
        );
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
  config: GenesisConfig,
  currentProposal: string,
  compileErrors: string,
  targetPath: string,
  workflowDescription?: string,
  stabilized?: boolean,
): Promise<string> {
  const { providerInfo: pInfo } = env;

  const systemPrompt = await getGenesisSystemPrompt(config, !!stabilized);

  const userPrompt = [
    'The following proposal caused errors when applied. Revise it to fix these errors.',
    '',
    '## Current Workflow Structure',
    workflowDescription || '(no description available)',
    '',
    '## Failed Proposal',
    currentProposal,
    '',
    '## Errors',
    compileErrors,
    '',
    getOperationExamples(targetPath),
    '',
    'Return the full revised proposal as JSON. Use node IDs and port names that exist in the workflow structure above.',
  ].join('\n');

  const text = await callAI(pInfo, systemPrompt, userPrompt, 8192);

  const parsed = parseJsonResponse(text);
  return JSON.stringify(parsed);
}
