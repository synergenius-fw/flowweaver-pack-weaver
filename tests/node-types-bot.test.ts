import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { WeaverEnv, WeaverContext } from '../src/bot/types.js';
import { weaverRouteTask } from '../src/node-types/route-task.js';
import { weaverAbortTask } from '../src/node-types/abort-task.js';
import { weaverBotReport } from '../src/node-types/bot-report.js';
import { weaverGitOps } from '../src/node-types/git-ops.js';
import { parseJsonResponse } from '../src/bot/ai-client.js';

function makeEnv(overrides?: Partial<WeaverEnv>): WeaverEnv {
  return {
    projectDir: '/tmp/test',
    config: { provider: 'auto' },
    providerType: 'anthropic',
    providerInfo: { type: 'anthropic', apiKey: 'test-key', model: 'claude-sonnet-4-6' },
    ...overrides,
  };
}

function makeWeaverCtx(overrides: Partial<WeaverContext> = {}): string {
  return JSON.stringify({
    env: makeEnv(),
    taskJson: '{}',
    ...overrides,
  });
}

// --- Tier 1: Pure functions (no mocking) ---

describe('weaverRouteTask', () => {
  it('routes create mode through success path', () => {
    const task = { instruction: 'build something', mode: 'create' };
    const ctx = makeWeaverCtx({ taskJson: JSON.stringify(task) });
    const result = weaverRouteTask(ctx);
    const parsed = JSON.parse(result.ctx) as WeaverContext;
    expect(parsed.taskJson).toBe(JSON.stringify(task));
  });

  it('routes modify mode through success path', () => {
    const task = { instruction: 'fix something', mode: 'modify' };
    const ctx = makeWeaverCtx({ taskJson: JSON.stringify(task) });
    const result = weaverRouteTask(ctx);
    const parsed = JSON.parse(result.ctx) as WeaverContext;
    expect(parsed.taskJson).toBe(JSON.stringify(task));
  });

  it('routes batch mode through success path', () => {
    const task = { instruction: 'batch ops', mode: 'batch' };
    const ctx = makeWeaverCtx({ taskJson: JSON.stringify(task) });
    const result = weaverRouteTask(ctx);
    const parsed = JSON.parse(result.ctx) as WeaverContext;
    expect(parsed.taskJson).toBe(JSON.stringify(task));
  });

  it('throws for read mode (fail path)', () => {
    const task = { instruction: 'describe workflow', mode: 'read' };
    const ctx = makeWeaverCtx({ taskJson: JSON.stringify(task) });
    expect(() => weaverRouteTask(ctx)).toThrow('read-only-route');
  });

  it('defaults to create mode when mode is not specified', () => {
    const task = { instruction: 'no mode set' };
    const ctx = makeWeaverCtx({ taskJson: JSON.stringify(task) });
    const result = weaverRouteTask(ctx);
    const parsed = JSON.parse(result.ctx) as WeaverContext;
    expect(parsed.taskJson).toBe(JSON.stringify(task));
  });
});

describe('weaverAbortTask', () => {
  it('returns result with success=false and outcome=aborted', () => {
    const task = { instruction: 'do something' };
    const ctx = makeWeaverCtx({ taskJson: JSON.stringify(task), rejectionReason: 'user rejected' });
    const result = weaverAbortTask(ctx);
    const parsed = JSON.parse(result.ctx) as WeaverContext;
    const resultObj = JSON.parse(parsed.resultJson!);

    expect(resultObj.success).toBe(false);
    expect(resultObj.outcome).toBe('aborted');
    expect(resultObj.summary).toContain('user rejected');
    expect(resultObj.instruction).toBe('do something');
    expect(resultObj.filesModified).toEqual([]);
    expect(resultObj.filesCreated).toEqual([]);
  });

  it('preserves env through', () => {
    const ctx = makeWeaverCtx({ taskJson: '{}', rejectionReason: 'reason' });
    const result = weaverAbortTask(ctx);
    const parsed = JSON.parse(result.ctx) as WeaverContext;
    expect(parsed.env.projectDir).toBe('/tmp/test');
  });

  it('returns empty filesModified array', () => {
    const ctx = makeWeaverCtx({ taskJson: '{}', rejectionReason: 'reason' });
    const result = weaverAbortTask(ctx);
    const parsed = JSON.parse(result.ctx) as WeaverContext;
    expect(parsed.filesModified).toBe('[]');
  });
});

