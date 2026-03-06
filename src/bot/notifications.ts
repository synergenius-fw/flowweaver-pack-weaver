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

export type NotificationErrorHandler = (
  channel: string,
  event: NotificationEvent,
  error: string,
) => void;

const EVENT_COLORS: Record<NotificationEventType, number> = {
  'workflow-start': 0x3498db,
  'workflow-complete': 0x2ecc71,
  'cycle-start': 0x3498db,
  'cycle-complete': 0x2ecc71,
  'approval-needed': 0xf1c40f,
  error: 0xe74c3c,
  'pipeline-start': 0x9b59b6,
  'pipeline-complete': 0x2ecc71,
  'stage-start': 0x3498db,
  'stage-complete': 0x2ecc71,
  'bot-task-start': 0x3498db,
  'bot-task-complete': 0x2ecc71,
  'bot-plan-ready': 0x9b59b6,
  'bot-step-complete': 0x1abc9c,
  'bot-validation-failed': 0xe67e22,
  'bot-fix-attempt': 0xf39c12,
  'bot-session-start': 0x3498db,
  'bot-session-end': 0x2ecc71,
  'bot-steering-received': 0x95a5a6,
};

const EVENT_LABELS: Record<NotificationEventType, string> = {
  'workflow-start': 'Workflow Started',
  'workflow-complete': 'Workflow Complete',
  'cycle-start': 'Cycle Started',
  'cycle-complete': 'Cycle Complete',
  'approval-needed': 'Approval Needed',
  error: 'Error',
  'pipeline-start': 'Pipeline Started',
  'pipeline-complete': 'Pipeline Complete',
  'stage-start': 'Stage Started',
  'stage-complete': 'Stage Complete',
  'bot-task-start': 'Bot Task Started',
  'bot-task-complete': 'Bot Task Complete',
  'bot-plan-ready': 'Bot Plan Ready',
  'bot-step-complete': 'Bot Step Complete',
  'bot-validation-failed': 'Bot Validation Failed',
  'bot-fix-attempt': 'Bot Fix Attempt',
  'bot-session-start': 'Bot Session Started',
  'bot-session-end': 'Bot Session Ended',
  'bot-steering-received': 'Bot Steering Received',
};

function formatDiscordBody(event: NotificationEvent): object {
  const color = EVENT_COLORS[event.type];
  const context =
    event.cycle != null
      ? `Cycle ${event.cycle}`
      : (event.workflowFile ?? 'Workflow');
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
  if (event.pipelineName) {
    fields.push({ name: 'Pipeline', value: event.pipelineName, inline: true });
  }
  if (event.stageId) {
    fields.push({ name: 'Stage', value: event.stageId, inline: true });
  }
  if (event.totalStages != null) {
    fields.push({ name: 'Progress', value: `${event.completedStages ?? 0}/${event.totalStages}`, inline: true });
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
  if (event.pipelineName) parts.push(`*Pipeline:* ${event.pipelineName}`);
  if (event.stageId) parts.push(`*Stage:* ${event.stageId}`);
  if (event.totalStages != null) parts.push(`*Progress:* ${event.completedStages ?? 0}/${event.totalStages}`);
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

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxAttempts: number,
  onError?: NotificationErrorHandler,
  channelName?: string,
  event?: NotificationEvent,
): Promise<Response | null> {
  const delays = [1000, 2000, 4000];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const resp = await fetch(url, init);
      if (resp.ok) return resp;

      const msg = `${resp.status} ${resp.statusText}`;
      if (attempt < maxAttempts - 1) {
        console.error(
          `[weaver] ${channelName} notification failed (attempt ${attempt + 1}/${maxAttempts}): ${msg}`,
        );
        await new Promise((r) => setTimeout(r, delays[attempt] ?? 4000));
      } else {
        const errorMsg = `${channelName} notification failed after ${maxAttempts} attempts: ${msg}`;
        console.error(`[weaver] ${errorMsg}`);
        if (onError && event) onError(channelName ?? 'unknown', event, errorMsg);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < maxAttempts - 1) {
        console.error(
          `[weaver] ${channelName} notification error (attempt ${attempt + 1}/${maxAttempts}): ${msg}`,
        );
        await new Promise((r) => setTimeout(r, delays[attempt] ?? 4000));
      } else {
        const errorMsg = `${channelName} notification error after ${maxAttempts} attempts: ${msg}`;
        console.error(`[weaver] ${errorMsg}`);
        if (onError && event) onError(channelName ?? 'unknown', event, errorMsg);
      }
    }
  }

  return null;
}

export class WebhookNotificationChannel implements NotificationChannel {
  name: string;
  private url: string;
  private channelType: 'discord' | 'slack' | 'webhook';
  private events: Set<NotificationEventType>;
  private headers: Record<string, string>;
  private onError?: NotificationErrorHandler;

  constructor(config: BotNotifyConfig, onError?: NotificationErrorHandler) {
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
    this.onError = onError;
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

    await fetchWithRetry(
      this.url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.headers,
        },
        body: JSON.stringify(body),
      },
      3,
      this.onError,
      this.channelType,
      event,
    );
  }
}

export function createNotifier(
  channels: NotificationChannel[],
): (event: NotificationEvent) => Promise<void> {
  return async (event: NotificationEvent) => {
    await Promise.allSettled(channels.map((ch) => ch.send(event)));
  };
}
