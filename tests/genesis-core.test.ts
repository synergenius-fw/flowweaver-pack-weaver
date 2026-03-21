import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GenesisContext, GenesisConfig, GenesisProposal, GenesisCycleRecord } from '../src/bot/types.js';

// Hoist mock instances so they're accessible in vi.mock factories (hoisted before module execution)
const mockLoadSnapshot = vi.hoisted(() => vi.fn().mockReturnValue('// snapshot content'));
const mockGetGenesisSystemPrompt = vi.hoisted(() => vi.fn().mockResolvedValue('system prompt'));
const mockGetOperationExamples = vi.hoisted(() => vi.fn().mockReturnValue('op examples'));
const mockCallAI = vi.hoisted(() => vi.fn());
const mockParseJsonResponse = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));
vi.mock('../src/bot/ai-client.js', () => ({
  callAI: mockCallAI,
  parseJsonResponse: mockParseJsonResponse,
}));
vi.mock('../src/bot/genesis-prompt-context.js', () => ({
  getGenesisSystemPrompt: mockGetGenesisSystemPrompt,
  getOperationExamples: mockGetOperationExamples,
}));
vi.mock('../src/bot/genesis-store.js', () => ({
  GenesisStore: vi.fn().mockImplementation(function () { return { loadSnapshot: mockLoadSnapshot }; }),
}));

import { genesisPropose } from '../src/node-types/genesis-propose.js';
import { genesisApplyRetry } from '../src/node-types/genesis-apply-retry.js';
import { genesisTryApply } from '../src/node-types/genesis-try-apply.js';
import { genesisCommit } from '../src/node-types/genesis-commit.js';
import { genesisReport } from '../src/node-types/genesis-report.js';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';

const mockExecFileSync = vi.mocked(execFileSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<GenesisConfig> = {}): GenesisConfig {
  return {
    intent: 'improve test coverage',
    focus: [],
    constraints: [],
    approvalThreshold: 'MINOR',
    budgetPerCycle: 5,
    stabilize: false,
    targetWorkflow: 'src/workflows/weaver-agent.ts',
    maxCyclesPerRun: 3,
    ...overrides,
  };
}

function makeCtx(config: GenesisConfig, extra: Partial<GenesisContext> = {}): string {
  const ctx: GenesisContext = {
    env: {
      projectDir: '/proj',
      config: { provider: 'auto' },
      providerType: 'anthropic',
      providerInfo: { type: 'anthropic', apiKey: 'test-key' },
    },
    genesisConfigJson: JSON.stringify(config),
    cycleId: 'cycle-001',
    diffJson: JSON.stringify({ added: [], modified: [], deleted: [] }),
    fingerprintJson: JSON.stringify({
      timestamp: '2026-01-01', files: {}, packageJson: null,
      gitBranch: 'main', gitCommit: 'abc123', workflowHash: 'h1', existingWorkflows: [],
    }),
    snapshotPath: '/proj/.genesis/snapshots/snap-001.ts',
    ...extra,
  };
  return JSON.stringify(ctx);
}

function makeProposal(ops: GenesisProposal['operations'] = []): GenesisProposal {
  return {
    operations: ops,
    totalCost: ops.reduce((s, o) => s + o.costUnits, 0),
    impactLevel: 'MINOR',
    summary: 'test proposal',
    rationale: 'testing',
  };
}

// ─── genesisPropose ───────────────────────────────────────────────────────────