describe('weaverBotReport', () => {
  it('reports from read path', async () => {
    const readCtx = makeWeaverCtx({ resultJson: JSON.stringify({ success: true, outcome: 'read', summary: 'Workflow has 5 nodes' }) });
    const result = await weaverBotReport(true, undefined, readCtx);
    const report = JSON.parse(result.reportJson);
    expect(report.path).toBe('read');
    expect(result.summary).toContain('read');
  });

  it('reports from main path', async () => {
    const mainCtx = makeWeaverCtx({ resultJson: JSON.stringify({ success: true, outcome: 'completed', summary: 'Created workflow' }) });
    const result = await weaverBotReport(true, mainCtx);
    const report = JSON.parse(result.reportJson);
    expect(report.path).toBe('main');
    expect(result.summary).toContain('completed');
  });

  it('reports from abort path', async () => {
    const abortCtx = makeWeaverCtx({ resultJson: JSON.stringify({ success: false, outcome: 'aborted', summary: 'Task aborted' }) });
    const result = await weaverBotReport(true, undefined, undefined, abortCtx);
    const report = JSON.parse(result.reportJson);
    expect(report.path).toBe('abort');
    expect(result.summary).toContain('aborted');
  });

  it('read path takes priority over main and abort', async () => {
    const readCtx = makeWeaverCtx({ resultJson: JSON.stringify({ success: true, outcome: 'read' }) });
    const mainCtx = makeWeaverCtx({ resultJson: JSON.stringify({ success: true, outcome: 'completed' }) });
    const abortCtx = makeWeaverCtx({ resultJson: JSON.stringify({ success: false, outcome: 'aborted' }) });
    const result = await weaverBotReport(true, mainCtx, readCtx, abortCtx);
    const report = JSON.parse(result.reportJson);
    expect(report.path).toBe('read');
  });

  it('includes file count and git info in summary', async () => {
    const mainCtx = makeWeaverCtx({
      resultJson: JSON.stringify({ success: true, outcome: 'completed' }),
      filesModified: JSON.stringify(['a.ts', 'b.ts']),
      gitResultJson: JSON.stringify({ skipped: false, results: ['Committed'] }),
    });
    const result = await weaverBotReport(true, mainCtx);
    expect(result.summary).toContain('2 modified');
    expect(result.summary).toContain('Git: committed');
  });

  it('handles no inputs gracefully', async () => {
    const result = await weaverBotReport(true);
    const report = JSON.parse(result.reportJson);
    expect(report.path).toBe('unknown');
  });
});

// --- Tier 2: Git operations (temp git repo) ---

