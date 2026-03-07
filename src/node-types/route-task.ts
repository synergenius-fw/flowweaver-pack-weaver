import type { WeaverContext } from '../bot/types.js';

/**
 * Routes based on task mode. onSuccess fires for actionable tasks
 * (create/modify/batch). onFailure fires for read-only tasks.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Route Task
 * @input ctx [order:0] - Weaver context (JSON)
 * @output ctx [order:0] - Weaver context (pass-through, JSON)
 */
export function weaverRouteTask(ctx: string): { ctx: string } {
  const context = JSON.parse(ctx) as WeaverContext;
  const task = JSON.parse(context.taskJson!) as { mode?: string };
  const mode = task.mode ?? 'create';

  if (mode === 'read') {
    console.log('\x1b[36m→ Routing to read-only path\x1b[0m');
    throw new Error('read-only-route');
  }

  console.log(`\x1b[36m→ Routing to ${mode} path\x1b[0m`);
  return { ctx };
}
