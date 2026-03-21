import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WeaverContext } from '../src/bot/types.js';

// ── Static mocks (hoisted before imports) ────────────────────────────────────

vi.mock('@synergenius/flow-weaver/agent', () => ({
  runAgentLoop: vi.fn(),
  createAnthropicProvider: vi.fn().mockReturnValue({ _type: 'anthropic-mock' }),
  getOrCreateCliSession: vi.fn().mockReturnValue({
    ready: true,
    spawn: vi.fn(),
    send: vi.fn().mockReturnValue((async function* () {})()),
  }),
  killAllCliSessions: vi.fn(),
}));

vi.mock('../src/bot/weaver-tools.js', () => ({
  WEAVER_TOOLS: [],
  createWeaverExecutor: vi.fn().mockReturnValue({}),
}));

vi.mock('../src/bot/audit-logger.js', () => ({
  auditEmit: vi.fn(),
}));

vi.mock('../src/bot/error-classifier.js', () => ({
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  withRetry: vi.fn(function (fn: Function) { return fn(); }),
  getErrorGuidance: vi.fn().mockReturnValue(null),
  isTransientError: vi.fn().mockReturnValue(false),
  classifyError: vi.fn().mockReturnValue({ isTransient: false, guidance: null, category: 'unknown' }),
}));

vi.mock('../src/bot/cost-tracker.js', () => ({
  CostTracker: {
    estimateCost: vi.fn().mockReturnValue(0.001),
  },
}));

// Dynamic imports (vi.mock resolves these even when called via import())
vi.mock('../src/bot/system-prompt.js', () => ({
  buildSystemPrompt: vi.fn().mockResolvedValue('base system prompt'),
  buildBotSystemPrompt: vi.fn().mockReturnValue('bot system prompt'),
}));

vi.mock('../src/bot/terminal-renderer.js', () => ({
  TerminalRenderer: vi.fn(function (this: any) {
    this.onToolEvent = vi.fn();
    this.onStreamEvent = vi.fn();
    this.warn = vi.fn();
    this.error = vi.fn();
    this.taskEnd = vi.fn();
  }),
}));

vi.mock('../src/node-types/validate-gate.js', () => ({
  weaverValidateGate: vi.fn(),
}));