describe('weaverGitOps', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-gitops-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function initGitRepo() {
    const { execFileSync } = require('node:child_process');
    execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir, stdio: 'pipe' });
    // Initial commit so HEAD exists
    fs.writeFileSync(path.join(tmpDir, '.gitkeep'), '');
    execFileSync('git', ['add', '.gitkeep'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir, stdio: 'pipe' });
  }

  function makeGitCtx(envOverrides: Partial<WeaverEnv> = {}, ctxOverrides: Partial<WeaverContext> = {}): string {
    return JSON.stringify({
      env: makeEnv({ projectDir: tmpDir, ...envOverrides }),
      ...ctxOverrides,
    });
  }

  it('skips when git disabled', () => {
    const ctx = makeGitCtx({ config: { provider: 'auto', git: { enabled: false } } as any }, { filesModified: JSON.stringify(['some-file.ts']) });
    const result = weaverGitOps(ctx);
    const parsed = JSON.parse(result.ctx) as WeaverContext;
    const gitResult = JSON.parse(parsed.gitResultJson!);
    expect(gitResult.skipped).toBe(true);
    expect(gitResult.reason).toBe('git disabled');
  });

  it('skips when no files', () => {
    const ctx = makeGitCtx({}, { filesModified: '[]' });
    const result = weaverGitOps(ctx);
    const parsed = JSON.parse(result.ctx) as WeaverContext;
    const gitResult = JSON.parse(parsed.gitResultJson!);
    expect(gitResult.skipped).toBe(true);
    expect(gitResult.reason).toBe('no files');
  });

  it('skips when not a git repo', () => {
    const ctx = makeGitCtx({}, { filesModified: JSON.stringify(['file.ts']) });
    const result = weaverGitOps(ctx);
    const parsed = JSON.parse(result.ctx) as WeaverContext;
    const gitResult = JSON.parse(parsed.gitResultJson!);
    expect(gitResult.skipped).toBe(true);
    expect(gitResult.reason).toBe('not a git repo');
  });

  it('stages and commits files with default prefix', () => {
    initGitRepo();
    const testFile = path.join(tmpDir, 'workflow.ts');
    fs.writeFileSync(testFile, 'export default {};');

    const ctx = makeGitCtx({}, { filesModified: JSON.stringify([testFile]) });
    const result = weaverGitOps(ctx);
    const parsed = JSON.parse(result.ctx) as WeaverContext;
    const gitResult = JSON.parse(parsed.gitResultJson!);
    expect(gitResult.skipped).toBe(false);
    expect(gitResult.results.some((r: string) => r.includes('weaver:'))).toBe(true);
  });

  it('uses custom commit prefix', () => {
    initGitRepo();
    const testFile = path.join(tmpDir, 'workflow.ts');
    fs.writeFileSync(testFile, 'export default {};');

    const ctx = makeGitCtx(
      { config: { provider: 'auto', git: { commitPrefix: 'custom:' } } as any },
      { filesModified: JSON.stringify([testFile]) },
    );
    const result = weaverGitOps(ctx);
    const parsed = JSON.parse(result.ctx) as WeaverContext;
    const gitResult = JSON.parse(parsed.gitResultJson!);
    expect(gitResult.results.some((r: string) => r.includes('custom:'))).toBe(true);
  });

  it('creates branch when specified', () => {
    initGitRepo();
    const testFile = path.join(tmpDir, 'workflow.ts');
    fs.writeFileSync(testFile, 'export default {};');

    const branchName = `test-branch-${Date.now()}`;
    const ctx = makeGitCtx(
      { config: { provider: 'auto', git: { branch: branchName } } as any },
      { filesModified: JSON.stringify([testFile]) },
    );
    const result = weaverGitOps(ctx);
    const parsed = JSON.parse(result.ctx) as WeaverContext;
    const gitResult = JSON.parse(parsed.gitResultJson!);
    expect(gitResult.results.some((r: string) => r.includes(branchName))).toBe(true);
  });
});

// --- Tier 5: Shared modules ---

describe('parseJsonResponse', () => {
  it('parses clean JSON', () => {
    const result = parseJsonResponse('{"key": "value"}');
    expect(result).toEqual({ key: 'value' });
  });

  it('parses markdown-fenced JSON', () => {
    const result = parseJsonResponse('```json\n{"key": "value"}\n```');
    expect(result).toEqual({ key: 'value' });
  });

  it('parses JSON fenced without language tag', () => {
    const result = parseJsonResponse('```\n{"key": "value"}\n```');
    expect(result).toEqual({ key: 'value' });
  });

  it('extracts JSON embedded in text', () => {
    const result = parseJsonResponse('Here is the result: {"key": "value"} and some trailing text');
    expect(result).toEqual({ key: 'value' });
  });

  it('throws on invalid JSON', () => {
    expect(() => parseJsonResponse('not json at all')).toThrow('Failed to parse AI response as JSON');
  });

  it('handles whitespace around JSON', () => {
    const result = parseJsonResponse('  \n  {"key": "value"}  \n  ');
    expect(result).toEqual({ key: 'value' });
  });
});

