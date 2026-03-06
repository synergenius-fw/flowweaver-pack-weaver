import * as readline from 'node:readline';
import type { WeaverEnv } from '../bot/types.js';

/**
 * Presents the plan to the user for approval. Branching:
 * onSuccess = approved, onFailure = rejected.
 * Supports autoApprove mode from config.
 *
 * @flowWeaver nodeType
 * @label Approval Gate
 * @input env [order:0] - Weaver environment bundle
 * @input planJson [order:1] - Plan (JSON)
 * @input taskJson [order:2] - Task (JSON)
 * @output env [order:0] - Weaver environment bundle (pass-through)
 * @output planJson [order:1] - Plan (pass-through)
 * @output taskJson [order:2] - Task (pass-through)
 * @output rejectionReason [order:3] - Rejection reason (on failure path)
 * @output onSuccess [order:-2] - On Success
 * @output onFailure [order:-1] - On Failure
 */
export async function weaverApprovalGate(
  execute: boolean,
  env: WeaverEnv,
  planJson: string,
  taskJson: string,
): Promise<{
  onSuccess: boolean; onFailure: boolean;
  env: WeaverEnv;
  planJson: string; taskJson: string; rejectionReason: string;
}> {
  if (!execute) {
    return { onSuccess: true, onFailure: false, env, planJson, taskJson, rejectionReason: '' };
  }

  const { config } = env;
  const approvalMode = typeof config.approval === 'string' ? config.approval : config.approval?.mode ?? 'prompt';

  // Check for autoApprove in task options
  const task = JSON.parse(taskJson) as { options?: { autoApprove?: boolean } };
  if (task.options?.autoApprove || approvalMode === 'auto') {
    console.log('\x1b[36m→ Auto-approved\x1b[0m');
    return { onSuccess: true, onFailure: false, env, planJson, taskJson, rejectionReason: '' };
  }

  // Display the plan
  const plan = JSON.parse(planJson) as { steps: Array<{ id: string; operation: string; description: string }>; summary: string };
  console.log('\n\x1b[1m┌─ Bot Plan ─────────────────────────────┐\x1b[0m');
  console.log(`\x1b[1m│\x1b[0m Summary: ${plan.summary}`);
  console.log(`\x1b[1m│\x1b[0m Steps: ${plan.steps.length}`);
  for (const step of plan.steps) {
    console.log(`\x1b[1m│\x1b[0m  ${step.id}: [${step.operation}] ${step.description}`);
  }
  console.log('\x1b[1m└────────────────────────────────────────┘\x1b[0m\n');

  // Prompt for approval
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(resolve => {
    rl.question('Approve this plan? [Y/n] ', resolve);
  });
  rl.close();

  const approved = !answer || answer.toLowerCase().startsWith('y');

  if (approved) {
    console.log('\x1b[32m→ Plan approved\x1b[0m');
    return { onSuccess: true, onFailure: false, env, planJson, taskJson, rejectionReason: '' };
  }

  const reason = answer || 'rejected by user';
  console.log(`\x1b[33m→ Plan rejected: ${reason}\x1b[0m`);
  return { onSuccess: false, onFailure: true, env, planJson, taskJson, rejectionReason: reason };
}
