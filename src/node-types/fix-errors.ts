import type { WeaverEnv } from '../bot/types.js';
import { callAI, parseJsonResponse } from '../bot/ai-client.js';

/**
 * When validation fails, sends errors + context to the AI and
 * asks it to produce a repair plan.
 *
 * @flowWeaver nodeType
 * @label Fix Errors
 * @input env [order:0] - Weaver environment bundle
 * @input validationResultJson [order:1] - Validation results (JSON)
 * @input taskJson [order:2] - Task (JSON, pass-through)
 * @output env [order:0] - Weaver environment bundle (pass-through)
 * @output fixPlanJson [order:1] - Fix plan (JSON, same schema as planJson)
 * @output taskJson [order:2] - Task (pass-through)
 * @output onSuccess [order:-2] - On Success
 * @output onFailure [order:-1] - On Failure
 */
export async function weaverFixErrors(
  execute: boolean,
  env: WeaverEnv,
  validationResultJson: string,
  taskJson: string,
): Promise<{
  onSuccess: boolean; onFailure: boolean;
  env: WeaverEnv;
  fixPlanJson: string; taskJson: string;
}> {
  if (!execute) {
    return { onSuccess: true, onFailure: false, env, taskJson, fixPlanJson: '{"steps":[],"summary":"dry run"}' };
  }

  const { providerInfo: pInfo } = env;
  const validation = JSON.parse(validationResultJson) as Array<{ file: string; valid: boolean; errors: string[] }>;
  const errors = validation.filter(v => !v.valid);

  if (errors.length === 0) {
    return { onSuccess: true, onFailure: false, env, taskJson, fixPlanJson: '{"steps":[],"summary":"no errors to fix"}' };
  }

  let systemPrompt: string;
  try {
    const mod = await import('../bot/system-prompt.js');
    systemPrompt = await mod.buildSystemPrompt();
  } catch {
    systemPrompt = 'You are Weaver. Return ONLY valid JSON.';
  }

  const errorSummary = errors.map(e => `${e.file}: ${e.errors.join(', ')}`).join('\n');
  const userPrompt = `The following validation errors occurred:
${errorSummary}

Provide a fix plan as JSON: {"steps": [...], "summary": "..."}

Each step MUST have: "id" (string), "operation" (string), "description" (string), "args" (object).

Available operations for fixes:
- patch-file: Surgical find-and-replace. args: { "file": "path", "patches": [{ "find": "old text", "replace": "new text" }] }
  PREFERRED for fixing @input annotations. Example: { "find": "@input portName", "replace": "@input [portName]" }
- run-shell: Execute a command. args: { "command": "..." }
- read-file: Read file content. args: { "file": "path" }

Return ONLY valid JSON. No explanation outside the JSON.`;

  try {
    const text = await callAI(pInfo, systemPrompt, userPrompt, 8192);

    const plan = parseJsonResponse(text);
    console.log(`\x1b[36m→ Fix plan: ${(plan as { summary?: string }).summary ?? 'generated'}\x1b[0m`);
    return { onSuccess: true, onFailure: false, env, taskJson, fixPlanJson: JSON.stringify(plan) };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m→ Fix planning failed: ${msg}\x1b[0m`);
    return { onSuccess: false, onFailure: true, env, taskJson, fixPlanJson: JSON.stringify({ steps: [], summary: `Fix failed: ${msg}` }) };
  }
}