// --- Genesis node tests (pure functions) ---

describe('genesisCheckStabilize', () => {
  let genesisCheckStabilize: typeof import('../src/node-types/genesis-check-stabilize.js').genesisCheckStabilize;
  let GenesisStore: typeof import('../src/bot/genesis-store.js').GenesisStore;
  let tmpDir: string;

  beforeAll(async () => {
    const mod = await import('../src/node-types/genesis-check-stabilize.js');
    genesisCheckStabilize = mod.genesisCheckStabilize;
    const storeMod = await import('../src/bot/genesis-store.js');
    GenesisStore = storeMod.GenesisStore;
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-genesis-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      env: makeEnv({ projectDir: tmpDir }),
      genesisConfigJson: JSON.stringify({ stabilize: false, intent: '', focus: [], constraints: [], approvalThreshold: 'MINOR', budgetPerCycle: 3, targetWorkflow: '', maxCyclesPerRun: 10 }),
      cycleId: 'test-cycle',
      ...overrides,
    });
  }

  it('returns stabilized=true when config flag is set', () => {
    const ctx = makeCtx({ genesisConfigJson: JSON.stringify({ stabilize: true, intent: '', focus: [], constraints: [], approvalThreshold: 'MINOR', budgetPerCycle: 3, targetWorkflow: '', maxCyclesPerRun: 10 }) });
    const result = genesisCheckStabilize(ctx);
    const parsed = JSON.parse(result.ctx);
    expect(parsed.stabilized).toBe(true);
  });

  it('returns stabilized=false when config flag is off and no history', () => {
    const result = genesisCheckStabilize(makeCtx());
    const parsed = JSON.parse(result.ctx);
    expect(parsed.stabilized).toBe(false);
  });

  it('returns stabilized=true after 3 consecutive rollbacks', () => {
    const store = new GenesisStore(tmpDir);

    for (let i = 0; i < 3; i++) {
      store.appendCycle({
        id: `cycle-${i}`, timestamp: new Date().toISOString(), durationMs: 100,
        fingerprint: { timestamp: '', files: {}, packageJson: null, gitBranch: null, gitCommit: null, workflowHash: '', existingWorkflows: [] },
        proposal: null, outcome: 'rolled-back', diffSummary: null,
        approvalRequired: false, approved: null, error: null, snapshotFile: null,
      });
    }

    const result = genesisCheckStabilize(makeCtx());
    const parsed = JSON.parse(result.ctx);
    expect(parsed.stabilized).toBe(true);
  });

  it('preserves context fields through', () => {
    const result = genesisCheckStabilize(makeCtx());
    const parsed = JSON.parse(result.ctx);
    expect(parsed.env.projectDir).toBe(tmpDir);
    expect(parsed.genesisConfigJson).toBeTruthy();
  });
});

