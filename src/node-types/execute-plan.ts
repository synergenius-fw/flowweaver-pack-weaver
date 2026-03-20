import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { WeaverEnv } from '../bot/types.js';
import { executeStep, resetPlanFileCounter } from '../bot/step-executor.js';

/**
 * Executes plan steps via the flow-weaver CLI. Checks steering
 * between steps.
 *
 * @flowWeaver nodeType
 * @label Execute Plan
 * @input env [order:0] - Weaver environment bundle
 * @input planJson [order:1] - Plan (JSON)
 * @input taskJson [order:2] - Task (JSON)
 * @output env [order:0] - Weaver environment bundle (pass-through)
 * @output executionResultJson [order:1] - Execution result (JSON)
 * @output taskJson [order:2] - Task (pass-through)
 * @output filesModified [order:3] - Files modified (JSON array)
 * @output onSuccess [order:-2] - On Success
 * @output onFailure [order:-1] - On Failure
 */
export async function weaverExecutePlan(
  execute: boolean,
  env: WeaverEnv,
  planJson: string,
  taskJson: string,
): Promise<{
  onSuccess: boolean; onFailure: boolean;
  env: WeaverEnv;
  executionResultJson: string; taskJson: string; filesModified: string;
}> {
  if (!execute) {
    return {
      onSuccess: true, onFailure: false, env, taskJson,
      executionResultJson: JSON.stringify({ success: true, stepsCompleted: 0, stepsTotal: 0, filesModified: [], filesCreated: [], errors: [], output: 'dry run' }),
      filesModified: '[]',
    };
  }

  const { projectDir } = env;
  resetPlanFileCounter(); // Reset per-plan write counter for safety guards
  const plan = JSON.parse(planJson) as { steps: Array<{ id: string; operation: string; description: string; args: Record<string, unknown> }> };
  const filesModified: string[] = [];
  const filesCreated: string[] = [];
  const errors: string[] = [];
  const output: string[] = [];
  let completed = 0;

  const steeringCheck = checkSteering();
  if (steeringCheck === 'cancel') {
    return {
      onSuccess: false, onFailure: true, env, taskJson,
      executionResultJson: JSON.stringify({ success: false, stepsCompleted: 0, stepsTotal: plan.steps.length, filesModified: [], filesCreated: [], errors: ['Cancelled via steering'], output: '' }),
      filesModified: '[]',
    };
  }

  for (const step of plan.steps) {
    const steering = checkSteering();
    if (steering === 'cancel') {
      output.push(`Cancelled at step ${step.id}`);
      break;
    }
    if (steering === 'pause') {
      console.log('\x1b[33m→ Paused. Waiting for resume...\x1b[0m');
      await waitForResume();
    }

    try {
      const result = await executeStep(step, projectDir);
      if (result.blocked) {
        errors.push(`${step.id}: BLOCKED - ${result.blockReason}`);
        output.push(`${step.id}: BLOCKED - ${result.blockReason}`);
        console.error(`\x1b[33m  ⚠ ${step.id}: ${result.blockReason}\x1b[0m`);
        continue;
      }
      if (result.file) {
        if (result.created) filesCreated.push(result.file);
        else filesModified.push(result.file);
      }
      completed++;
      output.push(`${step.id}: ${step.description} - done`);
      console.log(`\x1b[32m  + ${step.id}: ${step.description}\x1b[0m`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${step.id}: ${msg}`);
      output.push(`${step.id}: FAILED - ${msg}`);
      console.error(`\x1b[31m  x ${step.id}: ${msg}\x1b[0m`);
    }
  }

  const allFiles = [...new Set([...filesModified, ...filesCreated])];
  const success = errors.length === 0;

  return {
    onSuccess: success, onFailure: !success, env, taskJson,
    executionResultJson: JSON.stringify({
      success, stepsCompleted: completed, stepsTotal: plan.steps.length,
      filesModified, filesCreated, errors, output: output.join('\n'),
    }),
    filesModified: JSON.stringify(allFiles),
  };
}

function checkSteering(): 'cancel' | 'pause' | null {
  try {
    const controlPath = path.join(os.homedir(), '.weaver', 'control.json');
    if (!fs.existsSync(controlPath)) return null;
    const raw = fs.readFileSync(controlPath, 'utf-8');
    fs.unlinkSync(controlPath);
    const cmd = JSON.parse(raw) as { command: string };
    if (cmd.command === 'cancel') return 'cancel';
    if (cmd.command === 'pause') return 'pause';
    return null;
  } catch {
    return null;
  }
}

async function waitForResume(): Promise<void> {
  const controlPath = path.join(os.homedir(), '.weaver', 'control.json');
  while (true) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      if (fs.existsSync(controlPath)) {
        const raw = fs.readFileSync(controlPath, 'utf-8');
        fs.unlinkSync(controlPath);
        const cmd = JSON.parse(raw) as { command: string };
        if (cmd.command === 'resume' || cmd.command === 'cancel') {
          console.log(`\x1b[36m→ ${cmd.command === 'resume' ? 'Resumed' : 'Cancelled'}\x1b[0m`);
          return;
        }
      }
    } catch { /* retry */ }
  }
}
