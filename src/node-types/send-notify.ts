import type { WeaverEnv } from '../bot/types.js';

function sendWebhook(
  config: { channel: string; url: string; headers?: Record<string, string> },
  event: Record<string, unknown>,
): void {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...config.headers,
  };
  let body: string;
  if (config.channel === 'discord') {
    const color = event.success ? 0x22c55e : 0xef4444;
    body = JSON.stringify({
      embeds: [{
        title: `Weaver: ${event.outcome ?? 'update'}`,
        description: String(event.summary ?? '').slice(0, 2000),
        color,
        fields: [
          { name: 'Workflow', value: String(event.targetPath ?? 'unknown'), inline: true },
          { name: 'Provider', value: String(event.providerType ?? 'unknown'), inline: true },
        ],
        timestamp: new Date().toISOString(),
      }],
    });
  } else if (config.channel === 'slack') {
    const emoji = event.success ? ':white_check_mark:' : ':x:';
    body = JSON.stringify({
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: `${emoji} Weaver: ${event.outcome ?? 'update'}` } },
        { type: 'section', text: { type: 'mrkdwn', text: String(event.summary ?? '').slice(0, 2000) } },
      ],
    });
  } else {
    body = JSON.stringify(event);
  }
  fetch(config.url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {});
}

/**
 * Send webhook/Discord/Slack notifications based on config.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Notify Result
 * @input env [order:0] - Weaver environment bundle
 * @input resultJson [order:1] - Result (JSON)
 * @output env [order:0] - Weaver environment bundle (pass-through)
 * @output resultJson [order:1] - Result (pass-through)
 */
export function weaverSendNotify(
  env: WeaverEnv, resultJson: string,
): { env: WeaverEnv; resultJson: string } {
  const { config, projectDir } = env;
  const result = JSON.parse(resultJson);
  const channels = (Array.isArray(config.notify) ? config.notify : config.notify ? [config.notify] : []);

  for (const ch of channels) {
    const events = ch.events ?? ['workflow-complete', 'error'];
    const eventType = result.success ? 'workflow-complete' : 'error';
    if (!events.includes(eventType)) continue;
    sendWebhook(ch, { ...result, targetPath: projectDir, providerType: config.provider, projectDir });
  }

  if (channels.length > 0) console.log(`\x1b[36m→ Sent ${channels.length} notification(s)\x1b[0m`);
  return { env, resultJson };
}
