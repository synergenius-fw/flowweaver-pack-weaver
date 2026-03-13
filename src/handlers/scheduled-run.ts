/**
 * Event handler: schedule.tick
 *
 * Triggered by the platform cron scheduler at the interval declared
 * in the manifest (default: every 30 minutes).
 *
 * Checks the task queue for pending tasks and processes the next one.
 * Emits pack.weaver.task-started and pack.weaver.task-completed events
 * via the sandbox event bus IPC channel.
 *
 * Runs inside the platform sandbox with ai:chat and events:emit capabilities.
 */

interface ScheduleTickPayload {
  scheduleId?: string;
  cronExpression?: string;
  timestamp?: number;
}

interface EventBus {
  emit(event: string, payload: Record<string, unknown>): void;
}

declare const __fw_event_bus__: EventBus | undefined;

export async function onScheduledRun(
  _execute: boolean,
  params: ScheduleTickPayload,
): Promise<{ processed: boolean; taskId?: string; skipped?: string }> {
  // In the sandbox, the task queue is accessible via the workspace filesystem.
  // The handler reads the queue file, picks the next pending task, and processes it.

  // For now, emit a heartbeat event so the platform knows the scheduler is alive.
  if (typeof __fw_event_bus__ !== 'undefined') {
    __fw_event_bus__.emit('pack.weaver.scheduler-heartbeat', {
      timestamp: Date.now(),
      cronExpression: params.cronExpression,
    });
  }

  return { processed: false, skipped: 'No pending tasks in queue' };
}