describe('genesisPropose', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGenesisSystemPrompt.mockResolvedValue('system prompt');
    mockGetOperationExamples.mockReturnValue('op examples');
  });

  it('execute=false returns dry run with empty operations (no AI call)', async () => {
    const result = await genesisPropose(false, makeCtx(makeConfig()));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    const proposal = JSON.parse(ctx.proposalJson!) as GenesisProposal;
    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);
    expect(proposal.operations).toHaveLength(0);
    expect(proposal.summary).toBe('dry run');
    expect(mockCallAI).not.toHaveBeenCalled();
  });

  it('AI success stores proposalJson and returns onSuccess', async () => {
    const proposal = makeProposal([
      { type: 'addNode', args: { nodeId: 'n1', nodeType: 'MyNode' }, costUnits: 1, rationale: 'add node' },
    ]);
    mockCallAI.mockResolvedValue('{"operations":[]}');
    mockParseJsonResponse.mockReturnValue(proposal);

    const result = await genesisPropose(true, makeCtx(makeConfig(), { workflowDescription: 'test wf' }));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    const stored = JSON.parse(ctx.proposalJson!);
    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);
    expect(stored.summary).toBe('test proposal');
    expect(stored.operations).toHaveLength(1);
  });

  it('non-transient AI error returns onFailure with error in proposalJson summary', async () => {
    mockCallAI.mockRejectedValue(new Error('API quota exceeded'));

    const result = await genesisPropose(true, makeCtx(makeConfig()));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    const proposal = JSON.parse(ctx.proposalJson!) as GenesisProposal;
    expect(result.onSuccess).toBe(false);
    expect(result.onFailure).toBe(true);
    expect(proposal.summary).toContain('Failed');
    expect(ctx.error).toContain('Proposal failed');
  });

  it('transient ETIMEDOUT on first attempt retries and succeeds on second', async () => {
    const proposal = makeProposal();
    mockCallAI
      .mockRejectedValueOnce(new Error('ETIMEDOUT: connection timed out'))
      .mockResolvedValueOnce('{"operations":[]}');
    mockParseJsonResponse.mockReturnValue(proposal);

    const result = await genesisPropose(true, makeCtx(makeConfig()));
    expect(result.onSuccess).toBe(true);
    expect(mockCallAI).toHaveBeenCalledTimes(2);
  });
});

// ─── genesisApplyRetry ────────────────────────────────────────────────────────

describe('genesisApplyRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadSnapshot.mockReturnValue('// snapshot content');
    mockGetGenesisSystemPrompt.mockResolvedValue('system prompt');
    mockGetOperationExamples.mockReturnValue('op examples');
    mockCallAI.mockResolvedValue('{"operations":[]}');
    mockParseJsonResponse.mockReturnValue(makeProposal());
  });

  it('execute=false returns onSuccess and does not invoke attempt callback', async () => {
    const attempt = vi.fn();
    const result = await genesisApplyRetry(false, makeCtx(makeConfig()), attempt);
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);
    expect(JSON.parse(ctx.applyResultJson!).applied).toBe(0);
    expect(attempt).not.toHaveBeenCalled();
  });

  it('child succeeds on first attempt returns onSuccess after single call', async () => {
    const successCtx = makeCtx(makeConfig(), { applyResultJson: JSON.stringify({ applied: 2, failed: 0, errors: [] }) });
    const attempt = vi.fn().mockResolvedValue({ success: true, failure: false, attemptCtx: successCtx });

    const result = await genesisApplyRetry(
      true,
      makeCtx(makeConfig(), { proposalJson: JSON.stringify(makeProposal()) }),
      attempt,
    );
    expect(result.onSuccess).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('child fails all 3 attempts returns onFailure', async () => {
    const failCtx = makeCtx(makeConfig(), {
      error: 'compile error',
      applyResultJson: JSON.stringify({ applied: 1, failed: 0, errors: [] }),
    });
    const attempt = vi.fn().mockResolvedValue({ success: false, failure: true, attemptCtx: failCtx });

    const result = await genesisApplyRetry(
      true,
      makeCtx(makeConfig(), { proposalJson: JSON.stringify(makeProposal()), snapshotPath: '/snap.ts' }),
      attempt,
    );
    expect(result.onSuccess).toBe(false);
    expect(result.onFailure).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(3);
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(ctx.error).toContain('Apply/compile failed after 3 attempts');
  });

  it('child fails first try then AI revises proposal and child succeeds on second', async () => {
    const failCtx = makeCtx(makeConfig(), {
      error: 'compile error',
      applyResultJson: JSON.stringify({ applied: 1, failed: 0, errors: [] }),
    });
    const successCtx = makeCtx(makeConfig(), { applyResultJson: JSON.stringify({ applied: 1, failed: 0, errors: [] }) });
    const attempt = vi.fn()
      .mockResolvedValueOnce({ success: false, failure: true, attemptCtx: failCtx })
      .mockResolvedValueOnce({ success: true, failure: false, attemptCtx: successCtx });

    mockCallAI.mockResolvedValue('{"operations":[]}');
    mockParseJsonResponse.mockReturnValue(makeProposal());

    const result = await genesisApplyRetry(
      true,
      makeCtx(makeConfig(), { proposalJson: JSON.stringify(makeProposal()), snapshotPath: '/snap.ts' }),
      attempt,
    );
    expect(result.onSuccess).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(mockCallAI).toHaveBeenCalledTimes(1); // AI revised once between attempts
  });

  it('AI revision throws during retry — exits loop and returns onFailure', async () => {
    const failCtx = makeCtx(makeConfig(), {
      error: 'compile error',
      applyResultJson: JSON.stringify({ applied: 1, failed: 0, errors: [] }),
    });
    const attempt = vi.fn().mockResolvedValue({ success: false, failure: true, attemptCtx: failCtx });
    mockCallAI.mockRejectedValue(new Error('AI unavailable'));

    const result = await genesisApplyRetry(
      true,
      makeCtx(makeConfig(), { proposalJson: JSON.stringify(makeProposal()), snapshotPath: '/snap.ts' }),
      attempt,
    );

    expect(result.onSuccess).toBe(false);
    expect(result.onFailure).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(1);
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(ctx.error).toContain('Apply');
  });

  it('AI revision succeeds but parseJsonResponse throws — exits loop and returns onFailure', async () => {
    const failCtx = makeCtx(makeConfig(), {
      error: 'compile error',
      applyResultJson: JSON.stringify({ applied: 1, failed: 0, errors: [] }),
    });
    const attempt = vi.fn().mockResolvedValue({ success: false, failure: true, attemptCtx: failCtx });
    mockCallAI.mockResolvedValue('not valid json');
    mockParseJsonResponse.mockImplementation(() => { throw new Error('parse error'); });

    const result = await genesisApplyRetry(
      true,
      makeCtx(makeConfig(), { proposalJson: JSON.stringify(makeProposal()), snapshotPath: '/snap.ts' }),
      attempt,
    );

    expect(result.onSuccess).toBe(false);
    expect(result.onFailure).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(1);
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(ctx.error).toContain('Apply');
  });
});

