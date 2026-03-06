import * as readline from 'node:readline';

/**
 * Presents the plan to the user for approval. Branching:
 * onSuccess = approved, onFailure = rejected.
 * Supports autoApprove mode from config.
 *
 * @flowWeaver nodeType
 * @label Approval Gate
 * @input projectDir [order:0] - Project root directory (pass-through)
 * @input config [order:1] - Config (JSON)
 * @input providerType [order:2] - Provider type (pass-through)
 * @input providerInfo [order:3] - Provider info (pass-through)
 * @input planJson [order:4] - Plan (JSON)
 * @input taskJson [order:5] - Task (JSON)
 * @output projectDir [order:0] - Project root directory (pass-through)
 * @output config [order:1] - Config (pass-through)
 * @output providerType [order:2] - Provider type (pass-through)
 * @output providerInfo [order:3] - Provider info (pass-through)
 * @output planJson [order:4] - Plan (pass-through)
 * @output taskJson [order:5] - Task (pass-through)
 * @output rejectionReason [order:6] - Rejection reason (on failure path)
 * @output onSuccess [order:-2] - On Success
 * @output onFailure [order:-1] - On Failure
 */
export async function weaverApprovalGate(
  execute: boolean,
  projectDir: string,
  config: string,
  providerType: string,
  providerInfo: string,
  planJson: string,
  taskJson: string,
): Promise<{
  onSuccess: boolean; onFailure: boolean;
  projectDir: string; config: string; providerType: string; providerInfo: string;
  planJson: string; taskJson: string; rejectionReason: string;
}> {
  const passthrough = { projectDir, config, providerType, providerInfo, planJson, taskJson };

  if (!execute) {
    return { onSuccess: true, onFailure: false, ...passthrough, rejectionReason: '' };
  }

  const cfg = JSON.parse(config) as { approval?: string | { mode: string } };
  const approvalMode = typeof cfg.approval === 'string' ? cfg.approval : cfg.approval?.mode ?? 'prompt';

  // Check for autoApprove in task options
  const task = JSON.parse(taskJson) as { options?: { autoApprove?: boolean } };
  if (task.options?.autoApprove || approvalMode === 'auto') {
    console.log('\x1b[36m→ Auto-approved\x1b[0m');
    return { onSuccess: true, onFailure: false, ...passthrough, rejectionReason: '' };
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
    return { onSuccess: true, onFailure: false, ...passthrough, rejectionReason: '' };
  }

  const reason = answer || 'rejected by user';
  console.log(`\x1b[33m→ Plan rejected: ${reason}\x1b[0m`);
  return { onSuccess: false, onFailure: true, ...passthrough, rejectionReason: reason };
}
