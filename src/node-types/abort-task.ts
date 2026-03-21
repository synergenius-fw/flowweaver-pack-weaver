import type { WeaverContext } from '../bot/types.js';

/**
 * Handles the rejection path from the approval gate.
 * Formats the rejection reason into a result compatible with the report node.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Abort Task
 * @input ctx [order:0] - Weaver context (JSON)
 * @output ctx [order:0] - Weaver context with abort resultJson (JSON)
 * @output onFailure [hidden]
 */
export function weaverAbortTask(ctx: string): { ctx: string } {
  const context = JSON.parse(ctx) as WeaverContext;
  const task = context.taskJson ? JSON.parse(context.taskJson) as { instruction?: string } : {};
  const reason = context.rejectionReason ?? 'no reason given';
  const result = {
    success: false,
    outcome: 'aborted',
    summary: `Task aborted: ${reason}`,
    instruction: (task as { instruction?: string }).instruction,
    filesModified: [],
    filesCreated: [],
  };

  console.log(`\x1b[33m→ Task aborted: ${reason}\x1b[0m`);

  context.resultJson = JSON.stringify(result);
  context.filesModified = '[]';
  return { ctx: JSON.stringify(context) };
}
