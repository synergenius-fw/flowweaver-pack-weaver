import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { WeaverEnv } from '../src/bot/types.js';
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

// --- Tier 1: Pure functions (no mocking) ---

describe('weaverRouteTask', () => {
  const env = makeEnv();

  it('routes create mode through success path', () => {
    const task = { instruction: 'build something', mode: 'create' };
    const result = weaverRouteTask(env, JSON.stringify(task));
    expect(result.env).toBe(env);
    expect(result.taskJson).toBe(JSON.stringify(task));
  });

  it('routes modify mode through success path', () => {
    const task = { instruction: 'fix something', mode: 'modify' };
    const result = weaverRouteTask(env, JSON.stringify(task));
    expect(result.taskJson).toBe(JSON.stringify(task));
  });

  it('routes batch mode through success path', () => {
    const task = { instruction: 'batch ops', mode: 'batch' };
    const result = weaverRouteTask(env, JSON.stringify(task));
    expect(result.taskJson).toBe(JSON.stringify(task));
  });

  it('throws for read mode (fail path)', () => {
    const task = { instruction: 'describe workflow', mode: 'read' };
    expect(() => weaverRouteTask(env, JSON.stringify(task))).toThrow('read-only-route');
  });

  it('defaults to create mode when mode is not specified', () => {
    const task = { instruction: 'no mode set' };
    const result = weaverRouteTask(env, JSON.stringify(task));
    expect(result.taskJson).toBe(JSON.stringify(task));
  });
});

describe('weaverAbortTask', () => {
  const env = makeEnv();

  it('returns result with success=false and outcome=aborted', () => {
    const task = { instruction: 'do something' };
    const result = weaverAbortTask(env, JSON.stringify(task), 'user rejected');
    const parsed = JSON.parse(result.resultJson);

    expect(parsed.success).toBe(false);
    expect(parsed.outcome).toBe('aborted');
    expect(parsed.summary).toContain('user rejected');
    expect(parsed.instruction).toBe('do something');
    expect(parsed.filesModified).toEqual([]);
    expect(parsed.filesCreated).toEqual([]);
  });

  it('passes env through', () => {
    const result = weaverAbortTask(env, '{}', 'reason');
    expect(result.env).toBe(env);
  });

  it('returns empty filesModified array', () => {
    const result = weaverAbortTask(env, '{}', 'reason');
    expect(result.filesModified).toBe('[]');
  });
});

