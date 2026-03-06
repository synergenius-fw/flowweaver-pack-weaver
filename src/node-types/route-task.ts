/**
 * Routes based on task mode. onSuccess fires for actionable tasks
 * (create/modify/batch). onFailure fires for read-only tasks.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Route Task
 * @input projectDir [order:0] - Project root directory
 * @input config [order:1] - Config (JSON)
 * @input providerType [order:2] - Provider type
 * @input providerInfo [order:3] - Provider info (JSON)
 * @input taskJson [order:4] - Task (JSON)
 * @output projectDir [order:0] - Project root directory (pass-through)
 * @output config [order:1] - Config (pass-through)
 * @output providerType [order:2] - Provider type (pass-through)
 * @output providerInfo [order:3] - Provider info (pass-through)
 * @output taskJson [order:4] - Task (pass-through)
 */
export function weaverRouteTask(
  projectDir: string,
  config: string,
  providerType: string,
  providerInfo: string,
  taskJson: string,
): { projectDir: string; config: string; providerType: string; providerInfo: string; taskJson: string } {
  const task = JSON.parse(taskJson) as { mode?: string };
  const mode = task.mode ?? 'create';

  if (mode === 'read') {
    console.log('\x1b[36m→ Routing to read-only path\x1b[0m');
    throw new Error('read-only-route');
  }

  console.log(`\x1b[36m→ Routing to ${mode} path\x1b[0m`);
  return { projectDir, config, providerType, providerInfo, taskJson };
}
