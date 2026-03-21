import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock all heavy machinery so weaverAgentExecute runs to completion ─────────

vi.mock('@synergenius/flow-weaver/agent', () => ({
  runAgentLoop: vi.fn(),
  createAnthropicProvider: vi.fn(),
  getOrCreateCliSession: vi.fn(),
  killAllCliSessions: vi.fn(),
}));

vi.mock('../src/bot/weaver-tools.js', () => ({
  WEAVER_TOOLS: [],
  createWeaverExecutor: vi.fn().mockReturnValue({}),
}));

vi.mock('../src/bot/audit-logger.js', () => ({
  auditEmit: vi.fn(),
}));

vi.mock('../src/bot/retry-utils.js', () => ({
  withRetry: vi.fn().mockImplementation((fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../src/bot/cost-tracker.js', () => ({
  CostTracker: { estimateCost: vi.fn().mockReturnValue(0) },
}));

vi.mock('../src/bot/system-prompt.js', () => ({
  buildSystemPrompt: vi.fn().mockResolvedValue('system'),
  buildBotSystemPrompt: vi.fn().mockReturnValue('bot'),
}));

const { MockTerminalRenderer } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const MockTerminalRenderer = vi.fn(function (this: any) {
    this.onToolEvent = vi.fn();
    this.onStreamEvent = vi.fn();
    this.taskEnd = vi.fn();
    this.warn = vi.fn();
    this.error = vi.fn();
  }) as any;
  return { MockTerminalRenderer };
});

