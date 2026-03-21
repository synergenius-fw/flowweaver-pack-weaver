import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GenesisConfig, GenesisContext } from '../src/bot/types.js';

vi.mock('../src/bot/ai-client.js', () => ({
  callAI: vi.fn(),
  parseJsonResponse: vi.fn(),
}));

vi.mock('../src/bot/genesis-prompt-context.js', () => ({
  getGenesisSystemPrompt: vi.fn().mockResolvedValue('system prompt'),
  getOperationExamples: vi.fn().mockReturnValue('examples'),
}));

import { callAI, parseJsonResponse } from '../src/bot/ai-client.js';
import { genesisPropose } from '../src/node-types/genesis-propose.js';

const mockCallAI = vi.mocked(callAI);
const mockParseJsonResponse = vi.mocked(parseJsonResponse);

const BASE_CONFIG: GenesisConfig = {
  intent: 'Improve workflow',
  focus: [],
  constraints: [],
  approvalThreshold: 'MINOR',
  budgetPerCycle: 3,
  stabilize: false,
  targetWorkflow: 'src/workflows/my-workflow.ts',
  maxCyclesPerRun: 10,
};

const BASE_PROPOSAL = {
  operations: [{ type: 'addNode', args: { nodeId: 'n1', nodeType: 'A' }, costUnits: 1, rationale: 'test' }],
  totalCost: 1,
  impactLevel: 'MINOR',
  summary: 'Add a node',
  rationale: 'Improve flow',
};

function makeCtx(overrides: Partial<GenesisContext> = {}): string {
  const ctx: GenesisContext = {
    env: {
      projectDir: '/proj',
      config: { provider: 'auto' as const },
      providerType: 'anthropic' as const,
      providerInfo: { type: 'anthropic' as const, apiKey: 'key' },
    },
    genesisConfigJson: JSON.stringify(BASE_CONFIG),
    cycleId: 'cycle-001',
    diffJson: JSON.stringify({ added: 1, removed: 0 }),
    workflowDescription: 'A workflow that does stuff',
    fingerprintJson: JSON.stringify({ files: {}, packageJson: null }),
    ...overrides,
  };
  return JSON.stringify(ctx);
}

