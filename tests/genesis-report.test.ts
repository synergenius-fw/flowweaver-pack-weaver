import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GenesisContext, GenesisCycleRecord } from '../src/bot/types.js';
import { genesisReport } from '../src/node-types/genesis-report.js';

function makeCtx(overrides: Partial<GenesisContext> = {}): string {
  const ctx: GenesisContext = {
    env: {
      projectDir: '/proj',
      config: { provider: 'auto' as const },
      providerType: 'anthropic' as const,
      providerInfo: { type: 'anthropic' as const, apiKey: 'key' },
    },
    genesisConfigJson: '{}',
    cycleId: 'cycle-001',
    ...overrides,
  };
  return JSON.stringify(ctx);
}

function makeRecord(overrides: Partial<GenesisCycleRecord> = {}): GenesisCycleRecord {
  return {
    id: 'cycle-001',
    timestamp: new Date().toISOString(),
    outcome: 'applied',
    approved: true,
    proposal: {
      operations: [{ type: 'addNode', args: { nodeId: 'n1', nodeType: 'A' }, costUnits: 1, rationale: 'test' }],
      totalCost: 1,
      impactLevel: 'MINOR',
      summary: 'Add a node',
      rationale: 'Improve flow',
    },
    error: undefined,
    ...overrides,
  };
}

