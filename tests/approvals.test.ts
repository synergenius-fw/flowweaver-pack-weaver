import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApprovalHandler } from '../src/bot/approvals.js';
import type { ApprovalRequest, ApprovalHandler, ApprovalHandlerOptions } from '../src/bot/approvals.js';
import type { NotificationEvent } from '../src/bot/types.js';

// Shared fixtures
const baseEvent: NotificationEvent = {
  type: 'approval_needed',
  botName: 'test-bot',
  message: 'Need approval for action',
};

const baseRequest: ApprovalRequest = {
  context: { tool: 'shell', command: 'ls' },
  prompt: 'Run ls?',
};

function makeOptions(overrides: Partial<ApprovalHandlerOptions> = {}): ApprovalHandlerOptions {
  return {
    timeoutSeconds: 0.05, // 50ms for fast tests
    notifier: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('createApprovalHandler factory', () => {
  it('returns a handler for "auto" mode', () => {
    const handler = createApprovalHandler('auto', makeOptions());
    expect(handler).toBeDefined();
    expect(handler.handle).toBeInstanceOf(Function);
  });

  it('returns a handler for "prompt" mode', () => {
    const handler = createApprovalHandler('prompt', makeOptions());
    expect(handler).toBeDefined();
    expect(handler.handle).toBeInstanceOf(Function);
  });

  it('returns a handler for "webhook" mode', () => {
    const handler = createApprovalHandler('webhook', makeOptions({ webhookUrl: 'http://example.com' }));
    expect(handler).toBeDefined();
  });

  it('returns a handler for "timeout-auto" mode', () => {
    const handler = createApprovalHandler('timeout-auto', makeOptions());
    expect(handler).toBeDefined();
  });

  it('returns a handler for "web" mode', () => {
    const handler = createApprovalHandler('web', makeOptions());
    expect(handler).toBeDefined();
  });
});

describe('AutoApproval', () => {
  it('auto-approves and calls notifier', async () => {
    const notifier = vi.fn(async () => {});
    const handler = createApprovalHandler('auto', makeOptions({ notifier }));

    const result = await handler.handle(baseRequest, baseEvent);

    expect(result.approved).toBe(true);
    expect(result.reason).toContain('auto');
    expect(notifier).toHaveBeenCalledWith(baseEvent);
  });
});

describe('TimeoutAutoApproval', () => {
  it('auto-approves after timeout and calls notifier', async () => {
    const notifier = vi.fn(async () => {});
    const handler = createApprovalHandler('timeout-auto', makeOptions({ timeoutSeconds: 0.01, notifier }));

    const result = await handler.handle(baseRequest, baseEvent);

    expect(result.approved).toBe(true);
    expect(result.reason).toContain('timeout');
    expect(notifier).toHaveBeenCalledWith(baseEvent);
  });
});

describe('WebhookApproval', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('falls back to auto-approve when webhookUrl is empty', async () => {
    const handler = createApprovalHandler('webhook', makeOptions({
      webhookUrl: '',
      timeoutSeconds: 0.01,
    }));

    const result = await handler.handle(baseRequest, baseEvent);

    expect(result.approved).toBe(true);
    expect(result.reason).toContain('no webhookUrl');
  });

  it('logs an error when webhookUrl is empty', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = createApprovalHandler('webhook', makeOptions({
      webhookUrl: '',
      timeoutSeconds: 0.01,
    }));

    await handler.handle(baseRequest, baseEvent);

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('webhookUrl'),
    );
    errSpy.mockRestore();
  });

  it('falls back to auto-approve when POST fails with non-ok status', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 500 }));

    const handler = createApprovalHandler('webhook', makeOptions({
      webhookUrl: 'http://example.com/approve',
      timeoutSeconds: 0.01,
    }));

    const result = await handler.handle(baseRequest, baseEvent);

    expect(result.approved).toBe(true);
    expect(result.reason).toContain('webhook error');
  });

  it('falls back to auto-approve when fetch throws a network error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const handler = createApprovalHandler('webhook', makeOptions({
      webhookUrl: 'http://example.com/approve',
      timeoutSeconds: 0.01,
    }));

    const result = await handler.handle(baseRequest, baseEvent);

    expect(result.approved).toBe(true);
    expect(result.reason).toContain('webhook error');
  });

  it('returns approval when webhook poll responds with approved', async () => {
    // POST succeeds with location header
    fetchSpy.mockResolvedValueOnce(new Response(null, {
      status: 200,
      headers: { location: 'http://example.com/status/123' },
    }));
    // Poll returns approved
    fetchSpy.mockResolvedValueOnce(new Response(
      JSON.stringify({ approved: true, reason: 'operator approved' }),
      { status: 200 },
    ));

    const handler = createApprovalHandler('webhook', makeOptions({
      webhookUrl: 'http://example.com/approve',
      timeoutSeconds: 10, // long timeout, but poll resolves immediately
    }));

    const result = await handler.handle(baseRequest, baseEvent);

    expect(result.approved).toBe(true);
    expect(result.reason).toBe('operator approved');
  });

  it('returns rejection when webhook poll responds with rejected', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, {
      status: 200,
      headers: { location: 'http://example.com/status/123' },
    }));
    fetchSpy.mockResolvedValueOnce(new Response(
      JSON.stringify({ approved: false, reason: 'operator rejected' }),
      { status: 200 },
    ));

    const handler = createApprovalHandler('webhook', makeOptions({
      webhookUrl: 'http://example.com/approve',
      timeoutSeconds: 10,
    }));

    const result = await handler.handle(baseRequest, baseEvent);

    expect(result.approved).toBe(false);
    expect(result.reason).toBe('operator rejected');
  });

  it('logs a warning when polling encounters an error', async () => {
    // POST succeeds
    fetchSpy.mockResolvedValueOnce(new Response(null, {
      status: 200,
      headers: { location: 'http://example.com/status/123' },
    }));
    // First poll throws error, then times out
    fetchSpy.mockRejectedValueOnce(new Error('DNS failure'));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const handler = createApprovalHandler('webhook', makeOptions({
      webhookUrl: 'http://example.com/approve',
      timeoutSeconds: 0.01, // very short so it times out after the error
    }));

    await handler.handle(baseRequest, baseEvent);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('poll'),
    );
    warnSpy.mockRestore();
  });
});

describe('LazyWebApproval', () => {
  it('logs a warning when dynamic import fails', async () => {
    // Mock the web-approval module to throw on import
    vi.doMock('../src/bot/web-approval.js', () => {
      throw new Error('Cannot find module web-approval.js');
    });

    // Re-import to get a fresh module that will use the mocked import
    const { createApprovalHandler: freshFactory } = await import('../src/bot/approvals.js');
    const handler = freshFactory('web', makeOptions());

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // After the fix, it should log a warning and re-throw with context
    await expect(handler.handle(baseRequest, baseEvent)).rejects.toThrow();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('web-approval'),
    );
    warnSpy.mockRestore();
    vi.doUnmock('../src/bot/web-approval.js');
  });
});
