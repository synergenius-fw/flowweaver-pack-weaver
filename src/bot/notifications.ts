import type {
  BotNotifyConfig,
  NotificationEvent,
  NotificationEventType,
} from './types.js';

export interface NotificationChannel {
  name: string;
  shouldSend(eventType: NotificationEventType): boolean;
  send(event: NotificationEvent): Promise<void>;
}

const EVENT_COLORS: Record<NotificationEventType, number> = {
  'workflow-start': 0x3498db, // blue
  'workflow-complete': 0x2ecc71, // green
  'cycle-start': 0x3498db, // blue
  'cycle-complete': 0x2ecc71, // green
  'approval-needed': 0xf1c40f, // yellow
  error: 0xe74c3c, // red
};

const EVENT_LABELS: Record<NotificationEventType, string> = {
  'workflow-start': 'Workflow Started',
  'workflow-complete': 'Workflow Complete',
  'cycle-start': 'Cycle Started',
  'cycle-complete': 'Cycle Complete',
  'approval-needed': 'Approval Needed',
  error: 'Error',
};

function formatDiscordBody(event: NotificationEvent): object {
  const color = EVENT_COLORS[event.type];
  const context = event.cycle != null ? `Cycle ${event.cycle}` : (event.workflowFile ?? 'Workflow');
  const title = `Weaver: ${EVENT_LABELS[event.type]} (${context})`;

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];

  if (event.summary) {
    fields.push({ name: 'Summary', value: event.summary });
  }
  if (event.outcome) {
    fields.push({ name: 'Outcome', value: event.outcome, inline: true });
  }
  if (event.diff) {
    const s = event.diff.summary as Record<string, number> | undefined;
    if (s) {
      fields.push({
        name: 'Nodes',
        value: `+${s.nodeTypesAdded ?? 0} / -${s.nodeTypesRemoved ?? 0}`,
        inline: true,
      });
      fields.push({
        name: 'Connections',
        value: `+${s.connectionsAdded ?? 0} / -${s.connectionsRemoved ?? 0}`,
        inline: true,
      });
    }
  }
  if (event.error) {
    fields.push({ name: 'Error', value: event.error.slice(0, 1024) });
  }

  return {
    embeds: [
      {
        title,
        description: event.projectDir,
        color,
        fields: fields.length > 0 ? fields : undefined,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

function formatSlackBody(event: NotificationEvent): object {
  const label = EVENT_LABELS[event.type];
  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `Weaver: ${label}${event.cycle != null ? ` (Cycle ${event.cycle})` : ''}`,
      },
    },
  ];

  const parts: string[] = [`*Project:* ${event.projectDir}`];
  if (event.summary) parts.push(`*Summary:* ${event.summary}`);
  if (event.outcome) parts.push(`*Outcome:* ${event.outcome}`);
  if (event.error) parts.push(`*Error:* ${event.error.slice(0, 500)}`);

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: parts.join('\n') },
  });

  return { blocks };
}

function formatWebhookBody(event: NotificationEvent): object {
  return { event };
}

export class WebhookNotificationChannel implements NotificationChannel {
  name: string;
  private url: string;
  private channelType: 'discord' | 'slack' | 'webhook';
  private events: Set<NotificationEventType>;
  private headers: Record<string, string>;

  constructor(config: BotNotifyConfig) {
    this.name = config.channel;
    this.url = config.url;
    this.channelType = config.channel;
    this.events = new Set(
      config.events ?? [
        'cycle-start',
        'cycle-complete',
        'approval-needed',
        'error',
      ],
    );
    this.headers = config.headers ?? {};
  }

  shouldSend(eventType: NotificationEventType): boolean {
    return this.events.has(eventType);
  }

  async send(event: NotificationEvent): Promise<void> {
    if (!this.shouldSend(event.type)) return;

    let body: object;
    switch (this.channelType) {
      case 'discord':
        body = formatDiscordBody(event);
        break;
      case 'slack':
        body = formatSlackBody(event);
        break;
      default:
        body = formatWebhookBody(event);
    }

    try {
      const resp = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.headers,
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        console.error(
          `[genesis-bot] ${this.channelType} notification failed: ${resp.status} ${resp.statusText}`,
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[genesis-bot] ${this.channelType} notification error: ${msg}`,
      );
    }
  }
}

export function createNotifier(
  channels: NotificationChannel[],
): (event: NotificationEvent) => Promise<void> {
  return async (event: NotificationEvent) => {
    await Promise.allSettled(channels.map((ch) => ch.send(event)));
  };
}