describe('genesisValidateProposal', () => {
  let genesisValidateProposal: typeof import('../src/node-types/genesis-validate-proposal.js').genesisValidateProposal;

  beforeAll(async () => {
    const mod = await import('../src/node-types/genesis-validate-proposal.js');
    genesisValidateProposal = mod.genesisValidateProposal;
  });

  const env = makeEnv();
  const baseConfig = { stabilize: false, intent: '', focus: [], constraints: [], approvalThreshold: 'MINOR', budgetPerCycle: 3, targetWorkflow: 'test.ts', maxCyclesPerRun: 10 };

  function makeCtx(proposal: Record<string, unknown>, stabilized = false) {
    return JSON.stringify({
      env,
      genesisConfigJson: JSON.stringify(baseConfig),
      cycleId: 'test',
      proposalJson: JSON.stringify(proposal),
      stabilized,
    });
  }

  it('recalculates cost units from the cost map', () => {
    const proposal = {
      operations: [
        { type: 'addNode', args: {}, costUnits: 999, rationale: '' },
        { type: 'implementNode', args: {}, costUnits: 0, rationale: '' },
      ],
      totalCost: 999, impactLevel: 'MINOR', summary: 'test', rationale: '',
    };
    const result = genesisValidateProposal(makeCtx(proposal));
    const parsed = JSON.parse(JSON.parse(result.ctx).proposalJson);
    expect(parsed.operations[0].costUnits).toBe(1); // addNode = 1
    expect(parsed.operations[1].costUnits).toBe(2); // implementNode = 2
    expect(parsed.totalCost).toBe(3);
  });

  it('trims operations that exceed budget', () => {
    const proposal = {
      operations: [
        { type: 'addNode', args: {}, costUnits: 1, rationale: 'first' },
        { type: 'addNode', args: {}, costUnits: 1, rationale: 'second' },
        { type: 'implementNode', args: {}, costUnits: 2, rationale: 'third' },
        { type: 'addNode', args: {}, costUnits: 1, rationale: 'fourth' },
      ],
      totalCost: 5, impactLevel: 'MINOR', summary: 'test', rationale: '',
    };
    const result = genesisValidateProposal(makeCtx(proposal));
    const parsed = JSON.parse(JSON.parse(result.ctx).proposalJson);
    expect(parsed.totalCost).toBeLessThanOrEqual(3);
  });

  it('filters addNode and addConnection in stabilize mode', () => {
    const proposal = {
      operations: [
        { type: 'addNode', args: {}, costUnits: 1, rationale: '' },
        { type: 'removeNode', args: {}, costUnits: 1, rationale: '' },
        { type: 'addConnection', args: {}, costUnits: 1, rationale: '' },
        { type: 'implementNode', args: {}, costUnits: 2, rationale: '' },
      ],
      totalCost: 5, impactLevel: 'MINOR', summary: 'test', rationale: '',
    };
    const result = genesisValidateProposal(makeCtx(proposal, true));
    const parsed = JSON.parse(JSON.parse(result.ctx).proposalJson);
    const types = parsed.operations.map((op: { type: string }) => op.type);
    expect(types).not.toContain('addNode');
    expect(types).not.toContain('addConnection');
    expect(types).toContain('removeNode');
    expect(types).toContain('implementNode');
  });
});

describe('genesisCheckThreshold', () => {
  let genesisCheckThreshold: typeof import('../src/node-types/genesis-check-threshold.js').genesisCheckThreshold;

  beforeAll(async () => {
    const mod = await import('../src/node-types/genesis-check-threshold.js');
    genesisCheckThreshold = mod.genesisCheckThreshold;
  });

  const env = makeEnv();

  function makeCtx(config: Record<string, unknown>, proposal: Record<string, unknown>) {
    return JSON.stringify({
      env,
      genesisConfigJson: JSON.stringify(config),
      cycleId: 'test',
      proposalJson: JSON.stringify(proposal),
    });
  }

  it('requires approval when impact >= threshold', () => {
    const result = genesisCheckThreshold(makeCtx({ approvalThreshold: 'MINOR' }, { impactLevel: 'BREAKING', operations: [], totalCost: 0, summary: '', rationale: '' }));
    expect(JSON.parse(result.ctx).approvalRequired).toBe(true);
  });

  it('requires approval when impact equals threshold', () => {
    const result = genesisCheckThreshold(makeCtx({ approvalThreshold: 'MINOR' }, { impactLevel: 'MINOR', operations: [], totalCost: 0, summary: '', rationale: '' }));
    expect(JSON.parse(result.ctx).approvalRequired).toBe(true);
  });

  it('does not require approval when impact < threshold', () => {
    const result = genesisCheckThreshold(makeCtx({ approvalThreshold: 'BREAKING' }, { impactLevel: 'MINOR', operations: [], totalCost: 0, summary: '', rationale: '' }));
    expect(JSON.parse(result.ctx).approvalRequired).toBe(false);
  });

  it('COSMETIC impact below any threshold except COSMETIC', () => {
    const result = genesisCheckThreshold(makeCtx({ approvalThreshold: 'MINOR' }, { impactLevel: 'COSMETIC', operations: [], totalCost: 0, summary: '', rationale: '' }));
    expect(JSON.parse(result.ctx).approvalRequired).toBe(false);
  });
});