// ─── genesisTryApply ──────────────────────────────────────────────────────────

describe('genesisTryApply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadSnapshot.mockReturnValue('// snapshot');
    mockExecFileSync.mockReturnValue('');
  });

  function makeApplyCtx(ops: GenesisProposal['operations'] = []): string {
    return makeCtx(makeConfig(), { proposalJson: JSON.stringify(makeProposal(ops)) });
  }

  it('execute=false returns onSuccess with zero applied', async () => {
    const result = await genesisTryApply(false, makeApplyCtx());
    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(JSON.parse(ctx.applyResultJson!).applied).toBe(0);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('addConnection with missing "to" fails pre-validation and returns onFailure', async () => {
    const ops = [{ type: 'addConnection' as const, args: { from: 'nodeA.port' }, costUnits: 1, rationale: 'test' }];
    const result = await genesisTryApply(true, makeApplyCtx(ops));
    expect(result.onSuccess).toBe(false);
    expect(result.onFailure).toBe(true);
    const applyResult = JSON.parse((JSON.parse(result.ctx) as GenesisContext).applyResultJson!);
    expect(applyResult.failed).toBe(1);
    expect(applyResult.errors[0]).toContain("missing 'from' or 'to'");
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('addConnection with colon-format "from" fails pre-validation', async () => {
    const ops = [{ type: 'addConnection' as const, args: { from: 'node:port', to: 'nodeB.port' }, costUnits: 1, rationale: 'test' }];
    const result = await genesisTryApply(true, makeApplyCtx(ops));
    const applyResult = JSON.parse((JSON.parse(result.ctx) as GenesisContext).applyResultJson!);
    expect(applyResult.errors[0]).toContain('"node.port" format');
  });

  it('all ops fail CLI call → onFailure with applied=0', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('CLI error'); });
    const ops = [{ type: 'addNode' as const, args: { nodeId: 'n1', nodeType: 'MyNode' }, costUnits: 1, rationale: 'test' }];
    const result = await genesisTryApply(true, makeApplyCtx(ops));
    expect(result.onSuccess).toBe(false);
    expect(result.onFailure).toBe(true);
    expect(JSON.parse((JSON.parse(result.ctx) as GenesisContext).applyResultJson!).applied).toBe(0);
  });

  it('ops succeed but validate fails → onFailure and snapshot restored', async () => {
    let callCount = 0;
    mockExecFileSync.mockImplementation(() => {
      callCount++;
      if (callCount >= 2) throw new Error('UNKNOWN_SOURCE_PORT: bad port');
      return '';
    });
    const ops = [{ type: 'addNode' as const, args: { nodeId: 'n1', nodeType: 'MyNode' }, costUnits: 1, rationale: 'test' }];
    const result = await genesisTryApply(true, makeApplyCtx(ops));
    expect(result.onSuccess).toBe(false);
    expect(result.onFailure).toBe(true);
    // snapshot restored: writeFileSync called with target path
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('weaver-agent.ts'),
      '// snapshot',
      'utf-8',
    );
  });

  it('ops succeed + validate + compile all pass → onSuccess (3 execFileSync calls)', async () => {
    mockExecFileSync.mockReturnValue('');
    const ops = [{ type: 'addNode' as const, args: { nodeId: 'n1', nodeType: 'MyNode' }, costUnits: 1, rationale: 'test' }];
    const result = await genesisTryApply(true, makeApplyCtx(ops));
    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);
    expect(mockExecFileSync).toHaveBeenCalledTimes(3); // modify, validate, compile
  });

  it('validate passes but compile fails → onFailure and snapshot restored', async () => {
    mockExecFileSync
      .mockReturnValueOnce('')  // call 1: modify op succeeds
      .mockReturnValueOnce('')  // call 2: validate succeeds
      .mockImplementationOnce(() => { throw new Error('TS compilation error'); }); // call 3: compile fails

    const ops = [{ type: 'addNode' as const, args: { nodeId: 'n1', nodeType: 'MyNode' }, costUnits: 1, rationale: 'test' }];
    const result = await genesisTryApply(true, makeApplyCtx(ops));

    expect(result.onSuccess).toBe(false);
    expect(result.onFailure).toBe(true);
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(ctx.error).toContain('TS compilation error');
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('weaver-agent.ts'),
      '// snapshot',
      'utf-8',
    );
  });

  it('mixed partial success: some ops succeed, some fail, then validate passes → onSuccess', async () => {
    mockExecFileSync
      .mockImplementationOnce(() => { throw new Error('CLI error'); }) // op 1 fails
      .mockReturnValueOnce('')   // op 2 succeeds
      .mockReturnValueOnce('')   // validate passes
      .mockReturnValueOnce('');  // compile passes

    const ops = [
      { type: 'addNode' as const, args: { nodeId: 'n1', nodeType: 'MyNode' }, costUnits: 1, rationale: 'first' },
      { type: 'addNode' as const, args: { nodeId: 'n2', nodeType: 'MyNode' }, costUnits: 1, rationale: 'second' },
    ];
    const result = await genesisTryApply(true, makeApplyCtx(ops));

    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    const applyResult = JSON.parse(ctx.applyResultJson!);
    expect(applyResult.applied).toBe(1);
    expect(applyResult.failed).toBe(1);
  });
});

