import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentMessage, AgentProvider, ToolExecutor, ToolDefinition } from '@synergenius/flow-weaver/agent';

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@synergenius/flow-weaver/agent', () => ({
  runAgentLoop: vi.fn(),
}));

// ConversationStore is dynamically imported inside runAssistant, so vi.mock
// by path relative to the test file (same resolved module).
vi.mock('../../src/bot/conversation-store.js', () => {
  function makeStore() {
    return {
      get: vi.fn(),
      create: vi.fn().mockReturnValue({
        id: 'conv-test',
        title: '',
        messageCount: 0,
        lastMessageAt: Date.now(),
      }),
      getMostRecent: vi.fn().mockReturnValue(null),
      loadMessages: vi.fn().mockReturnValue([]),
      appendMessages: vi.fn(),
      updateAfterTurn: vi.fn(),
      setTitle: vi.fn(),
    };
  }
  return { ConversationStore: vi.fn().mockImplementation(makeStore) };
});

// ── Helpers ────────────────────────────────────────────────────────────────

import { runAgentLoop } from '@synergenius/flow-weaver/agent';
import { ConversationStore } from '../../src/bot/conversation-store.js';

const mockRunAgentLoop = vi.mocked(runAgentLoop);
const MockConversationStore = vi.mocked(ConversationStore);

/** Build a minimal mock that responds with text and returns extended history. */
function makeAgentMock(responseText: string) {
  return vi.fn().mockImplementation(
    async (
      _provider: AgentProvider,
      _tools: ToolDefinition[],
      _executor: ToolExecutor,
      messages: AgentMessage[],
      _opts: unknown,
    ) => {
      const assistantMsg: AgentMessage = { role: 'assistant', content: responseText };
      return {
        success: true,
        messages: [...messages, assistantMsg],
        toolCallCount: 0,
        summary: undefined,
        usage: { promptTokens: 10, completionTokens: 5 },
      };
    },
  );
}

let tmpDir: string;
let projectDir: string;
let storeInstance: ReturnType<typeof import('../../src/bot/conversation-store.js').ConversationStore['prototype']['create']> & {
  get: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  getMostRecent: ReturnType<typeof vi.fn>;
  loadMessages: ReturnType<typeof vi.fn>;
  appendMessages: ReturnType<typeof vi.fn>;
  updateAfterTurn: ReturnType<typeof vi.fn>;
  setTitle: ReturnType<typeof vi.fn>;
};

// Spy on process.stderr.write to capture output
let stderrOutput: string;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-core-test-'));
  projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });

  // Reset mocks between tests
  vi.clearAllMocks();
  mockRunAgentLoop.mockReset();

  // Provide a fresh store instance via the mock constructor
  storeInstance = {
    get: vi.fn(),
    create: vi.fn().mockReturnValue({
      id: 'conv-test',
      title: '',
      messageCount: 0,
      lastMessageAt: Date.now(),
    }),
    getMostRecent: vi.fn().mockReturnValue(null),
    loadMessages: vi.fn().mockReturnValue([]),
    appendMessages: vi.fn(),
    updateAfterTurn: vi.fn(),
    setTitle: vi.fn(),
  } as unknown as typeof storeInstance;
  const _store = storeInstance;
  MockConversationStore.mockImplementation(function() { return _store; } as unknown as new () => InstanceType<typeof ConversationStore>);

  // Capture stderr output
  stderrOutput = '';
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderrOutput += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  });
});