describe('genesisReport', () => {
  let genesisReport: typeof import('../src/node-types/genesis-report.js').genesisReport;

  beforeAll(async () => {
    const mod = await import('../src/node-types/genesis-report.js');
    genesisReport = mod.genesisReport;
  });

  const env = makeEnv();

  function makeCtx(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      env,
      genesisConfigJson: '{}',
      cycleId: 'test',
      ...overrides,
    });
  }

  it('reports from error path (failCtx)', () => {
    const result = genesisReport(undefined, makeCtx({ error: 'something broke' }));
    expect(result.summary).toContain('something broke');
  });

  it('reports from error path with apply result', () => {
    const applyResult = JSON.stringify({ applied: 2, failed: 1, errors: ['addNode: fail'] });
    const result = genesisReport(undefined, makeCtx({ error: 'compile failed', applyResultJson: applyResult }));
    expect(result.summary).toContain('compile failed');
    expect(result.summary).toContain('applied: 2');
    expect(result.summary).toContain('failed: 1');
  });

  it('reports from success path (successCtx) with cycle record', () => {
    const record = {
      id: 'cycle-1', timestamp: new Date().toISOString(), durationMs: 500,
      fingerprint: { timestamp: '', files: {}, packageJson: null, gitBranch: null, gitCommit: null, workflowHash: '', existingWorkflows: [] },
      proposal: { operations: [{ type: 'addNode' }], totalCost: 1, impactLevel: 'MINOR', summary: 'test', rationale: '' },
      outcome: 'applied', diffSummary: 'test', approvalRequired: true, approved: true, error: null, snapshotFile: null,
    };
    const result = genesisReport(makeCtx({ cycleRecordJson: JSON.stringify(record) }));
    expect(result.summary).toContain('cycle-1');
    expect(result.summary).toContain('applied');
  });

  it('handles no inputs', () => {
    const result = genesisReport();
    expect(result.summary).toContain('no record');
  });
});

describe('genesisTryApply', () => {
  let genesisTryApply: typeof import('../src/node-types/genesis-try-apply.js').genesisTryApply;

  beforeAll(async () => {
    const mod = await import('../src/node-types/genesis-try-apply.js');
    genesisTryApply = mod.genesisTryApply;
  });

  it('returns success on dry run (execute=false)', async () => {
    const ctx = JSON.stringify({ env: makeEnv(), genesisConfigJson: '{}', cycleId: 'test', proposalJson: '{}', snapshotPath: '/tmp/snap' });
    const result = await genesisTryApply(false, ctx);
    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);
    const parsed = JSON.parse(result.ctx);
    expect(parsed.error).toBe('');
  });
});

describe('genesisApplyRetry', () => {
  let genesisApplyRetry: typeof import('../src/node-types/genesis-apply-retry.js').genesisApplyRetry;

  beforeAll(async () => {
    const mod = await import('../src/node-types/genesis-apply-retry.js');
    genesisApplyRetry = mod.genesisApplyRetry;
  });

  it('returns success on dry run (execute=false)', async () => {
    const ctx = JSON.stringify({ env: makeEnv(), genesisConfigJson: '{}', cycleId: 'test', proposalJson: '{}', snapshotPath: '/tmp/snap' });
    const noop = () => ({ success: true, failure: false, attemptCtx: ctx });
    const result = await genesisApplyRetry(false, ctx, noop);
    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);
    const parsed = JSON.parse(result.ctx);
    expect(parsed.error).toBe('');
  });
});