// ─── genesisCommit ────────────────────────────────────────────────────────────

describe('genesisCommit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadSnapshot.mockReturnValue('// snapshot');
    mockExecFileSync.mockReturnValue('');
  });

  it('execute=false returns dry run result without git calls', async () => {
    const result = await genesisCommit(false, makeCtx(makeConfig()));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(result.onSuccess).toBe(true);
    expect(JSON.parse(ctx.commitResultJson!)).toEqual({ committed: false, reason: 'dry run' });
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('approved=false restores snapshot and returns onFailure', async () => {
    const result = await genesisCommit(
      true,
      makeCtx(makeConfig(), { approved: false, snapshotPath: '/proj/.genesis/snap.ts' }),
    );
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(result.onSuccess).toBe(false);
    expect(result.onFailure).toBe(true);
    expect(JSON.parse(ctx.commitResultJson!).reason).toBe('not approved');
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('weaver-agent.ts'),
      '// snapshot',
      'utf-8',
    );
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('approved=true and git succeeds → onSuccess with committed=true and genesis: message', async () => {
    mockExecFileSync.mockReturnValue('');
    const result = await genesisCommit(true, makeCtx(makeConfig(), { approved: true }));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);
    const commitResult = JSON.parse(ctx.commitResultJson!);
    expect(commitResult.committed).toBe(true);
    expect(commitResult.message).toContain('genesis: evolve');
    expect(commitResult.message).toContain('weaver-agent.ts');
  });

  it('approved=true but git commit throws → onFailure with committed=false', async () => {
    mockExecFileSync
      .mockReturnValueOnce('') // git add succeeds
      .mockImplementationOnce(() => { throw new Error('nothing to commit, working tree clean'); });

    const result = await genesisCommit(true, makeCtx(makeConfig(), { approved: true }));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(result.onSuccess).toBe(false);
    expect(result.onFailure).toBe(true);
    expect(JSON.parse(ctx.commitResultJson!).committed).toBe(false);
  });
});