describe('genesisPropose', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('dry-run (execute=false)', () => {
    it('returns onSuccess=true without calling AI', async () => {
      const result = await genesisPropose(false, makeCtx());
      expect(result.onSuccess).toBe(true);
      expect(result.onFailure).toBe(false);
      expect(mockCallAI).not.toHaveBeenCalled();
    });

    it('sets proposalJson with empty operations', async () => {
      const result = await genesisPropose(false, makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      const proposal = JSON.parse(ctx.proposalJson!);
      expect(proposal.operations).toEqual([]);
      expect(proposal.summary).toBe('dry run');
    });

    it('preserves other ctx fields', async () => {
      const result = await genesisPropose(false, makeCtx({ cycleId: 'cycle-xyz' }));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.cycleId).toBe('cycle-xyz');
    });
  });

  describe('successful proposal', () => {
    it('returns onSuccess=true', async () => {
      mockCallAI.mockResolvedValue('{}');
      mockParseJsonResponse.mockReturnValue(BASE_PROPOSAL as any);

      const result = await genesisPropose(true, makeCtx());
      expect(result.onSuccess).toBe(true);
      expect(result.onFailure).toBe(false);
    });

    it('sets proposalJson on ctx', async () => {
      mockCallAI.mockResolvedValue('{}');
      mockParseJsonResponse.mockReturnValue(BASE_PROPOSAL as any);

      const result = await genesisPropose(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      const proposal = JSON.parse(ctx.proposalJson!);
      expect(proposal.summary).toBe('Add a node');
      expect(proposal.operations).toHaveLength(1);
    });

    it('calls callAI once on first success', async () => {
      mockCallAI.mockResolvedValue('{}');
      mockParseJsonResponse.mockReturnValue(BASE_PROPOSAL as any);

      await genesisPropose(true, makeCtx());
      expect(mockCallAI).toHaveBeenCalledOnce();
    });

    it('logs proposal summary', async () => {
      mockCallAI.mockResolvedValue('{}');
      mockParseJsonResponse.mockReturnValue(BASE_PROPOSAL as any);

      await genesisPropose(true, makeCtx());
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('Add a node'),
      );
    });
  });

  describe('transient error retry', () => {
    it('retries on ETIMEDOUT and succeeds on second attempt', async () => {
      mockCallAI
        .mockRejectedValueOnce(new Error('ETIMEDOUT connection failed'))
        .mockResolvedValueOnce('{}');
      mockParseJsonResponse.mockReturnValue(BASE_PROPOSAL as any);

      const result = await genesisPropose(true, makeCtx());
      expect(result.onSuccess).toBe(true);
      expect(mockCallAI).toHaveBeenCalledTimes(2);
    });

    it('retries on ECONNRESET', async () => {
      mockCallAI
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce('{}');
      mockParseJsonResponse.mockReturnValue(BASE_PROPOSAL as any);

      await genesisPropose(true, makeCtx());
      expect(mockCallAI).toHaveBeenCalledTimes(2);
    });

    it('retries on socket hang up', async () => {
      mockCallAI
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockResolvedValueOnce('{}');
      mockParseJsonResponse.mockReturnValue(BASE_PROPOSAL as any);

      await genesisPropose(true, makeCtx());
      expect(mockCallAI).toHaveBeenCalledTimes(2);
    });

    it('logs retry message on transient failure', async () => {
      mockCallAI
        .mockRejectedValueOnce(new Error('ETIMEDOUT'))
        .mockResolvedValueOnce('{}');
      mockParseJsonResponse.mockReturnValue(BASE_PROPOSAL as any);

      await genesisPropose(true, makeCtx());
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('Retrying'),
      );
    });
  });

  describe('non-transient error', () => {
    it('does not log Retrying on non-transient error', async () => {
      mockCallAI.mockRejectedValue(new Error('provider timeout'));

      await genesisPropose(true, makeCtx());
      expect(vi.mocked(console.log)).not.toHaveBeenCalledWith(
        expect.stringContaining('Retrying'),
      );
    });

    it('returns onFailure=true', async () => {
      mockCallAI.mockRejectedValue(new Error('provider timeout'));

      const result = await genesisPropose(true, makeCtx());
      expect(result.onSuccess).toBe(false);
      expect(result.onFailure).toBe(true);
    });

    it('sets ctx.error containing the error message', async () => {
      mockCallAI.mockRejectedValue(new Error('provider timeout'));

      const result = await genesisPropose(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.error).toContain('provider timeout');
    });

    it('sets proposalJson with empty operations on failure', async () => {
      mockCallAI.mockRejectedValue(new Error('provider timeout'));

      const result = await genesisPropose(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      const proposal = JSON.parse(ctx.proposalJson!);
      expect(proposal.operations).toEqual([]);
    });

    it('logs error on failure', async () => {
      mockCallAI.mockRejectedValue(new Error('provider timeout'));

      await genesisPropose(true, makeCtx());
      expect(vi.mocked(console.error)).toHaveBeenCalledWith(
        expect.stringContaining('Proposal failed'),
      );
    });
  });

  describe('parseJsonResponse throws', () => {
    it('returns onFailure=true when parse fails', async () => {
      mockCallAI.mockResolvedValue('{}');
      mockParseJsonResponse.mockImplementation(() => { throw new Error('malformed JSON'); });

      const result = await genesisPropose(true, makeCtx());
      expect(result.onSuccess).toBe(false);
      expect(result.onFailure).toBe(true);
    });

    it('sets ctx.error when parse fails', async () => {
      mockCallAI.mockResolvedValue('{}');
      mockParseJsonResponse.mockImplementation(() => { throw new Error('malformed JSON'); });

      const result = await genesisPropose(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.error).toContain('malformed JSON');
    });
  });

  describe('all attempts fail (transient + second failure)', () => {
    it('returns onFailure=true after exhausting retries', async () => {
      mockCallAI
        .mockRejectedValueOnce(new Error('ETIMEDOUT'))
        .mockRejectedValueOnce(new Error('ETIMEDOUT again'));

      const result = await genesisPropose(true, makeCtx());
      expect(result.onSuccess).toBe(false);
      expect(result.onFailure).toBe(true);
      expect(mockCallAI).toHaveBeenCalledTimes(2);
    });

    it('sets ctx.error after all attempts fail', async () => {
      mockCallAI
        .mockRejectedValueOnce(new Error('ETIMEDOUT'))
        .mockRejectedValueOnce(new Error('ETIMEDOUT final'));

      const result = await genesisPropose(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.error).toContain('Proposal failed');
    });
  });

  describe('context fields passed to AI', () => {
    it('passes workflowDescription into user prompt', async () => {
      mockCallAI.mockResolvedValue('{}');
      mockParseJsonResponse.mockReturnValue(BASE_PROPOSAL as any);

      await genesisPropose(true, makeCtx({ workflowDescription: 'My special workflow' }));

      const [, , userPrompt] = mockCallAI.mock.calls[0] as [unknown, string, string, number];
      expect(userPrompt).toContain('My special workflow');
    });

    it('passes diffJson into user prompt', async () => {
      mockCallAI.mockResolvedValue('{}');
      mockParseJsonResponse.mockReturnValue(BASE_PROPOSAL as any);

      await genesisPropose(true, makeCtx({ diffJson: JSON.stringify({ added: 42 }) }));

      const [, , userPrompt] = mockCallAI.mock.calls[0] as [unknown, string, string, number];
      expect(userPrompt).toContain('"added": 42');
    });

    it('uses (no description available) when workflowDescription is missing', async () => {
      mockCallAI.mockResolvedValue('{}');
      mockParseJsonResponse.mockReturnValue(BASE_PROPOSAL as any);

      await genesisPropose(true, makeCtx({ workflowDescription: undefined }));

      const [, , userPrompt] = mockCallAI.mock.calls[0] as [unknown, string, string, number];
      expect(userPrompt).toContain('(no description available)');
    });
  });
});
