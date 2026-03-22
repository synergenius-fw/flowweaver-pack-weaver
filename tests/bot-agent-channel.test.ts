import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BotAgentChannel } from '../src/bot/bot-agent-channel.js';
import type { BotAgentProvider, StreamChunk } from '../src/bot/types.js';

// Mock the approvals module so we don't need real approval infrastructure
vi.mock('../src/bot/approvals.js', () => ({
  createApprovalHandler: vi.fn(() => ({
    handle: vi.fn(async (req: { prompt: string }) => ({ approved: true, prompt: req.prompt })),
  })),
}));

function makeProvider(overrides: Partial<BotAgentProvider> = {}): BotAgentProvider {
  return {
    decide: vi.fn(async () => ({ answer: 'decided' })),
    ...overrides,
  };
}

function makeChannel(provider: BotAgentProvider): BotAgentChannel {
  return new BotAgentChannel(provider, {
    approvalMode: 'auto',
    approvalTimeoutSeconds: 30,
    notifier: vi.fn(async () => {}),
    context: { projectDir: '/tmp/test-project' },
  });
}

const baseRequest = {
  agentId: 'test-agent',
  context: { foo: 'bar' },
  prompt: 'do something',
};

describe('BotAgentChannel', () => {
  describe('request', () => {
    it('delegates to provider.decide for non-approval agents', async () => {
      const provider = makeProvider();
      const channel = makeChannel(provider);

      const result = await channel.request(baseRequest);

      expect(provider.decide).toHaveBeenCalledWith(baseRequest);
      expect(result).toEqual({ answer: 'decided' });
    });

    it('routes to approval handler when agentId contains "approval"', async () => {
      const provider = makeProvider();
      const channel = makeChannel(provider);

      const result = await channel.request({
        ...baseRequest,
        agentId: 'genesis-approval-check',
      });

      // Should NOT call provider.decide for approval requests
      expect(provider.decide).not.toHaveBeenCalled();
      // Should return approval handler result
      expect(result).toHaveProperty('approved', true);
    });
  });

  describe('requestWithTools', () => {
    const tools = [{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object' } }];

    it('uses decideWithTools when provider supports it', async () => {
      const decideWithTools = vi.fn(async () => ({
        result: { action: 'read' },
        toolCalls: [{ toolName: 'read_file', toolInput: { path: '/tmp' } }],
      }));
      const provider = makeProvider({ decideWithTools });
      const channel = makeChannel(provider);

      const result = await channel.requestWithTools(baseRequest, tools);

      expect(decideWithTools).toHaveBeenCalled();
      expect(result.toolCalls).toHaveLength(1);
      expect(provider.decide).not.toHaveBeenCalled();
    });

    it('falls back to decide when provider lacks decideWithTools', async () => {
      const provider = makeProvider(); // no decideWithTools
      const channel = makeChannel(provider);

      const result = await channel.requestWithTools(baseRequest, tools);

      expect(provider.decide).toHaveBeenCalledWith(baseRequest);
      expect(result.result).toEqual({ answer: 'decided' });
      expect(result.toolCalls).toBeUndefined();
    });

    it('logs a warning when falling back from decideWithTools to decide', async () => {
      const provider = makeProvider(); // no decideWithTools
      const channel = makeChannel(provider);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await channel.requestWithTools(baseRequest, tools);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('decideWithTools'),
      );
      warnSpy.mockRestore();
    });
  });

  describe('streamRequest', () => {
    it('yields chunks from provider.stream when available', async () => {
      const chunks: StreamChunk[] = [
        { type: 'text', text: 'hello' },
        { type: 'text', text: ' world' },
        { type: 'done' },
      ];
      async function* fakeStream(): AsyncIterable<StreamChunk> {
        for (const c of chunks) yield c;
      }
      const provider = makeProvider({ stream: vi.fn(fakeStream) });
      const channel = makeChannel(provider);

      const collected: StreamChunk[] = [];
      for await (const chunk of channel.streamRequest(baseRequest)) {
        collected.push(chunk);
      }

      expect(collected).toEqual(chunks);
      expect(provider.decide).not.toHaveBeenCalled();
    });

    it('falls back to decide and yields synthetic chunks when provider lacks stream', async () => {
      const provider = makeProvider(); // no stream method
      const channel = makeChannel(provider);

      const collected: StreamChunk[] = [];
      for await (const chunk of channel.streamRequest(baseRequest)) {
        collected.push(chunk);
      }

      expect(provider.decide).toHaveBeenCalledWith(baseRequest);
      expect(collected).toHaveLength(2);
      expect(collected[0].type).toBe('text');
      expect(collected[0].text).toBe(JSON.stringify({ answer: 'decided' }));
      expect(collected[1].type).toBe('done');
    });

    it('logs a warning when falling back from stream to decide', async () => {
      const provider = makeProvider(); // no stream method
      const channel = makeChannel(provider);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const collected: StreamChunk[] = [];
      for await (const chunk of channel.streamRequest(baseRequest)) {
        collected.push(chunk);
      }

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('stream'),
      );
      warnSpy.mockRestore();
    });
  });

  describe('compat stubs', () => {
    it('onPause returns a never-resolving promise', () => {
      const channel = makeChannel(makeProvider());
      const promise = channel.onPause();
      // Should be a promise that doesn't resolve
      expect(promise).toBeInstanceOf(Promise);
    });

    it('resume and fail do not throw', () => {
      const channel = makeChannel(makeProvider());
      expect(() => channel.resume({})).not.toThrow();
      expect(() => channel.fail('some reason')).not.toThrow();
    });
  });
});