// ─── genesisReport ────────────────────────────────────────────────────────────

describe('genesisReport', () => {
  function makeReportCtx(extra: Partial<GenesisContext> = {}): string {
    const ctx: GenesisContext = {
      env: {
        projectDir: '/proj',
        config: { provider: 'auto' },
        providerType: 'anthropic',
        providerInfo: { type: 'anthropic', apiKey: 'test-key' },
      },
      genesisConfigJson: JSON.stringify(makeConfig()),
      cycleId: 'cycle-001',
      ...extra,
    };
    return JSON.stringify(ctx);
  }

  function makeRecord(overrides: Partial<GenesisCycleRecord> = {}): GenesisCycleRecord {
    return {
      id: 'cycle-001',
      timestamp: '2026-01-01T00:00:00Z',
      durationMs: 1500,
      fingerprint: {
        timestamp: '2026-01-01', files: {}, packageJson: null,
        gitBranch: 'main', gitCommit: 'abc123', workflowHash: 'h1', existingWorkflows: [],
      },
      proposal: null,
      outcome: 'applied',
      diffSummary: null,
      approvalRequired: false,
      approved: null,
      error: null,
      snapshotFile: null,
      ...overrides,
    };
  }

  it('no args returns "Genesis cycle completed with no record"', () => {
    const result = genesisReport();
    expect(result.summary).toBe('Genesis cycle completed with no record');
  });

  it('commitFailCtx used as fallback when other args are undefined', () => {
    const ctxJson = makeReportCtx({ error: 'Commit failed: nothing to commit' });
    const result = genesisReport(undefined, undefined, undefined, ctxJson);
    expect(result.summary).toContain('commit failed');
  });

  it('error starting with "Proposal failed" → summary contains "proposal failed"', () => {
    const ctxJson = makeReportCtx({ error: 'Proposal failed: AI returned empty response' });
    const result = genesisReport(undefined, ctxJson);
    expect(result.summary).toContain('proposal failed');
  });

  it('error containing "not approved" → summary contains "proposal rejected"', () => {
    const ctxJson = makeReportCtx({ error: 'proposal not approved by threshold check' });
    const result = genesisReport(undefined, undefined, ctxJson);
    expect(result.summary).toContain('proposal rejected');
  });

  it('error containing "Apply" → summary contains "apply/compile failed"', () => {
    const ctxJson = makeReportCtx({
      error: 'Apply/compile failed after 3 attempts',
      applyResultJson: JSON.stringify({ applied: 1, failed: 2 }),
    });
    const result = genesisReport(undefined, ctxJson);
    expect(result.summary).toContain('apply/compile failed');
    expect(result.summary).toContain('applied: 1');
    expect(result.summary).toContain('failed: 2');
  });

  it('no error and no cycleRecordJson → "Genesis: no changes proposed"', () => {
    const ctxJson = makeReportCtx();
    const result = genesisReport(ctxJson);
    expect(result.summary).toContain('no changes proposed');
  });

  it('cycleRecordJson with proposal, outcome=applied, approved=true → full summary', () => {
    const proposal = makeProposal([
      { type: 'addNode', args: { nodeId: 'n1', nodeType: 'MyNode' }, costUnits: 1, rationale: 'add node' },
      { type: 'addNode', args: { nodeId: 'n2', nodeType: 'MyNode' }, costUnits: 1, rationale: 'add node' },
    ]);
    const record = makeRecord({ proposal, outcome: 'applied', approved: true, approvalRequired: true });
    const ctxJson = makeReportCtx({ cycleRecordJson: JSON.stringify(record) });

    const result = genesisReport(ctxJson);
    expect(result.summary).toContain('Genesis:');
    expect(result.summary).toContain('cycle-001');
    expect(result.summary).toContain('2 ops');
    expect(result.summary).toContain('applied');
    expect(result.summary).toContain('approved');
  });

  it('cycleRecordJson with outcome=rejected, approved=false → summary reflects rejection', () => {
    const record = makeRecord({ outcome: 'rejected', approved: false, approvalRequired: true });
    const ctxJson = makeReportCtx({ cycleRecordJson: JSON.stringify(record) });

    const result = genesisReport(ctxJson);
    expect(result.summary).toContain('rejected');
  });

  it('cycleRecordJson with no proposal → summary still works without ops/impact', () => {
    const record = makeRecord({ proposal: null, outcome: 'no-change' });
    const ctxJson = makeReportCtx({ cycleRecordJson: JSON.stringify(record) });

    const result = genesisReport(ctxJson);
    expect(result.summary).toContain('Genesis:');
    expect(result.summary).toContain('no-change');
  });

  it('successCtx takes priority over failCtx when both provided', () => {
    const successCtxJson = makeReportCtx();
    const failCtxJson = makeReportCtx({ error: 'Apply/compile failed after 3 attempts' });
    const result = genesisReport(successCtxJson, failCtxJson);
    expect(result.summary).toContain('no changes proposed');
    expect(result.summary).not.toContain('apply/compile failed');
  });

  // ── edge cases ───────────────────────────────────────────────────────────────

  it('malformed JSON in ctx argument throws a parse error', () => {
    expect(() => genesisReport('{ not valid json ]')).toThrow();
  });

  it('cycleRecordJson with outcome="rolled-back" uses non-green color path (yellow)', () => {
    const record = makeRecord({ outcome: 'rolled-back' });
    const ctxJson = makeReportCtx({ cycleRecordJson: JSON.stringify(record) });
    // outcome is not 'applied' or 'error', so it should not fail and summary includes outcome
    const result = genesisReport(ctxJson);
    expect(result.summary).toContain('rolled-back');
    expect(result.summary).not.toContain('apply/compile failed');
  });

  it('cycleRecordJson with approved=false shows "rejected" in summary', () => {
    const record = makeRecord({ outcome: 'rejected', approved: false, approvalRequired: true });
    const ctxJson = makeReportCtx({ cycleRecordJson: JSON.stringify(record) });
    const result = genesisReport(ctxJson);
    expect(result.summary).toContain('rejected');
  });

  it('applyResultJson present in error context adds applied/failed counts to summary', () => {
    const ctxJson = makeReportCtx({
      error: 'Apply/compile failed after 3 attempts',
      applyResultJson: JSON.stringify({ applied: 3, failed: 1 }),
    });
    const result = genesisReport(undefined, ctxJson);
    expect(result.summary).toContain('apply/compile failed');
    expect(result.summary).toContain('applied: 3');
    expect(result.summary).toContain('failed: 1');
  });

  it('elapsed under 60s shows seconds format (e.g. "1.5s")', () => {
    const startTimeMs = Date.now() - 1500; // 1.5 seconds ago
    const ctxJson = makeReportCtx({ startTimeMs });
    const result = genesisReport(ctxJson);
    // Should contain a time in seconds format: digits followed by 's'
    expect(result.summary).toMatch(/\d+\.\ds/);
    expect(result.summary).not.toMatch(/\dm/);
  });

  it('elapsed over 60s shows minutes+seconds format (e.g. "2m5s")', () => {
    const startTimeMs = Date.now() - 125_000; // 125 seconds ago
    const ctxJson = makeReportCtx({ startTimeMs });
    const result = genesisReport(ctxJson);
    // Should contain a time in minutes format: digits followed by 'm' then digits followed by 's'
    expect(result.summary).toMatch(/\dm\d+s/);
  });
});
