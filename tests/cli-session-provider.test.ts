import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock heavy dependencies before importing the module ───────────────────────

vi.mock('@synergenius/flow-weaver/agent', () => ({
  runAgentLoop: vi.fn(),
  createAnthropicProvider: vi.fn(),
  getOrCreateCliSession: vi.fn(),
  killAllCliSessions: vi.fn(),
}));

vi.mock('../../src/bot/weaver-tools.js', () => ({
  WEAVER_TOOLS: [],
  createWeaverExecutor: vi.fn(),
}));

vi.mock('../../src/bot/audit-logger.js', () => ({
  auditEmit: vi.fn(),
}));

vi.mock('../../src/bot/retry-utils.js', () => ({
  withRetry: vi.fn(),
}));

vi.mock('../../src/bot/cost-tracker.js', () => ({
  CostTracker: { estimateCost: vi.fn().mockReturnValue(0) },
}));

import { CliSessionProvider } from '../../src/node-types/agent-execute.js';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Drain an async generator into an array. */
async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of gen) items.push(item);
  return items;
}

type FakeSession = {
  ready: boolean;
  spawn: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
};

function makeSession(ready = false): FakeSession {
  return {
    ready,
    spawn: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockImplementation(async function* () {
      yield { type: 'text_delta', text: 'response' };
    }),
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('CliSessionProvider — spawn behaviour', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls session.spawn() when session.ready=false', async () => {
    const session = makeSession(false);
    const provider = new CliSessionProvider(session as any);

    await collect(provider.stream([{ role: 'user', content: 'hello' }], []));

    expect(session.spawn).toHaveBeenCalledOnce();
  });

  it('does not call session.spawn() when session.ready=true', async () => {
    const session = makeSession(true);
    const provider = new CliSessionProvider(session as any);

    await collect(provider.stream([{ role: 'user', content: 'hello' }], []));

    expect(session.spawn).not.toHaveBeenCalled();
  });
});

describe('CliSessionProvider — sentCount / incremental delivery', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends only new messages on subsequent calls', async () => {
    const session = makeSession(true);
    const provider = new CliSessionProvider(session as any);

    // First call: one user message
    await collect(provider.stream([{ role: 'user', content: 'first' }], []));
    expect(session.send).toHaveBeenCalledTimes(1);
    expect(session.send.mock.calls[0][0]).toBe('first');

    // Second call: assistant reply added, then a new user message
    const msgs2 = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ];
    await collect(provider.stream(msgs2, []));

    expect(session.send).toHaveBeenCalledTimes(2);
    // Only the new user message should appear (assistant messages are filtered out)
    expect(session.send.mock.calls[1][0]).toBe('second');
  });

  it('tool messages are included in the incremental prompt', async () => {
    const session = makeSession(true);
    const provider = new CliSessionProvider(session as any);

    const msgs = [
      { role: 'tool', content: 'file contents', toolCallId: 'tc-42' },
    ];
    await collect(provider.stream(msgs, []));

    expect(session.send.mock.calls[0][0]).toContain('Tool result (tc-42): file contents');
  });

  it('assistant-only new messages produce an empty prompt and yield nothing', async () => {
    const session = makeSession(true);
    const provider = new CliSessionProvider(session as any);

    // Seed sentCount to 1
    await collect(provider.stream([{ role: 'user', content: 'hi' }], []));

    // New message is assistant-only — should not trigger send
    const msgs2 = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'automated reply' },
    ];
    const events = await collect(provider.stream(msgs2, []));

    expect(events).toHaveLength(0);
    expect(session.send).toHaveBeenCalledTimes(1); // only the first call
  });
});

describe('CliSessionProvider — resetForNewTask()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resets sentCount to 0 so the same messages are re-sent', async () => {
    const session = makeSession(true);
    const provider = new CliSessionProvider(session as any);

    const msgs = [{ role: 'user', content: 'hello' }];

    // First call advances sentCount to 1
    await collect(provider.stream(msgs, []));
    expect(session.send).toHaveBeenCalledTimes(1);

    // Second call with same messages → sentCount=1, slice(1)=[] → no send
    await collect(provider.stream(msgs, []));
    expect(session.send).toHaveBeenCalledTimes(1);

    // Reset — sentCount back to 0
    provider.resetForNewTask();

    // Same messages again → slice(0)=all → re-sent
    await collect(provider.stream(msgs, []));
    expect(session.send).toHaveBeenCalledTimes(2);
    expect(session.send.mock.calls[1][0]).toBe('hello');
  });
});

describe('CliSessionProvider — empty prompt guard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('yields nothing and skips send when no new messages exist', async () => {
    const session = makeSession(true);
    const provider = new CliSessionProvider(session as any);

    const msgs = [{ role: 'user', content: 'ping' }];
    await collect(provider.stream(msgs, [])); // sentCount → 1

    // Same array on second call → newMessages=[] → prompt='' → early return
    const events = await collect(provider.stream(msgs, []));

    expect(events).toHaveLength(0);
    expect(session.send).toHaveBeenCalledTimes(1);
  });

  it('forwards all yielded stream events from session.send', async () => {
    const session = makeSession(true);
    session.send.mockImplementation(async function* () {
      yield { type: 'text_delta', text: 'chunk1' };
      yield { type: 'text_delta', text: 'chunk2' };
    });
    const provider = new CliSessionProvider(session as any);

    const events = await collect(
      provider.stream([{ role: 'user', content: 'hi' }], []),
    );

    expect(events).toHaveLength(2);
    expect((events[0] as any).text).toBe('chunk1');
    expect((events[1] as any).text).toBe('chunk2');
  });
});
