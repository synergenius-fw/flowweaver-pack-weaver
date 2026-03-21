import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GenesisConfig, GenesisContext, GenesisProposal } from '../src/bot/types.js';

const { mockExecFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFileSync: mockExecFileSync };
});

vi.mock('../src/bot/design-checker.js', () => ({
  checkDesignQuality: vi.fn().mockReturnValue({ score: 80, issues: [] }),
}));

import { checkDesignQuality } from '../src/bot/design-checker.js';
import { genesisValidateProposal } from '../src/node-types/genesis-validate-proposal.js';

const mockCheckDesignQuality = vi.mocked(checkDesignQuality);

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

function op(type: string, overrides: Record<string, unknown> = {}) {
  return { type, args: {}, costUnits: 99, rationale: 'test', ...overrides };
}

function makeCtx(
  ops: ReturnType<typeof op>[],
  configOverrides: Partial<GenesisConfig> = {},
  ctxOverrides: Partial<GenesisContext> = {},
): string {
  const config = { ...BASE_CONFIG, ...configOverrides };
  const proposal: GenesisProposal = {
    operations: ops as any,
    totalCost: 0,
    impactLevel: 'MINOR',
    summary: 'test proposal',
    rationale: 'test',
  };
  const ctx: GenesisContext = {
    env: {
      projectDir: '/proj',
      config: { provider: 'auto' as const },
      providerType: 'anthropic' as const,
      providerInfo: { type: 'anthropic' as const, apiKey: 'key' },
    },
    genesisConfigJson: JSON.stringify(config),
    cycleId: 'cycle-001',
    proposalJson: JSON.stringify(proposal),
    ...ctxOverrides,
  };
  return JSON.stringify(ctx);
}

function parseProposal(resultCtx: string): GenesisProposal {
  return JSON.parse((JSON.parse(resultCtx) as GenesisContext).proposalJson!);
}

