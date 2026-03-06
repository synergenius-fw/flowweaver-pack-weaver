import type { WeaverEnv } from '../bot/types.js';

/**
 * Routes based on task mode. onSuccess fires for actionable tasks
 * (create/modify/batch). onFailure fires for read-only tasks.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Route Task
 * @input env [order:0] - Weaver environment bundle
 * @input taskJson [order:1] - Task (JSON)
 * @output env [order:0] - Weaver environment bundle (pass-through)
 * @output taskJson [order:1] - Task (pass-through)
 */
export function weaverRouteTask(
  env: WeaverEnv,
  taskJson: string,
): { env: WeaverEnv; taskJson: string } {
  const task = JSON.parse(taskJson) as { mode?: string };
  const mode = task.mode ?? 'create';

  if (mode === 'read') {
    console.log('\x1b[36m→ Routing to read-only path\x1b[0m');
    throw new Error('read-only-route');
  }

  console.log(`\x1b[36m→ Routing to ${mode} path\x1b[0m`);
  return { env, taskJson };
}
