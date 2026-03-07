import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { WeaverContext } from '../bot/types.js';
import { callCli, callApi, parseJsonResponse } from '../bot/ai-client.js';
import { executeStep } from '../bot/step-executor.js';
import { validateFiles } from '../bot/file-validator.js';

/**
 * Execute-validate-fix retry loop. Runs the plan, validates results,
 * and if validation fails, asks the AI for fixes. Up to 3 attempts.
 *
 * @flowWeaver nodeType
 * @label Execute & Validate
 * @input ctx [order:0] - Weaver context (JSON)
 * @output ctx [order:0] - Weaver context with results (JSON)
 * @output onSuccess [order:-2] - On Success
 * @output onFailure [order:-1] [hidden] - On Failure
 */
export async function weaverExecValidateRetry(
  execute: boolean,
  ctx: string,
): Promise<{
  onSuccess: boolean; onFailure: boolean;
  ctx: string;
}> {
  const context = JSON.parse(ctx) as WeaverContext;
  const { env } = context;

  if (!execute) {
    context.resultJson = JSON.stringify({ success: true, stepsCompleted: 0, stepsTotal: 0 });
    context.validationResultJson = '[]';
    context.filesModified = '[]';
    context.allValid = true;
    return { onSuccess: true, onFailure: false, ctx: JSON.stringify(context) };
  }

  const { providerInfo: pInfo, projectDir } = env;
  const maxAttempts = 3;
  let currentPlan = JSON.parse(context.planJson!);
  let allFilesModified: string[] = [];
  let lastExecResult: Record<string, unknown> = {};
  let lastValidation: Array<{ file: string; valid: boolean; errors: string[] }> = [];
  let allValid = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`\x1b[36m→ Attempt ${attempt}/${maxAttempts}\x1b[0m`);

    const execResult = executePlanSteps(currentPlan, projectDir);
    lastExecResult = execResult;
    allFilesModified = [...new Set([...allFilesModified, ...execResult.filesModified])];

    const validation = validateFiles(execResult.filesModified, projectDir);
    lastValidation = validation;
    allValid = validation.every(v => v.valid);

    if (allValid) {
      console.log('\x1b[32m→ All files valid\x1b[0m');
      break;
    }

    if (attempt < maxAttempts) {
      console.log(`\x1b[33m→ Validation errors found, requesting fix plan...\x1b[0m`);
      const errors = validation.filter(v => !v.valid).map(v => `${v.file}: ${v.errors.join(', ')}`).join('\n');

      try {
        let systemPrompt: string;
        try {
          const mod = await import('../bot/system-prompt.js');
          systemPrompt = await mod.buildSystemPrompt();
        } catch {
          systemPrompt = 'You are Weaver. Return ONLY valid JSON.';
        }

        const fixPrompt = `The following validation errors occurred:\n${errors}\n\nProvide a fix plan as JSON with steps and summary.`;

        let text: string;
        if (pInfo.type === 'anthropic') {
          text = await callApi(pInfo.apiKey!, pInfo.model ?? 'claude-sonnet-4-6', pInfo.maxTokens ?? 8192, systemPrompt, fixPrompt);
        } else {
          text = callCli(pInfo.type, systemPrompt + '\n\n' + fixPrompt);
        }

        currentPlan = parseJsonResponse(text);
        console.log(`\x1b[36m→ Fix plan: ${(currentPlan as { summary?: string }).summary ?? 'generated'}\x1b[0m`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`\x1b[31m→ Fix planning failed: ${msg}\x1b[0m`);
        break;
      }
    }
  }

  context.resultJson = JSON.stringify(lastExecResult);
  context.validationResultJson = JSON.stringify(lastValidation);
  context.filesModified = JSON.stringify(allFilesModified);
  context.allValid = allValid;

  return { onSuccess: allValid, onFailure: !allValid, ctx: JSON.stringify(context) };
}

function executePlanSteps(
  plan: { steps: Array<{ id: string; operation: string; description: string; args: Record<string, unknown> }> },
  projectDir: string,
): { success: boolean; filesModified: string[]; errors: string[]; stepsCompleted: number; stepsTotal: number } {
  const filesModified: string[] = [];
  const errors: string[] = [];
  let completed = 0;
  const steps = plan.steps ?? [];

  for (const step of steps) {
    const steering = checkSteeringSignal();
    if (steering === 'cancel') {
      errors.push(`Cancelled at step ${step.id}`);
      break;
    }

    try {
      const result = executeStep(step, projectDir);
      if (result.file) filesModified.push(result.file);
      if (result.files) filesModified.push(...result.files);
      completed++;
      console.log(`\x1b[32m  + ${step.id}: ${step.description}\x1b[0m`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${step.id}: ${msg}`);
      console.error(`\x1b[31m  x ${step.id}: ${msg}\x1b[0m`);
    }
  }

  return { success: errors.length === 0, filesModified: [...new Set(filesModified)], errors, stepsCompleted: completed, stepsTotal: steps.length };
}

function checkSteeringSignal(): 'cancel' | null {
  try {
    const controlPath = path.join(os.homedir(), '.weaver', 'control.json');
    if (!fs.existsSync(controlPath)) return null;
    const raw = fs.readFileSync(controlPath, 'utf-8');
    fs.unlinkSync(controlPath);
    const cmd = JSON.parse(raw) as { command: string };
    if (cmd.command === 'cancel') return 'cancel';
    return null;
  } catch {
    return null;
  }
}