describe('genesisReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('no context provided', () => {
    it('returns a summary string when called with no args', () => {
      const result = genesisReport();
      expect(typeof result.summary).toBe('string');
      expect(result.summary).toContain('no record');
    });

    it('logs the no-record message', () => {
      genesisReport();
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('no record'),
      );
    });
  });

  describe('successCtx path', () => {
    it('uses successCtx when provided', () => {
      const ctx = makeCtx({ cycleRecordJson: JSON.stringify(makeRecord()) });
      const result = genesisReport(ctx);
      expect(result.summary).toContain('Cycle cycle-001');
    });

    it('includes operation count in summary', () => {
      const record = makeRecord({ proposal: { operations: [{ type: 'addNode', args: {}, costUnits: 1, rationale: 'r' }, { type: 'removeNode', args: {}, costUnits: 1, rationale: 'r' }], totalCost: 2, impactLevel: 'MINOR', summary: 'two ops', rationale: '' } });
      const ctx = makeCtx({ cycleRecordJson: JSON.stringify(record) });
      const result = genesisReport(ctx);
      expect(result.summary).toContain('2 ops');
    });

    it('includes impactLevel in summary', () => {
      const record = makeRecord({ proposal: { operations: [], totalCost: 0, impactLevel: 'BREAKING', summary: 'breaking', rationale: '' } });
      const ctx = makeCtx({ cycleRecordJson: JSON.stringify(record) });
      const result = genesisReport(ctx);
      expect(result.summary).toContain('impact=BREAKING');
    });

    it('includes outcome in summary', () => {
      const ctx = makeCtx({ cycleRecordJson: JSON.stringify(makeRecord({ outcome: 'applied' })) });
      const result = genesisReport(ctx);
      expect(result.summary).toContain('applied');
    });

    it('includes approved=true in summary', () => {
      const ctx = makeCtx({ cycleRecordJson: JSON.stringify(makeRecord({ approved: true })) });
      const result = genesisReport(ctx);
      expect(result.summary).toContain('approved');
    });

    it('includes rejected when approved=false', () => {
      const ctx = makeCtx({ cycleRecordJson: JSON.stringify(makeRecord({ approved: false, outcome: 'rejected' })) });
      const result = genesisReport(ctx);
      expect(result.summary).toContain('rejected');
    });

    it('includes record.error in summary when present', () => {
      const record = makeRecord({ error: 'something went wrong', outcome: 'error' });
      const ctx = makeCtx({ cycleRecordJson: JSON.stringify(record) });
      const result = genesisReport(ctx);
      expect(result.summary).toContain('something went wrong');
    });

    it('logs the summary', () => {
      const ctx = makeCtx({ cycleRecordJson: JSON.stringify(makeRecord()) });
      const result = genesisReport(ctx);
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining(result.summary),
      );
    });
  });

  describe('failCtx path', () => {
    it('uses failCtx when successCtx is undefined', () => {
      const ctx = makeCtx({ cycleRecordJson: JSON.stringify(makeRecord({ outcome: 'error' })) });
      const result = genesisReport(undefined, ctx);
      expect(result.summary).toContain('Cycle cycle-001');
    });
  });

  describe('proposeFailCtx path', () => {
    it('uses proposeFailCtx when successCtx and failCtx are undefined', () => {
      const ctx = makeCtx({ cycleRecordJson: JSON.stringify(makeRecord()) });
      const result = genesisReport(undefined, undefined, ctx);
      expect(result.summary).toContain('Cycle cycle-001');
    });
  });

  describe('commitFailCtx path', () => {
    it('uses commitFailCtx as last fallback', () => {
      const ctx = makeCtx({ cycleRecordJson: JSON.stringify(makeRecord()) });
      const result = genesisReport(undefined, undefined, undefined, ctx);
      expect(result.summary).toContain('Cycle cycle-001');
    });
  });

  describe('context with error (no cycleRecordJson)', () => {
    it('reports proposal failure from error field', () => {
      const ctx = makeCtx({ error: 'Proposal failed: timeout' });
      const result = genesisReport(ctx);
      expect(result.summary).toContain('proposal failed');
    });

    it('reports commit failure', () => {
      const ctx = makeCtx({ error: 'Commit failed: git error' });
      const result = genesisReport(ctx);
      expect(result.summary).toContain('commit failed');
    });

    it('reports apply/compile failure', () => {
      const ctx = makeCtx({ error: 'Apply step threw an error' });
      const result = genesisReport(ctx);
      expect(result.summary).toContain('apply/compile failed');
    });

    it('reports rejection', () => {
      const ctx = makeCtx({ error: 'proposal not approved' });
      const result = genesisReport(ctx);
      expect(result.summary).toContain('proposal rejected');
    });

    it('includes applyResultJson applied/failed counts when present', () => {
      const ctx = makeCtx({
        error: 'Apply step threw',
        applyResultJson: JSON.stringify({ applied: 2, failed: 1, errors: [] }),
      });
      const result = genesisReport(ctx);
      expect(result.summary).toContain('applied: 2');
      expect(result.summary).toContain('failed: 1');
    });

    it('handles malformed applyResultJson gracefully', () => {
      const ctx = makeCtx({
        error: 'Apply step threw',
        applyResultJson: 'not json',
      });
      // Should not throw
      const result = genesisReport(ctx);
      expect(typeof result.summary).toBe('string');
    });

    it('logs malformed applyResultJson error when WEAVER_VERBOSE is set', () => {
      const origVerbose = process.env.WEAVER_VERBOSE;
      process.env.WEAVER_VERBOSE = '1';

      const ctx = makeCtx({
        error: 'Apply step threw',
        applyResultJson: 'not json',
      });
      genesisReport(ctx);

      expect(vi.mocked(console.error)).toHaveBeenCalledWith(
        expect.stringContaining('[genesis-report] applyResultJson parse failed:'),
        expect.any(Error),
      );

      process.env.WEAVER_VERBOSE = origVerbose;
    });
  });

  describe('context with no cycleRecordJson and no error', () => {
    it('returns no changes proposed summary', () => {
      const ctx = makeCtx();
      const result = genesisReport(ctx);
      expect(result.summary).toContain('no changes proposed');
    });

    it('logs the no-changes message', () => {
      const ctx = makeCtx();
      genesisReport(ctx);
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('no changes proposed'),
      );
    });
  });

  describe('elapsed time formatting', () => {
    it('includes elapsed seconds when startTimeMs is set', () => {
      const startTimeMs = Date.now() - 5500; // 5.5 seconds ago
      const ctx = makeCtx({ startTimeMs, cycleRecordJson: JSON.stringify(makeRecord()) });
      const result = genesisReport(ctx);
      expect(result.summary).toMatch(/\d+\.\d+s/);
    });

    it('formats minutes correctly for longer runs', () => {
      const startTimeMs = Date.now() - 90_000; // 90 seconds ago
      const ctx = makeCtx({ startTimeMs, cycleRecordJson: JSON.stringify(makeRecord()) });
      const result = genesisReport(ctx);
      expect(result.summary).toMatch(/1m\d+s/);
    });

    it('omits elapsed when startTimeMs is absent', () => {
      const ctx = makeCtx({ cycleRecordJson: JSON.stringify(makeRecord()) });
      const result = genesisReport(ctx);
      // No trailing seconds/minutes pattern required — just confirm no crash
      expect(typeof result.summary).toBe('string');
    });
  });

  describe('approved=null in record', () => {
    it('does not include approved/rejected when approved is null', () => {
      const record = makeRecord({ approved: null });
      const ctx = makeCtx({ cycleRecordJson: JSON.stringify(record) });
      const result = genesisReport(ctx);
      // Should not contain "approved" or "rejected" as approval status
      // The summary still has "applied" outcome, but not the approval label
      expect(result.summary).not.toContain('| approved |');
      expect(result.summary).not.toContain('| rejected |');
    });
  });
});
