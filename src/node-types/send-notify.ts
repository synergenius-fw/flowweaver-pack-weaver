import { execSync } from 'node:child_process';
import type { WeaverConfig } from '../bot/types.js';

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
  const headerFlags = Object.entries(headers).map(([k, v]) => `-H "${k}: ${v}"`).join(' ');
  try {
    execSync(`curl -sS -X POST ${headerFlags} -d @- "${config.url}"`, {
      input: body,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
    });
  } catch { /* notification failure is non-fatal */ }
}

/**
 * Send webhook/Discord/Slack notifications based on config.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Notify Result
 * @input projectDir [order:0] - Project root directory
 * @input config [order:1] - Config (JSON)
 * @input targetPath [order:2] - Target path
 * @input resultJson [order:3] - Result (JSON)
 * @output projectDir [order:0] - Project root directory (pass-through)
 * @output targetPath [order:1] - Target path (pass-through)
 * @output resultJson [order:2] - Result (pass-through)
 */
export function weaverSendNotify(
  projectDir: string, config: string, targetPath: string, resultJson: string,
): { projectDir: string; targetPath: string; resultJson: string } {
  const cfg: WeaverConfig = JSON.parse(config);
  const result = JSON.parse(resultJson);
  const channels = (Array.isArray(cfg.notify) ? cfg.notify : cfg.notify ? [cfg.notify] : []);

  for (const ch of channels) {
    const events = ch.events ?? ['workflow-complete', 'error'];
    const eventType = result.success ? 'workflow-complete' : 'error';
    if (!events.includes(eventType)) continue;
    sendWebhook(ch, { ...result, targetPath, providerType: cfg.provider, projectDir });
  }

  if (channels.length > 0) console.log(`\x1b[36m→ Sent ${channels.length} notification(s)\x1b[0m`);
  return { projectDir, targetPath, resultJson };
}
