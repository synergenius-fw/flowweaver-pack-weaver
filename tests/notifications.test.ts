import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebhookNotificationChannel, createNotifier } from '../src/bot/notifications.js';
import type { NotificationChannel, NotificationErrorHandler } from '../src/bot/notifications.js';
import type { NotificationEvent, NotificationEventType, BotNotifyConfig } from '../src/bot/types.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetchOk(): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

function mockFetchFail(status = 500, statusText = 'Internal Server Error'): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({ ok: false, status, statusText });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

function mockFetchThrow(msg = 'network error'): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockRejectedValue(new Error(msg));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

function baseEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    type: 'cycle-start',
    projectDir: '/tmp/test-project',
    ...overrides,
  };
}

function discordConfig(overrides: Partial<BotNotifyConfig> = {}): BotNotifyConfig {
  return {
    channel: 'discord',
    url: 'https://discord.com/api/webhooks/test',
    ...overrides,
  };
}

function slackConfig(overrides: Partial<BotNotifyConfig> = {}): BotNotifyConfig {
  return {
    channel: 'slack',
    url: 'https://hooks.slack.com/services/test',
    ...overrides,
  };
}

function webhookConfig(overrides: Partial<BotNotifyConfig> = {}): BotNotifyConfig {
  return {
    channel: 'webhook',
    url: 'https://example.com/webhook',
    ...overrides,
  };
}

/** Parse the JSON body that was sent to the mocked fetch. */
function sentBody(fn: ReturnType<typeof vi.fn>, callIndex = 0): unknown {
  const call = fn.mock.calls[callIndex];
  return JSON.parse(call[1].body as string);
}

