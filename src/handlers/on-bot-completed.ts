/**
 * Event handler: bot.completed
 *
 * Triggered by the platform event bus when any bot execution completes.
 * Emits a pack-namespaced event with the completion summary for
 * downstream consumers (dashboard widgets, notification webhooks).
 *
 * Runs inside the platform sandbox with events:emit capability.
 */

interface BotCompletedPayload {
  userId?: string;
  botId?: string;
  executionId?: string;
  status?: string;
  executionTimeMs?: number;
}

interface EventBus {
  emit(event: string, payload: Record<string, unknown>): void;
}

declare const __fw_event_bus__: EventBus | undefined;

export async function onBotCompleted(
  _execute: boolean,
  params: BotCompletedPayload,
): Promise<{ acknowledged: boolean }> {
  const { botId, executionId, status, executionTimeMs } = params;

  // Only process weaver bot completions
  if (botId !== 'weaver-bot' && botId !== 'weaver-genesis') {
    return { acknowledged: false };
  }

  // Emit a pack-namespaced event with enriched data
  if (typeof __fw_event_bus__ !== 'undefined') {
    __fw_event_bus__.emit('pack.weaver.run-completed', {
      botId,
      executionId,
      status,
      executionTimeMs,
      completedAt: Date.now(),
    });
  }

  return { acknowledged: true };
}