afterEach(() => {
  stderrSpy.mockRestore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Import target under test ───────────────────────────────────────────────

// Lazy import to ensure mocks are registered first
async function importAssistant() {
  return import('../../src/bot/assistant-core.js');
}

const mockProvider = {} as AgentProvider;
const mockExecutor = {} as ToolExecutor;
const mockTools: ToolDefinition[] = [];

// ── Tests ──────────────────────────────────────────────────────────────────

describe('plan file loading', () => {
  it('includes .weaver-plan.md content in the system prompt', async () => {
    const plan = 'Build a resilient pipeline with retry logic.';
    fs.writeFileSync(path.join(projectDir, '.weaver-plan.md'), plan);

    mockRunAgentLoop.mockImplementation(makeAgentMock('Done.'));

    const { runAssistant } = await importAssistant();
    await runAssistant({
      provider: mockProvider,
      tools: mockTools,
      executor: mockExecutor,
      projectDir,
      inputMessages: ['hi'],
    });

    const callOpts = (mockRunAgentLoop.mock.calls[0] as unknown[])[4] as { systemPrompt?: string };
    expect(callOpts.systemPrompt).toContain(plan);
    expect(callOpts.systemPrompt).toContain('Project Plan & Vision');
  });

  it('uses default system prompt when no plan file exists', async () => {
    mockRunAgentLoop.mockImplementation(makeAgentMock('Done.'));

    const { runAssistant } = await importAssistant();
    await runAssistant({
      provider: mockProvider,
      tools: mockTools,
      executor: mockExecutor,
      projectDir,
      inputMessages: ['hi'],
    });

    const callOpts = (mockRunAgentLoop.mock.calls[0] as unknown[])[4] as { systemPrompt?: string };
    expect(callOpts.systemPrompt).toContain('Weaver Assistant');
    expect(callOpts.systemPrompt).not.toContain('Project Plan & Vision');
  });

  it('uses provided systemPrompt override instead of default', async () => {
    mockRunAgentLoop.mockImplementation(makeAgentMock('Done.'));

    const { runAssistant } = await importAssistant();
    await runAssistant({
      provider: mockProvider,
      tools: mockTools,
      executor: mockExecutor,
      projectDir,
      systemPrompt: 'Custom prompt.',
      inputMessages: ['hi'],
    });

    const callOpts = (mockRunAgentLoop.mock.calls[0] as unknown[])[4] as { systemPrompt?: string };
    expect(callOpts.systemPrompt).toContain('Custom prompt.');
    expect(callOpts.systemPrompt).not.toContain('Weaver Assistant');
  });
});

describe('input/output flow', () => {
  it('passes user input as a message to runAgentLoop', async () => {
    mockRunAgentLoop.mockImplementation(makeAgentMock('Hello back!'));

    const { runAssistant } = await importAssistant();
    await runAssistant({
      provider: mockProvider,
      tools: mockTools,
      executor: mockExecutor,
      projectDir,
      inputMessages: ['tell me about bots'],
    });

    expect(mockRunAgentLoop).toHaveBeenCalledOnce();
    const messages = (mockRunAgentLoop.mock.calls[0] as unknown[])[3] as AgentMessage[];
    expect(messages.some(m => m.role === 'user' && m.content === 'tell me about bots')).toBe(true);
  });

  it('streams text_delta events to stderr', async () => {
    mockRunAgentLoop.mockImplementation(
      async (_p, _t, _e, messages: AgentMessage[], opts: { onStreamEvent?: (e: unknown) => void }) => {
        opts.onStreamEvent?.({ type: 'text_delta', text: 'Streaming response' });
        return {
          success: true,
          messages: [...messages, { role: 'assistant', content: 'Streaming response' }],
          toolCallCount: 0,
          usage: { promptTokens: 5, completionTokens: 5 },
        };
      },
    );

    const { runAssistant } = await importAssistant();
    await runAssistant({
      provider: mockProvider,
      tools: mockTools,
      executor: mockExecutor,
      projectDir,
      inputMessages: ['go'],
    });

    expect(stderrOutput).toContain('Streaming response');
  });

  it('streams thinking_delta events to stderr (dimmed)', async () => {
    mockRunAgentLoop.mockImplementation(
      async (_p, _t, _e, messages: AgentMessage[], opts: { onStreamEvent?: (e: unknown) => void }) => {
        opts.onStreamEvent?.({ type: 'thinking_delta', text: 'internal thought' });
        return {
          success: true,
          messages: [...messages, { role: 'assistant', content: '' }],
          toolCallCount: 0,
          usage: { promptTokens: 5, completionTokens: 5 },
        };
      },
    );

    const { runAssistant } = await importAssistant();
    await runAssistant({
      provider: mockProvider,
      tools: mockTools,
      executor: mockExecutor,
      projectDir,
      inputMessages: ['think'],
    });

    expect(stderrOutput).toContain('internal thought');
  });

  it('outputs tool call events to stderr', async () => {
    mockRunAgentLoop.mockImplementation(
      async (_p, _t, _e, messages: AgentMessage[], opts: { onToolEvent?: (e: unknown) => void }) => {
        opts.onToolEvent?.({ type: 'tool_call_start', name: 'bot_list', args: {} });
        opts.onToolEvent?.({ type: 'tool_call_result', name: 'bot_list', result: 'no bots', isError: false });
        return {
          success: true,
          messages: [...messages, { role: 'assistant', content: 'Listed.' }],
          toolCallCount: 1,
          usage: { promptTokens: 5, completionTokens: 5 },
        };
      },
    );

    const { runAssistant } = await importAssistant();
    await runAssistant({
      provider: mockProvider,
      tools: mockTools,
      executor: mockExecutor,
      projectDir,
      inputMessages: ['list bots'],
    });

    expect(stderrOutput).toContain('bot_list');
    expect(stderrOutput).toContain('no bots');
  });

  it('skips blank input lines without calling runAgentLoop', async () => {
    mockRunAgentLoop.mockImplementation(makeAgentMock('Ok.'));

    const { runAssistant } = await importAssistant();
    await runAssistant({
      provider: mockProvider,
      tools: mockTools,
      executor: mockExecutor,
      projectDir,
      inputMessages: ['', '   ', 'real input'],
    });

    // Only the real input triggers the agent
    expect(mockRunAgentLoop).toHaveBeenCalledOnce();
  });

  it('prints error message when runAgentLoop throws', async () => {
    mockRunAgentLoop.mockRejectedValue(new Error('API down'));

    const { runAssistant } = await importAssistant();
    await runAssistant({
      provider: mockProvider,
      tools: mockTools,
      executor: mockExecutor,
      projectDir,
      inputMessages: ['do something'],
    });

    expect(stderrOutput).toContain('Error:');
    expect(stderrOutput).toContain('API down');
  });
});

describe('conversation history accumulation', () => {
  it('passes full history including prior turns to subsequent runAgentLoop calls', async () => {
    let callCount = 0;
    mockRunAgentLoop.mockImplementation(
      async (_p, _t, _e, messages: AgentMessage[]) => {
        callCount++;
        const response: AgentMessage = {
          role: 'assistant',
          content: `Response ${callCount}`,
        };
        return {
          success: true,
          messages: [...messages, response],
          toolCallCount: 0,
          usage: { promptTokens: 10, completionTokens: 5 },
        };
      },
    );

    const { runAssistant } = await importAssistant();
    await runAssistant({
      provider: mockProvider,
      tools: mockTools,
      executor: mockExecutor,
      projectDir,
      inputMessages: ['first', 'second'],
    });

    expect(mockRunAgentLoop).toHaveBeenCalledTimes(2);

    // Second call should include messages from the first turn
    const secondCallMessages = (mockRunAgentLoop.mock.calls[1] as unknown[])[3] as AgentMessage[];
    const roles = secondCallMessages.map(m => m.role);
    // Should have: user('first'), assistant('Response 1'), user('second')
    expect(roles).toContain('assistant');
    expect(secondCallMessages.length).toBeGreaterThan(1);
    // The user message for turn 2 should be present
    expect(secondCallMessages.some(m => m.content === 'second')).toBe(true);
    // The assistant response from turn 1 should be present
    expect(secondCallMessages.some(m => m.content === 'Response 1')).toBe(true);
  });

  it('loads prior messages from store when resuming a conversation', async () => {
    const priorMessages: AgentMessage[] = [
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'old answer' },
    ];
    storeInstance.getMostRecent.mockReturnValue({
      id: 'old-conv',
      title: 'Old session',
      messageCount: 2,
      lastMessageAt: Date.now() - 30_000, // 30s ago — within 1h window
    });
    storeInstance.loadMessages.mockReturnValue(priorMessages);

    mockRunAgentLoop.mockImplementation(makeAgentMock('New response.'));

    const { runAssistant } = await importAssistant();
    await runAssistant({
      provider: mockProvider,
      tools: mockTools,
      executor: mockExecutor,
      projectDir,
      inputMessages: ['new question'],
    });

    const messages = (mockRunAgentLoop.mock.calls[0] as unknown[])[3] as AgentMessage[];
    expect(messages.some(m => m.content === 'old question')).toBe(true);
    expect(messages.some(m => m.content === 'old answer')).toBe(true);
    expect(messages.some(m => m.content === 'new question')).toBe(true);
  });

  it('starts a fresh conversation when newConversation is true', async () => {
    storeInstance.getMostRecent.mockReturnValue({
      id: 'old-conv',
      title: 'Old',
      messageCount: 5,
      lastMessageAt: Date.now() - 60_000,
    });
    storeInstance.loadMessages.mockReturnValue([
      { role: 'user', content: 'old message' },
    ]);

    mockRunAgentLoop.mockImplementation(makeAgentMock('Fresh start.'));

    const { runAssistant } = await importAssistant();
    await runAssistant({
      provider: mockProvider,
      tools: mockTools,
      executor: mockExecutor,
      projectDir,
      newConversation: true,
      inputMessages: ['hello'],
    });

    const messages = (mockRunAgentLoop.mock.calls[0] as unknown[])[3] as AgentMessage[];
    // Should NOT contain prior messages
    expect(messages.some(m => m.content === 'old message')).toBe(false);
    expect(messages.some(m => m.content === 'hello')).toBe(true);
  });

  it('persists new messages to the conversation store after each turn', async () => {
    mockRunAgentLoop.mockImplementation(makeAgentMock('Persisted response.'));

    const { runAssistant } = await importAssistant();
    await runAssistant({
      provider: mockProvider,
      tools: mockTools,
      executor: mockExecutor,
      projectDir,
      inputMessages: ['persist me'],
    });

    expect(storeInstance.appendMessages).toHaveBeenCalled();
    expect(storeInstance.updateAfterTurn).toHaveBeenCalled();
  });
});

describe('token compression', () => {
  it('truncates long tool results in old messages when history exceeds budget', async () => {
    // Build a large history that exceeds the 80k token budget (≈320k chars)
    const bigContent = 'x'.repeat(50_000); // ~12.5k tokens each
    const largeHistory: AgentMessage[] = [];
    for (let i = 0; i < 30; i++) {
      largeHistory.push({ role: 'user', content: `question ${i}` });
      largeHistory.push({ role: 'tool', content: bigContent, toolCallId: `tc-${i}` });
      largeHistory.push({ role: 'assistant', content: `answer ${i}` });
    }

    storeInstance.getMostRecent.mockReturnValue({
      id: 'big-conv',
      title: '',
      messageCount: largeHistory.length,
      lastMessageAt: Date.now() - 30_000,
    });
    storeInstance.loadMessages.mockReturnValue(largeHistory);

    let capturedMessages: AgentMessage[] = [];
    mockRunAgentLoop.mockImplementation(
      async (_p, _t, _e, messages: AgentMessage[]) => {
        capturedMessages = [...messages];
        return {
          success: true,
          messages: [...messages, { role: 'assistant', content: 'ok' }],
          toolCallCount: 0,
          usage: { promptTokens: 100, completionTokens: 10 },
        };
      },
    );

    const { runAssistant } = await importAssistant();
    await runAssistant({
      provider: mockProvider,
      tools: mockTools,
      executor: mockExecutor,
      projectDir,
      inputMessages: ['compress check'],
    });

    // At least some old tool results should have been truncated
    const toolMessages = capturedMessages.filter(m => m.role === 'tool' && typeof m.content === 'string');
    const truncated = toolMessages.filter(
      m => typeof m.content === 'string' && (m.content.includes('truncated') || m.content.length < bigContent.length),
    );
    expect(truncated.length).toBeGreaterThan(0);
  });

  it('drops oldest messages when history is extremely large', async () => {
    // Use very large messages that will exceed even the "phase 3" threshold
    const hugeContent = 'y'.repeat(100_000); // ~25k tokens each
    const hugeHistory: AgentMessage[] = [];
    for (let i = 0; i < 40; i++) {
      hugeHistory.push({ role: 'user', content: hugeContent });
      hugeHistory.push({ role: 'assistant', content: hugeContent });
    }

    storeInstance.getMostRecent.mockReturnValue({
      id: 'huge-conv',
      title: '',
      messageCount: hugeHistory.length,
      lastMessageAt: Date.now() - 30_000,
    });
    storeInstance.loadMessages.mockReturnValue(hugeHistory);

    let capturedMessages: AgentMessage[] = [];
    mockRunAgentLoop.mockImplementation(
      async (_p, _t, _e, messages: AgentMessage[]) => {
        capturedMessages = [...messages];
        return {
          success: true,
          messages: [...messages, { role: 'assistant', content: 'ok' }],
          toolCallCount: 0,
          usage: { promptTokens: 100, completionTokens: 10 },
        };
      },
    );

    const { runAssistant } = await importAssistant();
    await runAssistant({
      provider: mockProvider,
      tools: mockTools,
      executor: mockExecutor,
      projectDir,
      inputMessages: ['compress harder'],
    });

    // Phase 3 keeps at most 10 messages + inserts a summary placeholder
    expect(capturedMessages.some(m =>
      typeof m.content === 'string' && m.content.includes('compressed'),
    )).toBe(true);
  });
});

describe('conversation store interactions', () => {
  it('auto-titles conversation from first assistant response', async () => {
    mockRunAgentLoop.mockImplementation(
      async (_p, _t, _e, messages: AgentMessage[]) => ({
        success: true,
        messages: [...messages, { role: 'assistant', content: 'This is a great title\nMore text here.' }],
        toolCallCount: 0,
        usage: { promptTokens: 5, completionTokens: 5 },
      }),
    );

    const { runAssistant } = await importAssistant();
    await runAssistant({
      provider: mockProvider,
      tools: mockTools,
      executor: mockExecutor,
      projectDir,
      inputMessages: ['name me'],
    });

    expect(storeInstance.setTitle).toHaveBeenCalledWith('conv-test', 'This is a great title');
  });

  it('returns early when resumeId points to a non-existent conversation', async () => {
    storeInstance.get.mockReturnValue(null);

    const { runAssistant } = await importAssistant();
    await runAssistant({
      provider: mockProvider,
      tools: mockTools,
      executor: mockExecutor,
      projectDir,
      resumeId: 'nonexistent-id',
      inputMessages: ['hi'],
    });

    // Should return early without calling runAgentLoop
    expect(mockRunAgentLoop).not.toHaveBeenCalled();
    expect(stderrOutput).toContain('Conversation not found');
  });
});