function sentHeaders(fn: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, string> {
  return fn.mock.calls[callIndex][1].headers;
}

/* ------------------------------------------------------------------ */
/*  shouldSend                                                        */
/* ------------------------------------------------------------------ */

describe('WebhookNotificationChannel.shouldSend', () => {
  it('returns true for events in the configured set', () => {
    const ch = new WebhookNotificationChannel(
      discordConfig({ events: ['cycle-start', 'error'] }),
    );
    expect(ch.shouldSend('cycle-start')).toBe(true);
    expect(ch.shouldSend('error')).toBe(true);
  });

  it('returns false for events not in the configured set', () => {
    const ch = new WebhookNotificationChannel(
      discordConfig({ events: ['cycle-start'] }),
    );
    expect(ch.shouldSend('cycle-complete')).toBe(false);
    expect(ch.shouldSend('error')).toBe(false);
    expect(ch.shouldSend('approval-needed')).toBe(false);
  });

  it('uses default events when none specified', () => {
    const ch = new WebhookNotificationChannel(discordConfig());
    const defaults: NotificationEventType[] = [
      'cycle-start',
      'cycle-complete',
      'approval-needed',
      'error',
    ];
    for (const evt of defaults) {
      expect(ch.shouldSend(evt)).toBe(true);
    }
    expect(ch.shouldSend('workflow-start')).toBe(false);
    expect(ch.shouldSend('pipeline-start')).toBe(false);
    expect(ch.shouldSend('stage-start')).toBe(false);
    expect(ch.shouldSend('bot-task-start')).toBe(false);
  });

  it('handles all event types explicitly listed', () => {
    const allEvents: NotificationEventType[] = [
      'workflow-start', 'workflow-complete',
      'cycle-start', 'cycle-complete',
      'approval-needed', 'error',
      'pipeline-start', 'pipeline-complete',
      'stage-start', 'stage-complete',
      'bot-task-start', 'bot-task-complete',
      'bot-plan-ready', 'bot-step-complete',
      'bot-validation-failed', 'bot-fix-attempt',
      'bot-session-start', 'bot-session-end',
      'bot-steering-received',
    ];
    const ch = new WebhookNotificationChannel(discordConfig({ events: allEvents }));
    for (const evt of allEvents) {
      expect(ch.shouldSend(evt)).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  send - skip when event not configured                             */
/* ------------------------------------------------------------------ */

describe('WebhookNotificationChannel.send', () => {
  it('does not call fetch when event type is not in the configured set', async () => {
    const fn = mockFetchOk();
    const ch = new WebhookNotificationChannel(
      discordConfig({ events: ['error'] }),
    );
    await ch.send(baseEvent({ type: 'workflow-start' }));
    expect(fn).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  Discord body formatting                                           */
/* ------------------------------------------------------------------ */

describe('Discord body formatting', () => {
  it('sends an embed with correct title, color, and timestamp', async () => {
    const fn = mockFetchOk();
    const ch = new WebhookNotificationChannel(
      discordConfig({ events: ['cycle-start'] }),
    );
    await ch.send(baseEvent({ type: 'cycle-start', cycle: 3 }));

    const body = sentBody(fn) as { embeds: Array<Record<string, unknown>> };
    expect(body.embeds).toHaveLength(1);
    const embed = body.embeds[0];
    expect(embed.title).toBe('Weaver: Cycle Started (Cycle 3)');
    expect(embed.color).toBe(0x3498db);
    expect(embed.description).toBe('/tmp/test-project');
    expect(embed.timestamp).toBeDefined();
  });

  it('uses workflowFile in title when cycle is not set', async () => {
    const fn = mockFetchOk();
    const ch = new WebhookNotificationChannel(
      discordConfig({ events: ['workflow-start'] }),
    );
    await ch.send(baseEvent({ type: 'workflow-start', workflowFile: 'my-flow.yaml' }));

    const body = sentBody(fn) as { embeds: Array<Record<string, unknown>> };
    expect(body.embeds[0].title).toBe('Weaver: Workflow Started (my-flow.yaml)');
  });

  it('falls back to "Workflow" when neither cycle nor workflowFile is set', async () => {
    const fn = mockFetchOk();
    const ch = new WebhookNotificationChannel(
      discordConfig({ events: ['error'] }),
    );
    await ch.send(baseEvent({ type: 'error' }));

    const body = sentBody(fn) as { embeds: Array<Record<string, unknown>> };
    expect(body.embeds[0].title).toBe('Weaver: Error (Workflow)');
  });

  it('includes summary field', async () => {
    const fn = mockFetchOk();
    const ch = new WebhookNotificationChannel(
      discordConfig({ events: ['cycle-complete'] }),
    );
    await ch.send(baseEvent({ type: 'cycle-complete', summary: 'All good' }));

    const body = sentBody(fn) as { embeds: Array<{ fields: Array<{ name: string; value: string }> }> };
    const fields = body.embeds[0].fields;
    expect(fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Summary', value: 'All good' }),
    ]));
  });

  it('includes outcome field inline', async () => {
    const fn = mockFetchOk();
    const ch = new WebhookNotificationChannel(
      discordConfig({ events: ['cycle-complete'] }),
    );
    await ch.send(baseEvent({ type: 'cycle-complete', outcome: 'success' }));

    const body = sentBody(fn) as { embeds: Array<{ fields: Array<{ name: string; value: string; inline?: boolean }> }> };
    const outcomeField = body.embeds[0].fields.find((f: { name: string }) => f.name === 'Outcome');
    expect(outcomeField).toBeDefined();
    expect(outcomeField!.value).toBe('success');
    expect(outcomeField!.inline).toBe(true);
  });

  it('includes error field truncated to 1024 chars', async () => {
    const fn = mockFetchOk();
    const longError = 'x'.repeat(2000);
    const ch = new WebhookNotificationChannel(
      discordConfig({ events: ['error'] }),
    );
    await ch.send(baseEvent({ type: 'error', error: longError }));

    const body = sentBody(fn) as { embeds: Array<{ fields: Array<{ name: string; value: string }> }> };
    const errorField = body.embeds[0].fields.find((f: { name: string }) => f.name === 'Error');
    expect(errorField).toBeDefined();
    expect(errorField!.value).toHaveLength(1024);
  });

  it('includes diff summary with node and connection counts', async () => {
    const fn = mockFetchOk();
    const ch = new WebhookNotificationChannel(
      discordConfig({ events: ['cycle-complete'] }),
    );
    await ch.send(baseEvent({
      type: 'cycle-complete',
      diff: {
        summary: {
          nodeTypesAdded: 2,
          nodeTypesRemoved: 1,
          connectionsAdded: 5,
          connectionsRemoved: 3,
        },
      },
    }));

    const body = sentBody(fn) as { embeds: Array<{ fields: Array<{ name: string; value: string }> }> };
    const fields = body.embeds[0].fields;
    const nodesField = fields.find((f: { name: string }) => f.name === 'Nodes');
    const connField = fields.find((f: { name: string }) => f.name === 'Connections');
    expect(nodesField!.value).toBe('+2 / -1');
    expect(connField!.value).toBe('+5 / -3');
  });

  it('handles diff summary with missing counts (defaults to 0)', async () => {
    const fn = mockFetchOk();
    const ch = new WebhookNotificationChannel(
      discordConfig({ events: ['cycle-complete'] }),
    );
    await ch.send(baseEvent({
      type: 'cycle-complete',
      diff: { summary: {} },
    }));

    const body = sentBody(fn) as { embeds: Array<{ fields: Array<{ name: string; value: string }> }> };
    const fields = body.embeds[0].fields;
    const nodesField = fields.find((f: { name: string }) => f.name === 'Nodes');
    expect(nodesField!.value).toBe('+0 / -0');
  });

  it('includes pipeline and stage fields', async () => {
    const fn = mockFetchOk();
    const ch = new WebhookNotificationChannel(
      discordConfig({ events: ['stage-complete'] }),
    );
    await ch.send(baseEvent({
      type: 'stage-complete',
      pipelineName: 'deploy-pipeline',
      stageId: 'build',
    }));

    const body = sentBody(fn) as { embeds: Array<{ fields: Array<{ name: string; value: string }> }> };
    const fields = body.embeds[0].fields;
    expect(fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Pipeline', value: 'deploy-pipeline', inline: true }),
      expect.objectContaining({ name: 'Stage', value: 'build', inline: true }),
    ]));
  });

  it('includes progress field when totalStages is set', async () => {
    const fn = mockFetchOk();
    const ch = new WebhookNotificationChannel(
      discordConfig({ events: ['pipeline-complete'] }),
    );
    await ch.send(baseEvent({
      type: 'pipeline-complete',
      totalStages: 5,
      completedStages: 3,
    }));

    const body = sentBody(fn) as { embeds: Array<{ fields: Array<{ name: string; value: string }> }> };
    const progress = body.embeds[0].fields.find((f: { name: string }) => f.name === 'Progress');
    expect(progress!.value).toBe('3/5');
  });

  it('defaults completedStages to 0 when not set', async () => {
    const fn = mockFetchOk();
    const ch = new WebhookNotificationChannel(
      discordConfig({ events: ['pipeline-start'] }),
    );
    await ch.send(baseEvent({
      type: 'pipeline-start',
      totalStages: 4,
    }));

    const body = sentBody(fn) as { embeds: Array<{ fields: Array<{ name: string; value: string }> }> };
    const progress = body.embeds[0].fields.find((f: { name: string }) => f.name === 'Progress');
    expect(progress!.value).toBe('0/4');
  });

  it('omits fields array from embed when no optional fields present', async () => {
    const fn = mockFetchOk();
    const ch = new WebhookNotificationChannel(
      discordConfig({ events: ['cycle-start'] }),
    );
    await ch.send(baseEvent({ type: 'cycle-start' }));

    const body = sentBody(fn) as { embeds: Array<{ fields?: unknown }> };
    expect(body.embeds[0].fields).toBeUndefined();
  });

  it('uses correct colors for different event types', async () => {
    const fn = mockFetchOk();

    const colorMap: Array<[NotificationEventType, number]> = [
      ['cycle-start', 0x3498db],
      ['cycle-complete', 0x2ecc71],
      ['approval-needed', 0xf1c40f],
      ['error', 0xe74c3c],
      ['pipeline-start', 0x9b59b6],
      ['bot-step-complete', 0x1abc9c],
      ['bot-validation-failed', 0xe67e22],
      ['bot-fix-attempt', 0xf39c12],
      ['bot-steering-received', 0x95a5a6],
    ];

    for (const [eventType, expectedColor] of colorMap) {
      fn.mockClear();
      const ch = new WebhookNotificationChannel(
        discordConfig({ events: [eventType] }),
      );
      await ch.send(baseEvent({ type: eventType }));
      const body = sentBody(fn) as { embeds: Array<{ color: number }> };
      expect(body.embeds[0].color).toBe(expectedColor);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Slack body formatting                                             */
/* ------------------------------------------------------------------ */

describe('Slack body formatting', () => {
  it('sends blocks with header and section', async () => {
    const fn = mockFetchOk();
    const ch = new WebhookNotificationChannel(
      slackConfig({ events: ['cycle-start'] }),
    );
    await ch.send(baseEvent({ type: 'cycle-start', cycle: 2 }));

    const body = sentBody(fn) as { blocks: Array<Record<string, unknown>> };
    expect(body.blocks).toHaveLength(2);

    const header = body.blocks[0] as { type: string; text: { type: string; text: string } };
    expect(header.type).toBe('header');
    expect(header.text.type).toBe('plain_text');
    expect(header.text.text).toBe('Weaver: Cycle Started (Cycle 2)');

    const section = body.blocks[1] as { type: string; text: { type: string; text: string } };
    expect(section.type).toBe('section');
    expect(section.text.type).toBe('mrkdwn');
    expect(section.text.text).toContain('*Project:* /tmp/test-project');
  });

  it('omits cycle from header when cycle is not set', async () => {
    const fn = mockFetchOk();
    const ch = new WebhookNotificationChannel(
      slackConfig({ events: ['error'] }),
    );
    await ch.send(baseEvent({ type: 'error' }));

    const body = sentBody(fn) as { blocks: Array<{ text: { text: string } }> };
    expect(body.blocks[0].text.text).toBe('Weaver: Error');
  });

  it('includes summary, outcome, pipeline, stage, and progress in section', async () => {
    const fn = mockFetchOk();
    const ch = new WebhookNotificationChannel(
      slackConfig({ events: ['pipeline-complete'] }),
    );
    await ch.send(baseEvent({
      type: 'pipeline-complete',
      summary: 'Deployed successfully',
      outcome: 'success',
      pipelineName: 'deploy',
      stageId: 'final',
      totalStages: 3,
      completedStages: 3,
    }));

    const body = sentBody(fn) as { blocks: Array<{ text: { text: string } }> };
    const text = body.blocks[1].text.text;
    expect(text).toContain('*Summary:* Deployed successfully');
    expect(text).toContain('*Outcome:* success');
    expect(text).toContain('*Pipeline:* deploy');
    expect(text).toContain('*Stage:* final');
    expect(text).toContain('*Progress:* 3/3');
  });

  it('includes error truncated to 500 chars in Slack', async () => {
    const fn = mockFetchOk();
    const longError = 'e'.repeat(1000);
    const ch = new WebhookNotificationChannel(
      slackConfig({ events: ['error'] }),
    );
    await ch.send(baseEvent({ type: 'error', error: longError }));

    const body = sentBody(fn) as { blocks: Array<{ text: { text: string } }> };
    const text = body.blocks[1].text.text;
    expect(text).toContain('*Error:*');
    // The error portion should be truncated to 500 chars
    const errorPart = text.split('*Error:* ')[1];
    expect(errorPart).toHaveLength(500);
  });

  it('defaults completedStages to 0 in Slack progress', async () => {
    const fn = mockFetchOk();
    const ch = new WebhookNotificationChannel(
      slackConfig({ events: ['pipeline-start'] }),
    );
    await ch.send(baseEvent({
      type: 'pipeline-start',
      totalStages: 5,
    }));

    const body = sentBody(fn) as { blocks: Array<{ text: { text: string } }> };
    expect(body.blocks[1].text.text).toContain('*Progress:* 0/5');
  });
});

/* ------------------------------------------------------------------ */
/*  Generic webhook body formatting                                   */
/* ------------------------------------------------------------------ */

describe('Generic webhook body formatting', () => {
  it('wraps the event object', async () => {
    const fn = mockFetchOk();
    const ch = new WebhookNotificationChannel(
      webhookConfig({ events: ['cycle-start'] }),
    );
    const event = baseEvent({ type: 'cycle-start', summary: 'test' });
    await ch.send(event);

    const body = sentBody(fn) as { event: NotificationEvent };
    expect(body.event).toEqual(event);
  });
});

/* ------------------------------------------------------------------ */
/*  Fetch details: URL, method, headers                               */
/* ------------------------------------------------------------------ */

describe('Fetch request details', () => {
  it('sends POST to the configured URL', async () => {
    const fn = mockFetchOk();
    const ch = new WebhookNotificationChannel(
      discordConfig({ url: 'https://my-webhook.test/send', events: ['cycle-start'] }),
    );
    await ch.send(baseEvent());

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0]).toBe('https://my-webhook.test/send');
    expect(fn.mock.calls[0][1].method).toBe('POST');
  });

  it('always includes Content-Type application/json', async () => {
    const fn = mockFetchOk();
    const ch = new WebhookNotificationChannel(
      discordConfig({ events: ['cycle-start'] }),
    );
    await ch.send(baseEvent());

    const headers = sentHeaders(fn);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('includes custom headers alongside Content-Type', async () => {
    const fn = mockFetchOk();
    const ch = new WebhookNotificationChannel(
      webhookConfig({
        events: ['cycle-start'],
        headers: { Authorization: 'Bearer token123', 'X-Custom': 'value' },
      }),
    );
    await ch.send(baseEvent());

    const headers = sentHeaders(fn);
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Authorization']).toBe('Bearer token123');
    expect(headers['X-Custom']).toBe('value');
  });
});

/* ------------------------------------------------------------------ */
/*  Retry behavior                                                    */
/* ------------------------------------------------------------------ */

describe('Retry behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries up to 3 times on non-ok response', async () => {
    const fn = mockFetchFail(500, 'Server Error');
    const errorHandler = vi.fn();
    const ch = new WebhookNotificationChannel(
      discordConfig({ events: ['error'] }),
      errorHandler,
    );

    const sendPromise = ch.send(baseEvent({ type: 'error' }));

    // Advance past retry delays: 1000ms, 2000ms
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await sendPromise;

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('retries up to 3 times on fetch throws', async () => {
    const fn = mockFetchThrow('connection refused');
    const errorHandler = vi.fn();
    const ch = new WebhookNotificationChannel(
      discordConfig({ events: ['error'] }),
      errorHandler,
    );

    const sendPromise = ch.send(baseEvent({ type: 'error' }));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await sendPromise;

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry when the first attempt succeeds', async () => {
    const fn = mockFetchOk();
    const ch = new WebhookNotificationChannel(
      discordConfig({ events: ['cycle-start'] }),
    );

    await ch.send(baseEvent());
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('stops retrying after first success', async () => {
    const fn = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Unavailable' })
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK' });
    globalThis.fetch = fn as unknown as typeof fetch;

    const ch = new WebhookNotificationChannel(
      discordConfig({ events: ['cycle-start'] }),
    );

    const sendPromise = ch.send(baseEvent());
    await vi.advanceTimersByTimeAsync(1000);
    await sendPromise;

    expect(fn).toHaveBeenCalledTimes(2);
  });
});

/* ------------------------------------------------------------------ */
/*  Error handler callback                                            */
/* ------------------------------------------------------------------ */

describe('Error handler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls onError after all retries exhausted (non-ok responses)', async () => {
    mockFetchFail(502, 'Bad Gateway');
    const errorHandler = vi.fn();
    const ch = new WebhookNotificationChannel(
      discordConfig({ events: ['error'] }),
      errorHandler,
    );

    const event = baseEvent({ type: 'error', error: 'something broke' });
    const sendPromise = ch.send(event);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await sendPromise;

    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler).toHaveBeenCalledWith(
      'discord',
      event,
      expect.stringContaining('failed after 3 attempts'),
    );
    expect(errorHandler.mock.calls[0][2]).toContain('502');
  });

  it('calls onError after all retries exhausted (fetch throws)', async () => {
    mockFetchThrow('ECONNREFUSED');
    const errorHandler = vi.fn();
    const ch = new WebhookNotificationChannel(
      slackConfig({ events: ['error'] }),
      errorHandler,
    );

    const event = baseEvent({ type: 'error' });
    const sendPromise = ch.send(event);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await sendPromise;

    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler).toHaveBeenCalledWith(
      'slack',
      event,
      expect.stringContaining('error after 3 attempts'),
    );
    expect(errorHandler.mock.calls[0][2]).toContain('ECONNREFUSED');
  });

  it('does not call onError when no handler is provided', async () => {
    mockFetchFail(500, 'Server Error');
    const ch = new WebhookNotificationChannel(
      discordConfig({ events: ['error'] }),
      // no error handler
    );

    const sendPromise = ch.send(baseEvent({ type: 'error' }));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    // Should not throw
    await expect(sendPromise).resolves.toBeUndefined();
  });

  it('does not call onError when fetch eventually succeeds', async () => {
    const fn = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Error' })
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK' });
    globalThis.fetch = fn as unknown as typeof fetch;

    const errorHandler = vi.fn();
    const ch = new WebhookNotificationChannel(
      discordConfig({ events: ['cycle-start'] }),
      errorHandler,
    );

    const sendPromise = ch.send(baseEvent());
    await vi.advanceTimersByTimeAsync(1000);
    await sendPromise;

    expect(errorHandler).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  Channel name                                                      */
/* ------------------------------------------------------------------ */

describe('Channel name property', () => {
  it('is set to the channel type from config', () => {
    expect(new WebhookNotificationChannel(discordConfig()).name).toBe('discord');
    expect(new WebhookNotificationChannel(slackConfig()).name).toBe('slack');
    expect(new WebhookNotificationChannel(webhookConfig()).name).toBe('webhook');
  });
});

/* ------------------------------------------------------------------ */
/*  createNotifier                                                    */
/* ------------------------------------------------------------------ */

describe('createNotifier', () => {
  it('returns a function', () => {
    const notifier = createNotifier([]);
    expect(typeof notifier).toBe('function');
  });

  it('dispatches to multiple channels via Promise.allSettled', async () => {
    const send1 = vi.fn().mockResolvedValue(undefined);
    const send2 = vi.fn().mockResolvedValue(undefined);

    const ch1: NotificationChannel = {
      name: 'ch1',
      shouldSend: () => true,
      send: send1,
    };
    const ch2: NotificationChannel = {
      name: 'ch2',
      shouldSend: () => true,
      send: send2,
    };

    const notifier = createNotifier([ch1, ch2]);
    const event = baseEvent();
    await notifier(event);

    expect(send1).toHaveBeenCalledWith(event);
    expect(send2).toHaveBeenCalledWith(event);
  });

  it('does not throw when a channel fails', async () => {
    const failCh: NotificationChannel = {
      name: 'failing',
      shouldSend: () => true,
      send: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const okCh: NotificationChannel = {
      name: 'ok',
      shouldSend: () => true,
      send: vi.fn().mockResolvedValue(undefined),
    };

    const notifier = createNotifier([failCh, okCh]);
    // Should not throw thanks to Promise.allSettled
    await expect(notifier(baseEvent())).resolves.toBeUndefined();
    expect(okCh.send).toHaveBeenCalled();
  });

  it('does nothing with an empty channels array', async () => {
    const notifier = createNotifier([]);
    await expect(notifier(baseEvent())).resolves.toBeUndefined();
  });

  it('passes events to each channel send method', async () => {
    const fn = mockFetchOk();
    const discord = new WebhookNotificationChannel(discordConfig({ events: ['error'] }));
    const slack = new WebhookNotificationChannel(slackConfig({ events: ['error'] }));

    const notifier = createNotifier([discord, slack]);
    await notifier(baseEvent({ type: 'error', error: 'test error' }));

    // Both channels should have called fetch
    expect(fn).toHaveBeenCalledTimes(2);

    // Verify Discord body (first call)
    const discordBody = sentBody(fn, 0) as { embeds?: unknown };
    expect(discordBody.embeds).toBeDefined();

    // Verify Slack body (second call)
    const slackBody = sentBody(fn, 1) as { blocks?: unknown };
    expect(slackBody.blocks).toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/*  Event label mapping                                               */
/* ------------------------------------------------------------------ */

describe('Event labels in Discord titles', () => {
  const labelMap: Array<[NotificationEventType, string]> = [
    ['workflow-start', 'Workflow Started'],
    ['workflow-complete', 'Workflow Complete'],
    ['cycle-start', 'Cycle Started'],
    ['cycle-complete', 'Cycle Complete'],
    ['approval-needed', 'Approval Needed'],
    ['error', 'Error'],
    ['pipeline-start', 'Pipeline Started'],
    ['pipeline-complete', 'Pipeline Complete'],
    ['stage-start', 'Stage Started'],
    ['stage-complete', 'Stage Complete'],
    ['bot-task-start', 'Bot Task Started'],
    ['bot-task-complete', 'Bot Task Complete'],
    ['bot-plan-ready', 'Bot Plan Ready'],
    ['bot-step-complete', 'Bot Step Complete'],
    ['bot-validation-failed', 'Bot Validation Failed'],
    ['bot-fix-attempt', 'Bot Fix Attempt'],
    ['bot-session-start', 'Bot Session Started'],
    ['bot-session-end', 'Bot Session Ended'],
    ['bot-steering-received', 'Bot Steering Received'],
  ];

  it.each(labelMap)('maps %s to "%s"', async (eventType, label) => {
    const fn = mockFetchOk();
    const ch = new WebhookNotificationChannel(
      discordConfig({ events: [eventType] }),
    );
    await ch.send(baseEvent({ type: eventType }));

    const body = sentBody(fn) as { embeds: Array<{ title: string }> };
    expect(body.embeds[0].title).toContain(label);
  });
});

/* ------------------------------------------------------------------ */
/*  Slack event labels                                                */
/* ------------------------------------------------------------------ */

describe('Event labels in Slack headers', () => {
  it.each([
    ['approval-needed' as const, 'Approval Needed'],
    ['bot-plan-ready' as const, 'Bot Plan Ready'],
  ])('maps %s to "%s" in Slack header', async (eventType, label) => {
    const fn = mockFetchOk();
    const ch = new WebhookNotificationChannel(
      slackConfig({ events: [eventType] }),
    );
    await ch.send(baseEvent({ type: eventType }));

    const body = sentBody(fn) as { blocks: Array<{ text: { text: string } }> };
    expect(body.blocks[0].text.text).toContain(label);
  });
});

/* ------------------------------------------------------------------ */
/*  Combined event with many fields                                   */
/* ------------------------------------------------------------------ */

describe('Rich event with all optional fields', () => {
  it('includes all fields in Discord embed', async () => {
    const fn = mockFetchOk();
    const ch = new WebhookNotificationChannel(
      discordConfig({ events: ['cycle-complete'] }),
    );
    await ch.send(baseEvent({
      type: 'cycle-complete',
      cycle: 5,
      summary: 'Refactored module',
      outcome: 'success',
      pipelineName: 'ci-pipeline',
      stageId: 'test-stage',
      totalStages: 10,
      completedStages: 7,
      error: 'minor warning',
      diff: {
        summary: {
          nodeTypesAdded: 1,
          nodeTypesRemoved: 0,
          connectionsAdded: 3,
          connectionsRemoved: 2,
        },
      },
    }));

    const body = sentBody(fn) as { embeds: Array<{ fields: Array<{ name: string; value: string }> }> };
    const fieldNames = body.embeds[0].fields.map((f: { name: string }) => f.name);
    expect(fieldNames).toEqual([
      'Summary',
      'Outcome',
      'Nodes',
      'Connections',
      'Pipeline',
      'Stage',
      'Progress',
      'Error',
    ]);
  });

  it('includes all parts in Slack section text', async () => {
    const fn = mockFetchOk();
    const ch = new WebhookNotificationChannel(
      slackConfig({ events: ['cycle-complete'] }),
    );
    await ch.send(baseEvent({
      type: 'cycle-complete',
      cycle: 5,
      summary: 'Refactored module',
      outcome: 'success',
      pipelineName: 'ci-pipeline',
      stageId: 'test-stage',
      totalStages: 10,
      completedStages: 7,
      error: 'minor warning',
    }));

    const body = sentBody(fn) as { blocks: Array<{ text: { text: string } }> };
    const text = body.blocks[1].text.text;
    expect(text).toContain('*Project:*');
    expect(text).toContain('*Summary:*');
    expect(text).toContain('*Outcome:*');
    expect(text).toContain('*Pipeline:*');
    expect(text).toContain('*Stage:*');
    expect(text).toContain('*Progress:*');
    expect(text).toContain('*Error:*');
  });
});
