import * as readline from 'node:readline';
import type { WeaverContext } from '../bot/types.js';
import { auditEmit } from '../bot/audit-logger.js';

/**
 * Presents the plan to the user for approval. Branching:
 * onSuccess = approved, onFailure = rejected.
 * Supports autoApprove mode from config.
 *
 * @flowWeaver nodeType
 * @label Approval Gate
 * @input ctx [order:0] - Weaver context (JSON)
 * @output ctx [order:0] - Weaver context with rejectionReason (JSON)
 * @output onSuccess [order:-2] - On Success
 * @output onFailure [order:-1] - On Failure
 */
export async function weaverApprovalGate(
  execute: boolean,
  ctx: string,
): Promise<{
  onSuccess: boolean; onFailure: boolean;
  ctx: string;
}> {
  const context = JSON.parse(ctx) as WeaverContext;
  const { env } = context;

  if (!execute) {
    context.rejectionReason = '';
    return { onSuccess: true, onFailure: false, ctx: JSON.stringify(context) };
  }

  const { config } = env;
  const approvalMode = typeof config.approval === 'string' ? config.approval : config.approval?.mode ?? 'prompt';

  // Check for autoApprove in task options
  const task = JSON.parse(context.taskJson!) as { options?: { autoApprove?: boolean } };
  if (task.options?.autoApprove || approvalMode === 'auto') {
    console.log('\x1b[36m→ Auto-approved\x1b[0m');
    auditEmit('approval-decision', { approved: true, mode: 'auto' });
    context.rejectionReason = '';
    return { onSuccess: true, onFailure: false, ctx: JSON.stringify(context) };
  }

  // Display the plan
  const plan = JSON.parse(context.planJson!) as { steps: Array<{ id: string; operation: string; description: string }>; summary: string };
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
    auditEmit('approval-decision', { approved: true, mode: 'prompt' });
    context.rejectionReason = '';
    return { onSuccess: true, onFailure: false, ctx: JSON.stringify(context) };
  }

  const reason = answer || 'rejected by user';
  console.log(`\x1b[33m→ Plan rejected: ${reason}\x1b[0m`);
  auditEmit('approval-decision', { approved: false, reason });
  context.rejectionReason = reason;
  return { onSuccess: false, onFailure: true, ctx: JSON.stringify(context) };
}
