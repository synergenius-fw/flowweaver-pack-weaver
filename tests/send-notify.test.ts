import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WeaverContext } from '../src/bot/types.js';

vi.mock('../src/bot/audit-logger.js', () => ({
  auditEmit: vi.fn(),
}));

import { auditEmit } from '../src/bot/audit-logger.js';
import { weaverSendNotify } from '../src/node-types/send-notify.js';

const mockAuditEmit = vi.mocked(auditEmit);

function makeCtx(overrides: Partial<WeaverContext> = {}): string {
  const ctx: WeaverContext = {
    env: {
      projectDir: '/proj',
      config: { provider: 'auto' as const },
      providerType: 'anthropic' as const,
      providerInfo: { type: 'anthropic' as const, apiKey: 'key' },
    },
    taskJson: '{}',
    hasTask: true,
    ...overrides,
  };
  return JSON.stringify(ctx);
}

describe('weaverSendNotify', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
  });

  describe('no notify config', () => {
    it('returns ctx unchanged when no notify channels configured', () => {
      const input = makeCtx();
      const result = weaverSendNotify(input);
      expect(result.ctx).toBe(input);
    });

    it('does not call fetch when no channels', () => {
      weaverSendNotify(makeCtx());
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('does not call auditEmit when no channels', () => {
      weaverSendNotify(makeCtx());
      expect(mockAuditEmit).not.toHaveBeenCalled();
    });

    it('does not log when no channels', () => {
      weaverSendNotify(makeCtx());
      expect(vi.mocked(console.log)).not.toHaveBeenCalled();
    });
  });

  describe('single generic channel', () => {
    it('calls fetch with POST for a generic channel on success event', () => {
      const ctx = makeCtx({
        resultJson: JSON.stringify({ success: true, outcome: 'applied' }),
        env: {
          projectDir: '/proj',
          config: {
            provider: 'auto' as const,
            notify: [{ channel: 'generic', url: 'https://example.com/hook', events: ['workflow-complete'] }],
          } as any,
          providerType: 'anthropic' as const,
          providerInfo: { type: 'anthropic' as const, apiKey: 'key' },
        },
      });
      weaverSendNotify(ctx);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://example.com/hook',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('skips channel when event type does not match', () => {
      const ctx = makeCtx({
        resultJson: JSON.stringify({ success: true }),
        env: {
          projectDir: '/proj',
          config: {
            provider: 'auto' as const,
            notify: [{ channel: 'generic', url: 'https://example.com/hook', events: ['error'] }],
          } as any,
          providerType: 'anthropic' as const,
          providerInfo: { type: 'anthropic' as const, apiKey: 'key' },
        },
      });
      weaverSendNotify(ctx);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('calls fetch for error event when result.success=false', () => {
      const ctx = makeCtx({
        resultJson: JSON.stringify({ success: false, outcome: 'error' }),
        env: {
          projectDir: '/proj',
          config: {
            provider: 'auto' as const,
            notify: [{ channel: 'generic', url: 'https://example.com/hook', events: ['error'] }],
          } as any,
          providerType: 'anthropic' as const,
          providerInfo: { type: 'anthropic' as const, apiKey: 'key' },
        },
      });
      weaverSendNotify(ctx);
      expect(fetchSpy).toHaveBeenCalled();
    });

    it('calls auditEmit with channelCount=1 when notification sent', () => {
      const ctx = makeCtx({
        resultJson: JSON.stringify({ success: true }),
        env: {
          projectDir: '/proj',
          config: {
            provider: 'auto' as const,
            notify: [{ channel: 'generic', url: 'https://example.com/hook', events: ['workflow-complete'] }],
          } as any,
          providerType: 'anthropic' as const,
          providerInfo: { type: 'anthropic' as const, apiKey: 'key' },
        },
      });
      weaverSendNotify(ctx);
      expect(mockAuditEmit).toHaveBeenCalledWith('notification-sent', { channelCount: 1 });
    });

    it('logs notification count', () => {
      const ctx = makeCtx({
        resultJson: JSON.stringify({ success: true }),
        env: {
          projectDir: '/proj',
          config: {
            provider: 'auto' as const,
            notify: [{ channel: 'generic', url: 'https://example.com/hook', events: ['workflow-complete'] }],
          } as any,
          providerType: 'anthropic' as const,
          providerInfo: { type: 'anthropic' as const, apiKey: 'key' },
        },
      });
      weaverSendNotify(ctx);
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('1 notification'),
      );
    });
  });

  describe('discord channel', () => {
    it('sends Discord embed body with green color on success', () => {
      const ctx = makeCtx({
        resultJson: JSON.stringify({ success: true, outcome: 'applied', summary: 'Done' }),
        env: {
          projectDir: '/proj',
          config: {
            provider: 'auto' as const,
            notify: [{ channel: 'discord', url: 'https://discord.com/api/webhooks/x', events: ['workflow-complete'] }],
          } as any,
          providerType: 'anthropic' as const,
          providerInfo: { type: 'anthropic' as const, apiKey: 'key' },
        },
      });
      weaverSendNotify(ctx);
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.embeds[0].color).toBe(0x22c55e); // green
    });

    it('sends Discord embed body with red color on failure', () => {
      const ctx = makeCtx({
        resultJson: JSON.stringify({ success: false, outcome: 'error', summary: 'Oops' }),
        env: {
          projectDir: '/proj',
          config: {
            provider: 'auto' as const,
            notify: [{ channel: 'discord', url: 'https://discord.com/api/webhooks/x', events: ['error'] }],
          } as any,
          providerType: 'anthropic' as const,
          providerInfo: { type: 'anthropic' as const, apiKey: 'key' },
        },
      });
      weaverSendNotify(ctx);
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.embeds[0].color).toBe(0xef4444); // red
    });
  });

  describe('slack channel', () => {
    it('sends Slack blocks body', () => {
      const ctx = makeCtx({
        resultJson: JSON.stringify({ success: true, outcome: 'applied', summary: 'Done' }),
        env: {
          projectDir: '/proj',
          config: {
            provider: 'auto' as const,
            notify: [{ channel: 'slack', url: 'https://hooks.slack.com/x', events: ['workflow-complete'] }],
          } as any,
          providerType: 'anthropic' as const,
          providerInfo: { type: 'anthropic' as const, apiKey: 'key' },
        },
      });
      weaverSendNotify(ctx);
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(Array.isArray(body.blocks)).toBe(true);
    });
  });

  describe('notify as single object (not array)', () => {
    it('accepts a single notify object (not wrapped in array)', () => {
      const ctx = makeCtx({
        resultJson: JSON.stringify({ success: true }),
        env: {
          projectDir: '/proj',
          config: {
            provider: 'auto' as const,
            notify: { channel: 'generic', url: 'https://example.com/hook', events: ['workflow-complete'] },
          } as any,
          providerType: 'anthropic' as const,
          providerInfo: { type: 'anthropic' as const, apiKey: 'key' },
        },
      });
      weaverSendNotify(ctx);
      expect(fetchSpy).toHaveBeenCalled();
    });
  });

  describe('ctx pass-through', () => {
    it('returns the original ctx string unchanged', () => {
      const input = makeCtx({
        env: {
          projectDir: '/proj',
          config: { provider: 'auto' as const },
          providerType: 'anthropic' as const,
          providerInfo: { type: 'anthropic' as const, apiKey: 'key' },
        },
      });
      const result = weaverSendNotify(input);
      expect(result.ctx).toBe(input);
    });
  });

  describe('no resultJson in context', () => {
    it('does not throw when resultJson is absent', () => {
      const ctx = makeCtx({
        env: {
          projectDir: '/proj',
          config: {
            provider: 'auto' as const,
            notify: [{ channel: 'generic', url: 'https://example.com/hook', events: ['error'] }],
          } as any,
          providerType: 'anthropic' as const,
          providerInfo: { type: 'anthropic' as const, apiKey: 'key' },
        },
      });
      expect(() => weaverSendNotify(ctx)).not.toThrow();
    });
  });
});