describe('weaverBotReport', () => {
  it('reports from read path', () => {
    const readResult = JSON.stringify({ success: true, outcome: 'read', summary: 'Workflow has 5 nodes' });
    const result = weaverBotReport(readResult);
    const report = JSON.parse(result.reportJson);
    expect(report.path).toBe('read');
    expect(result.summary).toContain('read');
  });

  it('reports from main path', () => {
    const mainResult = JSON.stringify({ success: true, outcome: 'completed', summary: 'Created workflow' });
    const result = weaverBotReport(undefined, mainResult);
    const report = JSON.parse(result.reportJson);
    expect(report.path).toBe('main');
    expect(result.summary).toContain('completed');
  });

  it('reports from abort path', () => {
    const abortResult = JSON.stringify({ success: false, outcome: 'aborted', summary: 'Task aborted' });
    const result = weaverBotReport(undefined, undefined, abortResult);
    const report = JSON.parse(result.reportJson);
    expect(report.path).toBe('abort');
    expect(result.summary).toContain('aborted');
  });

  it('read path takes priority over main and abort', () => {
    const readResult = JSON.stringify({ success: true, outcome: 'read' });
    const mainResult = JSON.stringify({ success: true, outcome: 'completed' });
    const abortResult = JSON.stringify({ success: false, outcome: 'aborted' });
    const result = weaverBotReport(readResult, mainResult, abortResult);
    const report = JSON.parse(result.reportJson);
    expect(report.path).toBe('read');
  });

  it('includes file count and git info in summary', () => {
    const mainResult = JSON.stringify({ success: true, outcome: 'completed' });
    const files = JSON.stringify(['a.ts', 'b.ts']);
    const git = JSON.stringify({ skipped: false, results: ['Committed'] });
    const result = weaverBotReport(undefined, mainResult, undefined, '{}', files, git);
    expect(result.summary).toContain('2 modified');
    expect(result.summary).toContain('Git: committed');
  });

  it('handles no inputs gracefully', () => {
    const result = weaverBotReport();
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

  it('skips when git disabled', () => {
    const env = makeEnv({ projectDir: tmpDir, config: { provider: 'auto', git: { enabled: false } } as any });
    const result = weaverGitOps(env, JSON.stringify(['some-file.ts']));
    const parsed = JSON.parse(result.gitResultJson);
    expect(parsed.skipped).toBe(true);
    expect(parsed.reason).toBe('git disabled');
  });

  it('skips when no files', () => {
    const env = makeEnv({ projectDir: tmpDir });
    const result = weaverGitOps(env, '[]');
    const parsed = JSON.parse(result.gitResultJson);
    expect(parsed.skipped).toBe(true);
    expect(parsed.reason).toBe('no files');
  });

  it('skips when not a git repo', () => {
    const env = makeEnv({ projectDir: tmpDir });
    const result = weaverGitOps(env, JSON.stringify(['file.ts']));
    const parsed = JSON.parse(result.gitResultJson);
    expect(parsed.skipped).toBe(true);
    expect(parsed.reason).toBe('not a git repo');
  });

  it('stages and commits files with default prefix', () => {
    initGitRepo();
    const testFile = path.join(tmpDir, 'workflow.ts');
    fs.writeFileSync(testFile, 'export default {};');

    const env = makeEnv({ projectDir: tmpDir });
    const result = weaverGitOps(env, JSON.stringify([testFile]));
    const parsed = JSON.parse(result.gitResultJson);
    expect(parsed.skipped).toBe(false);
    expect(parsed.results.some((r: string) => r.includes('weaver:'))).toBe(true);
  });

  it('uses custom commit prefix', () => {
    initGitRepo();
    const testFile = path.join(tmpDir, 'workflow.ts');
    fs.writeFileSync(testFile, 'export default {};');

    const env = makeEnv({
      projectDir: tmpDir,
      config: { provider: 'auto', git: { commitPrefix: 'custom:' } } as any,
    });
    const result = weaverGitOps(env, JSON.stringify([testFile]));
    const parsed = JSON.parse(result.gitResultJson);
    expect(parsed.results.some((r: string) => r.includes('custom:'))).toBe(true);
  });

  it('creates branch when specified', () => {
    initGitRepo();
    const testFile = path.join(tmpDir, 'workflow.ts');
    fs.writeFileSync(testFile, 'export default {};');

    const branchName = `test-branch-${Date.now()}`;
    const env = makeEnv({
      projectDir: tmpDir,
      config: { provider: 'auto', git: { branch: branchName } } as any,
    });
    const result = weaverGitOps(env, JSON.stringify([testFile]));
    const parsed = JSON.parse(result.gitResultJson);
    expect(parsed.results.some((r: string) => r.includes(branchName))).toBe(true);
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

  it('returns stabilized=true when config flag is set', () => {
    const env = makeEnv({ projectDir: tmpDir });
    const config = { stabilize: true, intent: '', focus: [], constraints: [], approvalThreshold: 'MINOR', budgetPerCycle: 3, targetWorkflow: '', maxCyclesPerRun: 10 };
    const result = genesisCheckStabilize(env, JSON.stringify(config));
    expect(result.stabilized).toBe(true);
  });

  it('returns stabilized=false when config flag is off and no history', () => {
    const env = makeEnv({ projectDir: tmpDir });
    const config = { stabilize: false, intent: '', focus: [], constraints: [], approvalThreshold: 'MINOR', budgetPerCycle: 3, targetWorkflow: '', maxCyclesPerRun: 10 };
    const result = genesisCheckStabilize(env, JSON.stringify(config));
    expect(result.stabilized).toBe(false);
  });

  it('returns stabilized=true after 3 consecutive rollbacks', () => {
    const env = makeEnv({ projectDir: tmpDir });
    const store = new GenesisStore(tmpDir);

    for (let i = 0; i < 3; i++) {
      store.appendCycle({
        id: `cycle-${i}`, timestamp: new Date().toISOString(), durationMs: 100,
        fingerprint: { timestamp: '', files: {}, packageJson: null, gitBranch: null, gitCommit: null, workflowHash: '', existingWorkflows: [] },
        proposal: null, outcome: 'rolled-back', diffSummary: null,
        approvalRequired: false, approved: null, error: null, snapshotFile: null,
      });
    }

    const config = { stabilize: false, intent: '', focus: [], constraints: [], approvalThreshold: 'MINOR', budgetPerCycle: 3, targetWorkflow: '', maxCyclesPerRun: 10 };
    const result = genesisCheckStabilize(env, JSON.stringify(config));
    expect(result.stabilized).toBe(true);
  });

  it('passes env and config through', () => {
    const env = makeEnv({ projectDir: tmpDir });
    const configStr = JSON.stringify({ stabilize: false, intent: '', focus: [], constraints: [], approvalThreshold: 'MINOR', budgetPerCycle: 3, targetWorkflow: '', maxCyclesPerRun: 10 });
    const result = genesisCheckStabilize(env, configStr);
    expect(result.env).toBe(env);
    expect(result.genesisConfigJson).toBe(configStr);
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

  it('recalculates cost units from the cost map', () => {
    const proposal = {
      operations: [
        { type: 'addNode', args: {}, costUnits: 999, rationale: '' },
        { type: 'implementNode', args: {}, costUnits: 0, rationale: '' },
      ],
      totalCost: 999, impactLevel: 'MINOR', summary: 'test', rationale: '',
    };
    const result = genesisValidateProposal(env, JSON.stringify(baseConfig), JSON.stringify(proposal), false);
    const parsed = JSON.parse(result.proposalJson);
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
    // Budget is 3. addNode(1) + addNode(1) + implementNode(2) = 4 > 3
    const result = genesisValidateProposal(env, JSON.stringify(baseConfig), JSON.stringify(proposal), false);
    const parsed = JSON.parse(result.proposalJson);
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
    const result = genesisValidateProposal(env, JSON.stringify(baseConfig), JSON.stringify(proposal), true);
    const parsed = JSON.parse(result.proposalJson);
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

  it('requires approval when impact >= threshold', () => {
    const config = { approvalThreshold: 'MINOR' };
    const proposal = { impactLevel: 'BREAKING', operations: [], totalCost: 0, summary: '', rationale: '' };
    const result = genesisCheckThreshold(env, JSON.stringify(config), JSON.stringify(proposal));
    expect(result.approvalRequired).toBe(true);
  });

  it('requires approval when impact equals threshold', () => {
    const config = { approvalThreshold: 'MINOR' };
    const proposal = { impactLevel: 'MINOR', operations: [], totalCost: 0, summary: '', rationale: '' };
    const result = genesisCheckThreshold(env, JSON.stringify(config), JSON.stringify(proposal));
    expect(result.approvalRequired).toBe(true);
  });

  it('does not require approval when impact < threshold', () => {
    const config = { approvalThreshold: 'BREAKING' };
    const proposal = { impactLevel: 'MINOR', operations: [], totalCost: 0, summary: '', rationale: '' };
    const result = genesisCheckThreshold(env, JSON.stringify(config), JSON.stringify(proposal));
    expect(result.approvalRequired).toBe(false);
  });

  it('COSMETIC impact below any threshold except COSMETIC', () => {
    const config = { approvalThreshold: 'MINOR' };
    const proposal = { impactLevel: 'COSMETIC', operations: [], totalCost: 0, summary: '', rationale: '' };
    const result = genesisCheckThreshold(env, JSON.stringify(config), JSON.stringify(proposal));
    expect(result.approvalRequired).toBe(false);
  });
});

describe('genesisReport', () => {
  let genesisReport: typeof import('../src/node-types/genesis-report.js').genesisReport;

  beforeAll(async () => {
    const mod = await import('../src/node-types/genesis-report.js');
    genesisReport = mod.genesisReport;
  });

  const env = makeEnv();

  it('reports from error path', () => {
    const result = genesisReport(env, undefined, 'something broke');
    expect(result.summary).toContain('something broke');
  });

  it('reports from success path with cycle record', () => {
    const record = {
      id: 'cycle-1', timestamp: new Date().toISOString(), durationMs: 500,
      fingerprint: { timestamp: '', files: {}, packageJson: null, gitBranch: null, gitCommit: null, workflowHash: '', existingWorkflows: [] },
      proposal: { operations: [{ type: 'addNode' }], totalCost: 1, impactLevel: 'MINOR', summary: 'test', rationale: '' },
      outcome: 'applied', diffSummary: 'test', approvalRequired: true, approved: true, error: null, snapshotFile: null,
    };
    const result = genesisReport(env, JSON.stringify(record));
    expect(result.summary).toContain('cycle-1');
    expect(result.summary).toContain('applied');
  });

  it('handles no inputs', () => {
    const result = genesisReport(env);
    expect(result.summary).toContain('no record');
  });

  it('passes env through', () => {
    const result = genesisReport(env);
    expect(result.env).toBe(env);
  });
});