vi.mock('../src/bot/terminal-renderer.js', () => ({
  TerminalRenderer: MockTerminalRenderer,
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import {
  createAnthropicProvider,
  getOrCreateCliSession,
  runAgentLoop,
} from '@synergenius/flow-weaver/agent';
import { CliSessionProvider, weaverAgentExecute } from '../src/node-types/agent-execute.js';

const mockedCreateAnthropicProvider = vi.mocked(createAnthropicProvider);
const mockedGetOrCreateCliSession = vi.mocked(getOrCreateCliSession);
const mockedRunAgentLoop = vi.mocked(runAgentLoop);

// ── helpers ───────────────────────────────────────────────────────────────────

const MOCK_SESSION = {
  ready: false,
  spawn: vi.fn().mockResolvedValue(undefined),
  send: vi.fn(),
};

const MOCK_ANTHROPIC_PROVIDER = { _kind: 'anthropic' };

const AGENT_SUCCESS = {
  success: true,
  summary: 'done',
  toolCallCount: 1,
  usage: { promptTokens: 10, completionTokens: 5 },
};

function makeCtx(providerInfo: Record<string, unknown>): string {
  return JSON.stringify({
    env: {
      projectDir: '/test',
      config: { provider: 'auto' },
      providerType: providerInfo.type,
      providerInfo,
    },
    taskJson: JSON.stringify({ instruction: 'test task', targets: [] }),
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('createProvider (via weaverAgentExecute)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockedRunAgentLoop.mockResolvedValue(AGENT_SUCCESS as any);
    mockedCreateAnthropicProvider.mockReturnValue(MOCK_ANTHROPIC_PROVIDER as any);
    mockedGetOrCreateCliSession.mockReturnValue(MOCK_SESSION as any);
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  // ── anthropic with apiKey ────────────────────────────────────────────────────

  it("type='anthropic' with apiKey calls createAnthropicProvider with the key", async () => {
    await weaverAgentExecute(
      true,
      makeCtx({ type: 'anthropic', apiKey: 'sk-test-key', model: 'claude-opus-4-6' }),
    );

    expect(mockedCreateAnthropicProvider).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-test-key', model: 'claude-opus-4-6' }),
    );
    expect(mockedGetOrCreateCliSession).not.toHaveBeenCalled();
  });

  // ── claude-cli ───────────────────────────────────────────────────────────────

  it("type='claude-cli' calls getOrCreateCliSession and wraps result in CliSessionProvider", async () => {
    await weaverAgentExecute(true, makeCtx({ type: 'claude-cli' }));

    expect(mockedGetOrCreateCliSession).toHaveBeenCalled();
    expect(mockedCreateAnthropicProvider).not.toHaveBeenCalled();

    // Provider passed to runAgentLoop must be a CliSessionProvider
    const provider = mockedRunAgentLoop.mock.calls[0][0];
    expect(provider).toBeInstanceOf(CliSessionProvider);
  });

  // ── auto with env key ────────────────────────────────────────────────────────

  it("type='auto' with ANTHROPIC_API_KEY set uses createAnthropicProvider", async () => {
    process.env.ANTHROPIC_API_KEY = 'env-key-123';

    await weaverAgentExecute(true, makeCtx({ type: 'auto' }));

    expect(mockedCreateAnthropicProvider).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'env-key-123' }),
    );
    expect(mockedGetOrCreateCliSession).not.toHaveBeenCalled();
  });

  // ── auto without env key ─────────────────────────────────────────────────────

  it("type='auto' without ANTHROPIC_API_KEY falls back to CliSessionProvider", async () => {
    delete process.env.ANTHROPIC_API_KEY;

    await weaverAgentExecute(true, makeCtx({ type: 'auto' }));

    expect(mockedGetOrCreateCliSession).toHaveBeenCalled();
    expect(mockedCreateAnthropicProvider).not.toHaveBeenCalled();

    const provider = mockedRunAgentLoop.mock.calls[0][0];
    expect(provider).toBeInstanceOf(CliSessionProvider);
  });

  // ── unsupported type ─────────────────────────────────────────────────────────

  it('unsupported type causes onFailure=true with error message containing the type name', async () => {
    const result = await weaverAgentExecute(true, makeCtx({ type: 'openai' }));

    expect(result.onSuccess).toBe(false);
    expect(result.onFailure).toBe(true);
    expect(mockedRunAgentLoop).not.toHaveBeenCalled();

    const ctx = JSON.parse(result.ctx);
    const resultData = JSON.parse(ctx.resultJson);
    expect(resultData.error).toContain('openai');
  });
});

// ── CliSessionProvider.stream() delta tracking ────────────────────────────────

describe('CliSessionProvider.stream() delta tracking', () => {
  // Build a fresh mock session for each test
  function makeSession(ready: boolean) {
    const send = vi.fn().mockImplementation(async function* (_msg: string) {
      yield { type: 'text_delta' as const, content: 'ok' };
    });
    const spawn = vi.fn().mockResolvedValue(undefined);
    return { ready, spawn, send };
  }

  async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
    const items: T[] = [];
    for await (const item of gen) items.push(item);
    return items;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msg1 = { role: 'user' as const, content: 'hello' } as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msg2 = { role: 'user' as const, content: 'world' } as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msg3 = { role: 'user' as const, content: 'third' } as any;

  // ── first call ───────────────────────────────────────────────────────────────

  it('first call sends all messages (sentCount starts at 0)', async () => {
    const session = makeSession(true);
    const provider = new CliSessionProvider(session as any);

    await collect(provider.stream([msg1, msg2], [], undefined));

    expect(session.send).toHaveBeenCalledOnce();
    const [prompt] = session.send.mock.calls[0] as [string];
    expect(prompt).toContain('hello');
    expect(prompt).toContain('world');
  });

  // ── second call sends only delta ─────────────────────────────────────────────

  it('second call sends only new messages since last call', async () => {
    const session = makeSession(true);
    const provider = new CliSessionProvider(session as any);

    await collect(provider.stream([msg1, msg2], [], undefined));
    await collect(provider.stream([msg1, msg2, msg3], [], undefined));

    expect(session.send).toHaveBeenCalledTimes(2);
    const [secondPrompt] = session.send.mock.calls[1] as [string];
    expect(secondPrompt).toContain('third');
    expect(secondPrompt).not.toContain('hello');
    expect(secondPrompt).not.toContain('world');
  });

  // ── empty delta ──────────────────────────────────────────────────────────────

  it('empty delta (no new messages) yields nothing and skips send', async () => {
    const session = makeSession(true);
    const provider = new CliSessionProvider(session as any);

    await collect(provider.stream([msg1], [], undefined));
    const items = await collect(provider.stream([msg1], [], undefined));

    // send called only for the first call, not the second
    expect(session.send).toHaveBeenCalledOnce();
    expect(items).toHaveLength(0);
  });

  // ── resetForNewTask ──────────────────────────────────────────────────────────

  it('resetForNewTask() resets sentCount so next call resends all messages', async () => {
    const session = makeSession(true);
    const provider = new CliSessionProvider(session as any);

    await collect(provider.stream([msg1], [], undefined));
    provider.resetForNewTask();
    await collect(provider.stream([msg1, msg2], [], undefined));

    expect(session.send).toHaveBeenCalledTimes(2);
    const [secondPrompt] = session.send.mock.calls[1] as [string];
    expect(secondPrompt).toContain('hello');
    expect(secondPrompt).toContain('world');
  });

  // ── spawn on not-ready ───────────────────────────────────────────────────────

  it('calls session.spawn() when session.ready is false', async () => {
    const session = makeSession(false);
    const provider = new CliSessionProvider(session as any);

    await collect(provider.stream([msg1], [], undefined));

    expect(session.spawn).toHaveBeenCalledOnce();
  });
});
