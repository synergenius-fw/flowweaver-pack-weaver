import type { WeaverEnv } from '../bot/types.js';

/**
 * Handles the rejection path from the approval gate.
 * Formats the rejection reason into a result compatible with the report node.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Abort Task
 * @input env [order:0] - Weaver environment bundle
 * @input taskJson [order:1] - Task (JSON)
 * @input rejectionReason [order:2] - Rejection reason
 * @output env [order:0] - Weaver environment bundle (pass-through)
 * @output taskJson [order:1] - Task (pass-through)
 * @output resultJson [order:2] - Abort result (JSON)
 * @output filesModified [order:3] - Files modified (empty, JSON)
 */
export function weaverAbortTask(
  env: WeaverEnv,
  taskJson: string,
  rejectionReason: string,
): { env: WeaverEnv; taskJson: string; resultJson: string; filesModified: string } {
  const task = JSON.parse(taskJson) as { instruction?: string };
  const result = {
    success: false,
    outcome: 'aborted',
    summary: `Task aborted: ${rejectionReason}`,
    instruction: task.instruction,
    filesModified: [],
    filesCreated: [],
  };

  console.log(`\x1b[33m→ Task aborted: ${rejectionReason}\x1b[0m`);

  return {
    env, taskJson,
    resultJson: JSON.stringify(result),
    filesModified: '[]',
  };
}