vi.mock('@synergenius/flow-weaver/doc-metadata', () => ({
  CLI_COMMANDS: [],
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { runAgentLoop, createAnthropicProvider, getOrCreateCliSession } from '@synergenius/flow-weaver/agent';
import { withRetry } from '../src/bot/error-classifier.js';
import { weaverValidateGate } from '../src/node-types/validate-gate.js';
import { weaverAgentExecute, CliSessionProvider } from '../src/node-types/agent-execute.js';

const mockedRunAgentLoop = vi.mocked(runAgentLoop);
const mockedWithRetry = vi.mocked(withRetry);
const mockedCreateAnthropicProvider = vi.mocked(createAnthropicProvider);
const mockedGetOrCreateCliSession = vi.mocked(getOrCreateCliSession);
const mockedWeaverValidateGate = vi.mocked(weaverValidateGate);

// ── helpers ───────────────────────────────────────────────────────────────────

const BASE_ENV = {
  projectDir: '/test',
  config: { provider: 'auto' as const },
  providerType: 'anthropic' as const,
  providerInfo: { type: 'anthropic' as const, apiKey: 'test-key', model: 'claude-sonnet-4-6' },
};

function makeCtx(overrides: Partial<WeaverContext> = {}): string {
  const ctx: WeaverContext = {
    env: BASE_ENV,
    taskJson: JSON.stringify({ instruction: 'Add a new node', targets: ['src/workflows/wf.ts'] }),
    ...overrides,
  };
  return JSON.stringify(ctx);
}

const SUCCESS_RESULT = {
  success: true,
  summary: 'Task completed successfully',
  toolCallCount: 4,
  usage: { promptTokens: 200, completionTokens: 80 },
};

const FAILURE_RESULT = {
  success: false,
  summary: 'Task failed',
  toolCallCount: 2,
  usage: { promptTokens: 100, completionTokens: 30 },
};

// ── tests ─────────────────────────────────────────────────────────────────────

describe('weaverAgentExecute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Restore withRetry as a transparent pass-through after clearAllMocks()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    mockedWithRetry.mockImplementation(function (fn: Function) { return fn(); });
    mockedRunAgentLoop.mockResolvedValue(SUCCESS_RESULT as any);
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  // ── execute=false (dry-run) ─────────────────────────────────────────────────

  describe('dry-run (execute=false)', () => {
    it('returns onSuccess=true without calling the agent loop', async () => {
      const result = await weaverAgentExecute(false, makeCtx());
      expect(result.onSuccess).toBe(true);
      expect(result.onFailure).toBe(false);
      expect(mockedRunAgentLoop).not.toHaveBeenCalled();
    });

    it('sets resultJson with success=true and toolCallCount=0', async () => {
      const result = await weaverAgentExecute(false, makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      const resultData = JSON.parse(ctx.resultJson!);
      expect(resultData.success).toBe(true);
      expect(resultData.toolCallCount).toBe(0);
    });

    it('sets filesModified to empty array', async () => {
      const result = await weaverAgentExecute(false, makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(JSON.parse(ctx.filesModified!)).toEqual([]);
    });

    it('sets stepLogJson to empty array', async () => {
      const result = await weaverAgentExecute(false, makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(JSON.parse(ctx.stepLogJson!)).toEqual([]);
    });

    it('sets allValid=true', async () => {
      const result = await weaverAgentExecute(false, makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(ctx.allValid).toBe(true);
    });

    it('sets validationResultJson to empty array string', async () => {
      const result = await weaverAgentExecute(false, makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(ctx.validationResultJson).toBe('[]');
    });
  });

  // ── execute=true happy path ─────────────────────────────────────────────────

  describe('happy path (execute=true, agent succeeds)', () => {
    it('calls runAgentLoop (via withRetry) with the task prompt', async () => {
      const result = await weaverAgentExecute(true, makeCtx());
      expect(mockedRunAgentLoop).toHaveBeenCalledOnce();
      expect(result.onSuccess).toBe(true);
      expect(result.onFailure).toBe(false);
    });

    it('sets resultJson with success, summary, toolCallCount, and usage', async () => {
      const result = await weaverAgentExecute(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      const resultData = JSON.parse(ctx.resultJson!);

      expect(resultData.success).toBe(true);
      expect(resultData.summary).toBe('Task completed successfully');
      expect(resultData.toolCallCount).toBe(4);
      expect(resultData.usage).toMatchObject({ inputTokens: 200, outputTokens: 80 });
    });

    it('sets allValid=true when agent succeeds', async () => {
      const result = await weaverAgentExecute(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(ctx.allValid).toBe(true);
    });

    it('sets filesModified to JSON array (empty when no patch_file events)', async () => {
      const result = await weaverAgentExecute(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      const files = JSON.parse(ctx.filesModified!);
      expect(Array.isArray(files)).toBe(true);
    });

    it('sets stepLogJson to JSON array', async () => {
      const result = await weaverAgentExecute(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      const log = JSON.parse(ctx.stepLogJson!);
      expect(Array.isArray(log)).toBe(true);
    });

    it('preserves env in output context', async () => {
      const result = await weaverAgentExecute(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(ctx.env.projectDir).toBe('/test');
      expect(ctx.env.providerType).toBe('anthropic');
    });
  });

  // ── execute=true when agent reports failure ─────────────────────────────────

  describe('agent reports failure (success=false)', () => {
    it('returns onSuccess=false, onFailure=true when agent loop returns success=false', async () => {
      mockedRunAgentLoop.mockResolvedValue(FAILURE_RESULT as any);

      const result = await weaverAgentExecute(true, makeCtx());
      expect(result.onSuccess).toBe(false);
      expect(result.onFailure).toBe(true);
    });

    it('sets allValid=false when agent reports failure', async () => {
      mockedRunAgentLoop.mockResolvedValue(FAILURE_RESULT as any);

      const result = await weaverAgentExecute(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(ctx.allValid).toBe(false);
    });
  });

  // ── execute=true when agent throws ─────────────────────────────────────────

  describe('error path (agent throws)', () => {
    it('returns onSuccess=false, onFailure=true when agent throws', async () => {
      mockedRunAgentLoop.mockRejectedValue(new Error('API rate limit exceeded'));

      const result = await weaverAgentExecute(true, makeCtx());
      expect(result.onSuccess).toBe(false);
      expect(result.onFailure).toBe(true);
    });

    it('sets resultJson with success=false and error message when agent throws', async () => {
      mockedRunAgentLoop.mockRejectedValue(new Error('timeout after 30s'));

      const result = await weaverAgentExecute(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      const resultData = JSON.parse(ctx.resultJson!);

      expect(resultData.success).toBe(false);
      expect(resultData.error).toContain('timeout after 30s');
    });

    it('sets allValid=false when agent throws', async () => {
      mockedRunAgentLoop.mockRejectedValue(new Error('network error'));

      const result = await weaverAgentExecute(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(ctx.allValid).toBe(false);
    });

    it('sets filesModified to empty array when agent throws', async () => {
      mockedRunAgentLoop.mockRejectedValue(new Error('crash'));

      const result = await weaverAgentExecute(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(JSON.parse(ctx.filesModified!)).toEqual([]);
    });

    it('does not propagate the error — always returns a result object', async () => {
      mockedRunAgentLoop.mockRejectedValue(new Error('fatal'));

      await expect(weaverAgentExecute(true, makeCtx())).resolves.toBeDefined();
    });
  });

  // ── tool event tracking ──────────────────────────────────────────────────────

  describe('tool event tracking via onToolEvent', () => {
    /** Fire a synthetic tool event from inside the runAgentLoop mock. */
    function mockLoopWithEvents(events: object[]): void {
      mockedRunAgentLoop.mockImplementation(async (_p, _t, _e, _m, opts: any) => {
        for (const ev of events) opts.onToolEvent(ev);
        return SUCCESS_RESULT;
      });
    }

    it('patch_file event populates filesModified', async () => {
      mockLoopWithEvents([
        { type: 'tool_call_result', name: 'patch_file', isError: false, args: { file: 'src/workflow.ts' }, result: 'ok' },
      ]);
      const result = await weaverAgentExecute(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(JSON.parse(ctx.filesModified!)).toContain('src/workflow.ts');
    });

    it('write_file event populates filesModified', async () => {
      mockLoopWithEvents([
        { type: 'tool_call_result', name: 'write_file', isError: false, args: { file: 'src/new-node.ts' }, result: 'ok' },
      ]);
      const result = await weaverAgentExecute(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(JSON.parse(ctx.filesModified!)).toContain('src/new-node.ts');
    });

    it('deduplicates file paths when the same file is modified multiple times', async () => {
      mockLoopWithEvents([
        { type: 'tool_call_result', name: 'patch_file', isError: false, args: { file: 'src/wf.ts' }, result: 'ok' },
        { type: 'tool_call_result', name: 'patch_file', isError: false, args: { file: 'src/wf.ts' }, result: 'ok' },
      ]);
      const result = await weaverAgentExecute(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      const files = JSON.parse(ctx.filesModified!) as string[];
      expect(files.filter(f => f === 'src/wf.ts')).toHaveLength(1);
    });

    it('tool_call_result with isError=false adds ok status to stepLog', async () => {
      mockLoopWithEvents([
        { type: 'tool_call_result', name: 'validate', isError: false, args: {}, result: 'ok' },
      ]);
      const result = await weaverAgentExecute(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      const log = JSON.parse(ctx.stepLogJson!) as { step: string; status: string }[];
      expect(log).toHaveLength(1);
      expect(log[0].step).toBe('validate');
      expect(log[0].status).toBe('ok');
    });

    it('tool_call_result with isError=true adds error status to stepLog', async () => {
      mockLoopWithEvents([
        { type: 'tool_call_result', name: 'run_shell', isError: true, args: {}, result: 'command failed' },
      ]);
      const result = await weaverAgentExecute(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      const log = JSON.parse(ctx.stepLogJson!) as { step: string; status: string; detail: string }[];
      expect(log[0].status).toBe('error');
      expect(log[0].detail).toContain('command failed');
    });

    it('stepLog accumulates one entry per tool_call_result event', async () => {
      mockLoopWithEvents([
        { type: 'tool_call_result', name: 'read_file', isError: false, args: {}, result: 'content' },
        { type: 'tool_call_result', name: 'patch_file', isError: false, args: { file: 'x.ts' }, result: 'ok' },
        { type: 'tool_call_result', name: 'validate', isError: false, args: {}, result: 'valid' },
      ]);
      const result = await weaverAgentExecute(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(JSON.parse(ctx.stepLogJson!)).toHaveLength(3);
    });

    it('non-patch tool events do not add to filesModified', async () => {
      mockLoopWithEvents([
        { type: 'tool_call_result', name: 'read_file', isError: false, args: { file: 'src/x.ts' }, result: 'ok' },
      ]);
      const result = await weaverAgentExecute(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(JSON.parse(ctx.filesModified!)).toEqual([]);
    });
  });

  // ── validate-gate integration ─────────────────────────────────────────────────

  describe('validate-gate integration', () => {
    function mockLoopWithPatchFile(file = 'src/wf.ts'): void {
      mockedRunAgentLoop.mockImplementation(async (_p, _t, _e, _m, opts: any) => {
        opts.onToolEvent({ type: 'tool_call_result', name: 'patch_file', isError: false, args: { file }, result: 'ok' });
        return SUCCESS_RESULT;
      });
    }

    function makeGateCtx(allValid: boolean): string {
      return JSON.stringify({ env: BASE_ENV, allValid, validationResultJson: '[]' });
    }

    it('weaverValidateGate is called when files were modified', async () => {
      mockLoopWithPatchFile();
      mockedWeaverValidateGate.mockReturnValue({ ctx: makeGateCtx(true) });

      await weaverAgentExecute(true, makeCtx());

      expect(mockedWeaverValidateGate).toHaveBeenCalledOnce();
    });

    it('weaverValidateGate is NOT called when no files were modified', async () => {
      // Default mock: returns SUCCESS_RESULT without firing patch_file events
      await weaverAgentExecute(true, makeCtx());
      expect(mockedWeaverValidateGate).not.toHaveBeenCalled();
    });

    it('validate-gate allValid=false overrides agent success → onFailure=true', async () => {
      mockLoopWithPatchFile();
      mockedWeaverValidateGate.mockReturnValue({ ctx: makeGateCtx(false) });

      const result = await weaverAgentExecute(true, makeCtx());
      expect(result.onSuccess).toBe(false);
      expect(result.onFailure).toBe(true);
    });

    it('validate-gate allValid=false sets allValid=false in output context', async () => {
      mockLoopWithPatchFile();
      mockedWeaverValidateGate.mockReturnValue({ ctx: makeGateCtx(false) });

      const result = await weaverAgentExecute(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(ctx.allValid).toBe(false);
    });

    it('validate-gate allValid=true preserves agent success → onSuccess=true', async () => {
      mockLoopWithPatchFile();
      mockedWeaverValidateGate.mockReturnValue({ ctx: makeGateCtx(true) });

      const result = await weaverAgentExecute(true, makeCtx());
      expect(result.onSuccess).toBe(true);
      expect(result.onFailure).toBe(false);
    });

    it('validate-gate call throws → non-fatal, falls back to agent result (onSuccess=true)', async () => {
      mockLoopWithPatchFile();
      mockedWeaverValidateGate.mockImplementation(() => { throw new Error('validate-gate unavailable'); });

      const result = await weaverAgentExecute(true, makeCtx());
      expect(result.onSuccess).toBe(true);
      expect(result.onFailure).toBe(false);
    });
  });

  // ── provider selection ───────────────────────────────────────────────────────

  describe('provider selection', () => {
    it('anthropic type with apiKey → createAnthropicProvider called', async () => {
      await weaverAgentExecute(true, makeCtx());
      expect(mockedCreateAnthropicProvider).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: 'test-key' }),
      );
    });

    it('claude-cli type → getOrCreateCliSession called', async () => {
      const ctx = makeCtx({
        env: { ...BASE_ENV, providerType: 'claude-cli' as any, providerInfo: { type: 'claude-cli' as any } },
      });
      await weaverAgentExecute(true, ctx);
      expect(mockedGetOrCreateCliSession).toHaveBeenCalled();
      expect(mockedCreateAnthropicProvider).not.toHaveBeenCalled();
    });

    it('auto type with ANTHROPIC_API_KEY → createAnthropicProvider called', async () => {
      process.env.ANTHROPIC_API_KEY = 'env-key';
      const ctx = makeCtx({
        env: { ...BASE_ENV, providerType: 'auto' as any, providerInfo: { type: 'auto' as any } },
      });
      await weaverAgentExecute(true, ctx);
      expect(mockedCreateAnthropicProvider).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: 'env-key' }),
      );
    });

    it('auto type without ANTHROPIC_API_KEY → getOrCreateCliSession called', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      const ctx = makeCtx({
        env: { ...BASE_ENV, providerType: 'auto' as any, providerInfo: { type: 'auto' as any } },
      });
      await weaverAgentExecute(true, ctx);
      expect(mockedGetOrCreateCliSession).toHaveBeenCalled();
    });

    it('unsupported provider type → catches error and returns onFailure=true', async () => {
      const ctx = makeCtx({
        env: { ...BASE_ENV, providerType: 'unknown' as any, providerInfo: { type: 'unknown' as any } },
      });
      const result = await weaverAgentExecute(true, ctx);
      expect(result.onSuccess).toBe(false);
      expect(result.onFailure).toBe(true);
    });

    it('estimatedCost is included in resultJson.usage', async () => {
      const { CostTracker } = await import('../src/bot/cost-tracker.js');
      vi.mocked(CostTracker.estimateCost).mockReturnValue(0.042);

      const result = await weaverAgentExecute(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      const resultData = JSON.parse(ctx.resultJson!);
      expect(resultData.usage.estimatedCost).toBe(0.042);
    });
  });
});

// ── CliSessionProvider ────────────────────────────────────────────────────────

describe('CliSessionProvider', () => {
  function makeSession(ready = true) {
    return {
      ready,
      spawn: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockReturnValue(
        (async function* () { yield { type: 'text', text: 'response' }; })()
      ),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls session.send with the user message content as prompt', async () => {
    const session = makeSession();
    const provider = new CliSessionProvider(session as any);
    const messages = [{ role: 'user', content: 'Do this task' }];

    const events = [];
    for await (const ev of provider.stream(messages as any, [])) {
      events.push(ev);
    }

    expect(session.send).toHaveBeenCalledOnce();
    const [promptArg] = session.send.mock.calls[0];
    expect(promptArg).toContain('Do this task');
  });

  it('does not call spawn when session.ready=true', async () => {
    const session = makeSession(true);
    const provider = new CliSessionProvider(session as any);

    for await (const _ of provider.stream([{ role: 'user', content: 'x' }] as any, [])) { /* drain */ }

    expect(session.spawn).not.toHaveBeenCalled();
  });

  it('calls spawn when session.ready=false', async () => {
    const session = makeSession(false);
    const provider = new CliSessionProvider(session as any);

    for await (const _ of provider.stream([{ role: 'user', content: 'x' }] as any, [])) { /* drain */ }

    expect(session.spawn).toHaveBeenCalledOnce();
  });

  it('yields events from session.send', async () => {
    const session = makeSession();
    const provider = new CliSessionProvider(session as any);

    const events = [];
    for await (const ev of provider.stream([{ role: 'user', content: 'test' }] as any, [])) {
      events.push(ev);
    }

    expect(events).toHaveLength(1);
    expect((events[0] as any).type).toBe('text');
  });

  it('only sends new messages on repeated calls (tracks sentCount)', async () => {
    const session = makeSession();
    const provider = new CliSessionProvider(session as any);

    const msgs1 = [{ role: 'user', content: 'first' }];
    for await (const _ of provider.stream(msgs1 as any, [])) { /* drain */ }

    // Reset send mock to fresh generator for second call
    session.send.mockReturnValue((async function* () { yield { type: 'text', text: 'r2' }; })());
    const msgs2 = [
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second' },
    ];
    for await (const _ of provider.stream(msgs2 as any, [])) { /* drain */ }

    // Second call should only send the new message ('second')
    const [secondCallPrompt] = session.send.mock.calls[1];
    expect(secondCallPrompt).toContain('second');
    expect(secondCallPrompt).not.toContain('first');
  });

  it('yields nothing when all messages have already been sent (empty prompt)', async () => {
    const session = makeSession();
    const provider = new CliSessionProvider(session as any);

    const msgs = [{ role: 'user', content: 'already sent' }];
    // First call consumes the message
    for await (const _ of provider.stream(msgs as any, [])) { /* drain */ }

    session.send.mockClear();

    // Second call with same messages → nothing new to send → send not called
    for await (const _ of provider.stream(msgs as any, [])) { /* drain */ }

    expect(session.send).not.toHaveBeenCalled();
  });

  it('resetForNewTask resets sentCount so all messages are sent again', async () => {
    const session = makeSession();
    const provider = new CliSessionProvider(session as any);

    const msgs = [{ role: 'user', content: 'task 1' }];
    for await (const _ of provider.stream(msgs as any, [])) { /* drain */ }

    provider.resetForNewTask();
    session.send.mockReturnValue((async function* () { yield { type: 'text', text: 'r2' }; })());

    for await (const _ of provider.stream(msgs as any, [])) { /* drain */ }

    // send called twice total — once before reset, once after
    expect(session.send).toHaveBeenCalledTimes(2);
    const [secondCallPrompt] = session.send.mock.calls[1];
    expect(secondCallPrompt).toContain('task 1');
  });

  it('formats tool result messages with toolCallId prefix', async () => {
    const session = makeSession();
    const provider = new CliSessionProvider(session as any);

    const messages = [{ role: 'tool', content: 'file contents', toolCallId: 'tc-42' }];
    for await (const _ of provider.stream(messages as any, [])) { /* drain */ }

    const [promptArg] = session.send.mock.calls[0];
    expect(promptArg).toContain('tc-42');
    expect(promptArg).toContain('file contents');
  });
});
