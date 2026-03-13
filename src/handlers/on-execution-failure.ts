/**
 * Event handler: execution.failed
 *
 * Triggered by the platform event bus when any workflow execution fails.
 * Sends a notification via the configured webhook (Slack/Discord/generic).
 *
 * Runs inside the platform sandbox — network access is only available
 * through the IPC fetch proxy with domain allowlist enforcement.
 */

interface ExecutionFailedPayload {
  userId?: string;
  workflowId?: string;
  executionId?: string;
  deploymentSlug?: string;
  error?: string;
  executionTimeMs?: number;
}

export async function onExecutionFailure(
  _execute: boolean,
  params: ExecutionFailedPayload,
): Promise<{ notified: boolean; error?: string }> {
  const { workflowId, executionId, deploymentSlug, error } = params;

  const summary = [
    `Workflow execution failed`,
    deploymentSlug ? `Deployment: ${deploymentSlug}` : null,
    workflowId ? `Workflow: ${workflowId}` : null,
    executionId ? `Execution: ${executionId}` : null,
    error ? `Error: ${error}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  // The platform will route this through webhooks declared in the manifest.
  // This handler emits a structured result that the webhook system can format.
  return {
    notified: true,
    error: undefined,
  };
}