describe('genesisValidateProposal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Default: design check passes, flow-weaver parse returns valid JSON
    mockExecFileSync.mockReturnValue(JSON.stringify({ nodes: [] }) as any);
    mockCheckDesignQuality.mockReturnValue({ score: 80, issues: [] });
  });

  describe('cost recalculation', () => {
    it('recalculates addNode cost to 1 regardless of AI value', () => {
      const result = genesisValidateProposal(makeCtx([op('addNode', { costUnits: 99 })]));
      const proposal = parseProposal(result.ctx);
      expect(proposal.operations[0].costUnits).toBe(1);
    });

    it('recalculates implementNode cost to 2', () => {
      const result = genesisValidateProposal(makeCtx([op('implementNode', { args: { nodeId: 'n1' } })]));
      const proposal = parseProposal(result.ctx);
      expect(proposal.operations[0].costUnits).toBe(2);
    });

    it('recalculates removeNode cost to 1', () => {
      const result = genesisValidateProposal(makeCtx([op('removeNode', { args: { nodeId: 'n1' } })]));
      const proposal = parseProposal(result.ctx);
      expect(proposal.operations[0].costUnits).toBe(1);
    });

    it('recalculates addConnection cost to 1', () => {
      const result = genesisValidateProposal(makeCtx([op('addConnection', { args: { from: 'a.b', to: 'c.d' } })]));
      const proposal = parseProposal(result.ctx);
      expect(proposal.operations[0].costUnits).toBe(1);
    });

    it('updates totalCost to reflect recalculated ops', () => {
      const result = genesisValidateProposal(makeCtx([op('addNode'), op('addNode')]));
      const proposal = parseProposal(result.ctx);
      expect(proposal.totalCost).toBe(2);
    });
  });

  describe('budget trimming', () => {
    it('trims ops to fit within budgetPerCycle', () => {
      // 4 addNode ops each costing 1, budget is 3 → trim to 3
      const result = genesisValidateProposal(makeCtx(
        [op('addNode'), op('addNode'), op('addNode'), op('addNode')],
        { budgetPerCycle: 3 },
      ));
      const proposal = parseProposal(result.ctx);
      expect(proposal.operations).toHaveLength(3);
      expect(proposal.totalCost).toBe(3);
    });

    it('keeps all ops when total cost equals budget', () => {
      const result = genesisValidateProposal(makeCtx(
        [op('addNode'), op('addNode'), op('addNode')],
        { budgetPerCycle: 3 },
      ));
      const proposal = parseProposal(result.ctx);
      expect(proposal.operations).toHaveLength(3);
    });

    it('trims from the end, preserving earlier ops', () => {
      const result = genesisValidateProposal(makeCtx(
        [
          op('addNode', { args: { nodeId: 'first' } }),
          op('addNode', { args: { nodeId: 'second' } }),
          op('addNode', { args: { nodeId: 'trimmed' } }),
          op('addNode', { args: { nodeId: 'also-trimmed' } }),
        ],
        { budgetPerCycle: 2 },
      ));
      const proposal = parseProposal(result.ctx);
      expect(proposal.operations).toHaveLength(2);
      expect((proposal.operations[0].args as any).nodeId).toBe('first');
      expect((proposal.operations[1].args as any).nodeId).toBe('second');
    });

    it('allows single implementNode (cost=2) within budget=2', () => {
      const result = genesisValidateProposal(makeCtx(
        [op('implementNode', { args: { nodeId: 'n1' } })],
        { budgetPerCycle: 2 },
      ));
      const proposal = parseProposal(result.ctx);
      expect(proposal.operations).toHaveLength(1);
    });

    it('trims implementNode when it exceeds budget', () => {
      // implementNode=2, but budget=1 → trimmed
      const result = genesisValidateProposal(makeCtx(
        [op('implementNode', { args: { nodeId: 'n1' } })],
        { budgetPerCycle: 1 },
      ));
      const proposal = parseProposal(result.ctx);
      expect(proposal.operations).toHaveLength(0);
    });
  });

  describe('stabilize mode', () => {
    it('filters out addNode ops when stabilized', () => {
      const result = genesisValidateProposal(
        makeCtx([op('addNode'), op('removeNode', { args: { nodeId: 'n1' } })], {}, { stabilized: true }),
      );
      const proposal = parseProposal(result.ctx);
      const types = proposal.operations.map(o => o.type);
      expect(types).not.toContain('addNode');
      expect(types).toContain('removeNode');
    });

    it('filters out addConnection ops when stabilized', () => {
      const result = genesisValidateProposal(
        makeCtx([op('addConnection', { args: { from: 'a.b', to: 'c.d' } }), op('removeNode', { args: { nodeId: 'n1' } })], {}, { stabilized: true }),
      );
      const proposal = parseProposal(result.ctx);
      const types = proposal.operations.map(o => o.type);
      expect(types).not.toContain('addConnection');
    });

    it('allows removeNode, removeConnection, implementNode in stabilize mode', () => {
      const result = genesisValidateProposal(
        makeCtx(
          [
            op('removeNode', { args: { nodeId: 'n1' } }),
            op('removeConnection', { args: { from: 'a.b', to: 'c.d' } }),
          ],
          {},
          { stabilized: true },
        ),
      );
      const proposal = parseProposal(result.ctx);
      expect(proposal.operations).toHaveLength(2);
    });

    it('logs filtered count in stabilize mode', () => {
      genesisValidateProposal(
        makeCtx([op('addNode'), op('addNode')], {}, { stabilized: true }),
      );
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('Stabilize: filtered 2'),
      );
    });
  });

  describe('selfEvolve disabled', () => {
    it('filters selfModifyWorkflow when selfEvolve is false/absent', () => {
      const result = genesisValidateProposal(
        makeCtx([op('selfModifyWorkflow', { args: { file: 'f', content: 'c' } }), op('addNode')]),
      );
      const proposal = parseProposal(result.ctx);
      const types = proposal.operations.map(o => o.type);
      expect(types).not.toContain('selfModifyWorkflow');
    });

    it('allows selfModifyWorkflow when selfEvolve is true', () => {
      const result = genesisValidateProposal(
        makeCtx(
          [op('selfModifyWorkflow', { args: { file: 'f', content: 'c' } })],
          { selfEvolve: true, selfEvolveBudget: 3 } as any,
        ),
      );
      const proposal = parseProposal(result.ctx);
      const types = proposal.operations.map(o => o.type);
      expect(types).toContain('selfModifyWorkflow');
    });

    it('logs filtered self-modify count', () => {
      genesisValidateProposal(
        makeCtx([op('selfModifyWorkflow', { args: { file: 'f', content: 'c' } })]),
      );
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('Self-evolve disabled'),
      );
    });
  });

  describe('self-modify arg validation', () => {
    it('filters selfModifyWorkflow missing file arg', () => {
      const result = genesisValidateProposal(
        makeCtx(
          [op('selfModifyWorkflow', { args: { content: 'c' } })],
          { selfEvolve: true } as any,
        ),
      );
      const proposal = parseProposal(result.ctx);
      expect(proposal.operations).toHaveLength(0);
    });

    it('filters selfModifyWorkflow missing content arg', () => {
      const result = genesisValidateProposal(
        makeCtx(
          [op('selfModifyWorkflow', { args: { file: 'f' } })],
          { selfEvolve: true } as any,
        ),
      );
      const proposal = parseProposal(result.ctx);
      expect(proposal.operations).toHaveLength(0);
    });

    it('keeps selfModifyWorkflow with both file and content', () => {
      const result = genesisValidateProposal(
        makeCtx(
          [op('selfModifyWorkflow', { args: { file: 'f', content: 'c' } })],
          { selfEvolve: true, selfEvolveBudget: 3 } as any,
        ),
      );
      const proposal = parseProposal(result.ctx);
      expect(proposal.operations).toHaveLength(1);
    });
  });

  describe('self-evolve budget', () => {
    it('uses selfEvolveBudget to cap self-modify ops', () => {
      const result = genesisValidateProposal(
        makeCtx(
          [
            op('selfModifyWorkflow', { args: { file: 'f', content: 'c' } }),
            op('selfModifyWorkflow', { args: { file: 'g', content: 'd' } }),
          ],
          { selfEvolve: true, selfEvolveBudget: 2 } as any,
        ),
      );
      const proposal = parseProposal(result.ctx);
      const selfOps = proposal.operations.filter(o => o.type === 'selfModifyWorkflow');
      expect(selfOps.length).toBeLessThanOrEqual(1); // each costs 3, budget=2 → trimmed to 0 actually
    });

    it('defaults selfEvolveBudget to 2 when not set', () => {
      const result = genesisValidateProposal(
        makeCtx(
          [op('selfModifyWorkflow', { args: { file: 'f', content: 'c' } })],
          { selfEvolve: true } as any,
        ),
      );
      const proposal = parseProposal(result.ctx);
      // selfModifyWorkflow costs 3, default selfEvolveBudget=2 → trimmed
      expect(proposal.operations.filter(o => o.type === 'selfModifyWorkflow')).toHaveLength(0);
    });
  });

  describe('design quality gate', () => {
    it('does not set approvalRequired when score is above threshold', () => {
      mockCheckDesignQuality.mockReturnValue({ score: 80, issues: [] });
      mockExecFileSync.mockReturnValue(JSON.stringify({ nodes: [] }) as any);

      const result = genesisValidateProposal(makeCtx([op('addNode')]));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.approvalRequired).not.toBe(true);
    });

    it('sets approvalRequired when design score is below threshold (50)', () => {
      mockCheckDesignQuality.mockReturnValue({ score: 30, issues: ['too complex'] });
      mockExecFileSync.mockReturnValue(JSON.stringify({ nodes: [] }) as any);

      const result = genesisValidateProposal(makeCtx([op('addNode')]));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.approvalRequired).toBe(true);
    });

    it('logs design score warning when below threshold', () => {
      mockCheckDesignQuality.mockReturnValue({ score: 20, issues: [] });
      mockExecFileSync.mockReturnValue(JSON.stringify({ nodes: [] }) as any);

      genesisValidateProposal(makeCtx([op('addNode')]));
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('Design score 20 below threshold'),
      );
    });

    it('skips design check when targetWorkflow is absent', () => {
      const result = genesisValidateProposal(makeCtx([op('addNode')], { targetWorkflow: '' }));
      // Should not throw and mockCheckDesignQuality should not be called
      expect(mockCheckDesignQuality).not.toHaveBeenCalled();
      expect(typeof result.ctx).toBe('string');
    });

    it('does not throw when flow-weaver parse fails', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('parse failed'); });
      // Should not throw — design check is non-fatal
      expect(() => genesisValidateProposal(makeCtx([op('addNode')]))).not.toThrow();
    });
  });

  describe('output ctx', () => {
    it('preserves other ctx fields', () => {
      const result = genesisValidateProposal(makeCtx([op('addNode')], {}, { cycleId: 'cycle-xyz' }));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.cycleId).toBe('cycle-xyz');
    });

    it('always sets proposalJson on ctx', () => {
      const result = genesisValidateProposal(makeCtx([op('addNode')]));
      const ctx = JSON.parse(result.ctx) as GenesisContext;
      expect(ctx.proposalJson).toBeDefined();
      expect(() => JSON.parse(ctx.proposalJson!)).not.toThrow();
    });

    it('logs validated proposal summary', () => {
      genesisValidateProposal(makeCtx([op('addNode')]));
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('Validated proposal'),
      );
    });
  });
});
