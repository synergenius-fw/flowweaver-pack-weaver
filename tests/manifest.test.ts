import * as fs from 'node:fs';
import * as path from 'node:path';

describe('flowweaver.manifest.json', () => {
  const manifestPath = path.join(__dirname, '..', 'flowweaver.manifest.json');
  let manifest: Record<string, unknown>;

  beforeAll(() => {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  });

  it('is valid JSON with required fields', () => {
    expect(manifest.manifestVersion).toBe(2);
    expect(manifest.name).toBe('@synergenius/flow-weaver-pack-weaver');
    expect(typeof manifest.version).toBe('string');
  });

  it('declares all node types', () => {
    const nodeTypes = manifest.nodeTypes as Array<Record<string, unknown>>;
    expect(nodeTypes).toHaveLength(36);

    const names = nodeTypes.map((n) => n.name);
    // Original 6
    expect(names).toContain('weaverLoadConfig');
    expect(names).toContain('weaverDetectProvider');
    expect(names).toContain('weaverResolveTarget');
    expect(names).toContain('weaverExecuteTarget');
    expect(names).toContain('weaverSendNotify');
    expect(names).toContain('weaverReport');
    // Bot node types (13)
    expect(names).toContain('weaverReceiveTask');
    expect(names).toContain('weaverRouteTask');
    expect(names).toContain('weaverReadWorkflow');
    expect(names).toContain('weaverBuildContext');
    expect(names).toContain('weaverPlanTask');
    expect(names).toContain('weaverApprovalGate');
    expect(names).toContain('weaverAbortTask');
    expect(names).toContain('weaverExecValidateRetry');
    expect(names).toContain('weaverExecutePlan');
    expect(names).toContain('weaverValidateResult');
    expect(names).toContain('weaverFixErrors');
    expect(names).toContain('weaverGitOps');
    expect(names).toContain('weaverBotReport');
    // Genesis node types (17)
    expect(names).toContain('genesisLoadConfig');
    expect(names).toContain('genesisObserve');
    expect(names).toContain('genesisDiffFingerprint');
    expect(names).toContain('genesisCheckStabilize');
    expect(names).toContain('genesisPropose');
    expect(names).toContain('genesisValidateProposal');
    expect(names).toContain('genesisSnapshot');
    expect(names).toContain('genesisApply');
    expect(names).toContain('genesisCompileValidate');
    expect(names).toContain('genesisTryApply');
    expect(names).toContain('genesisApplyRetry');
    expect(names).toContain('genesisDiffWorkflow');
    expect(names).toContain('genesisCheckThreshold');
    expect(names).toContain('genesisApprove');
    expect(names).toContain('genesisCommit');
    expect(names).toContain('genesisUpdateHistory');
    expect(names).toContain('genesisReport');
  });

  it('each node type has required fields', () => {
    const nodeTypes = manifest.nodeTypes as Array<Record<string, unknown>>;
    for (const nt of nodeTypes) {
      expect(typeof nt.name).toBe('string');
      expect(typeof nt.description).toBe('string');
      expect(typeof nt.file).toBe('string');
      expect(typeof nt.functionName).toBe('string');
      expect(typeof nt.isAsync).toBe('boolean');
      expect(typeof nt.inputs).toBe('object');
      expect(typeof nt.outputs).toBe('object');
    }
  });

  it('declares async node types correctly', () => {
    const nodeTypes = manifest.nodeTypes as Array<Record<string, unknown>>;
    const expectedAsync = [
      'weaverExecuteTarget',
      'weaverReceiveTask',
      'weaverPlanTask',
      'weaverApprovalGate',
      'weaverExecValidateRetry',
      'weaverExecutePlan',
      'weaverFixErrors',
      'genesisObserve',
      'genesisPropose',
      'genesisApply',
      'genesisCompileValidate',
      'genesisTryApply',
      'genesisApplyRetry',
      'genesisApprove',
      'genesisCommit',
    ];
    for (const name of expectedAsync) {
      const nt = nodeTypes.find((n) => n.name === name);
      expect(nt?.isAsync, `${name} should be async`).toBe(true);
    }
  });

  it('declares sync node types correctly', () => {
    const nodeTypes = manifest.nodeTypes as Array<Record<string, unknown>>;
    const expectedSync = [
      'weaverLoadConfig',
      'weaverDetectProvider',
      'weaverResolveTarget',
      'weaverSendNotify',
      'weaverReport',
      'weaverRouteTask',
      'weaverReadWorkflow',
      'weaverBuildContext',
      'weaverAbortTask',
      'weaverValidateResult',
      'weaverGitOps',
      'weaverBotReport',
      'genesisLoadConfig',
      'genesisDiffFingerprint',
      'genesisCheckStabilize',
      'genesisValidateProposal',
      'genesisSnapshot',
      'genesisDiffWorkflow',
      'genesisCheckThreshold',
      'genesisUpdateHistory',
      'genesisReport',
    ];
    for (const name of expectedSync) {
      const nt = nodeTypes.find((n) => n.name === name);
      expect(nt?.isAsync, `${name} should be sync`).toBe(false);
    }
  });

  it('declares CLI extension', () => {
    expect(manifest.cliEntrypoint).toBe('dist/cli-bridge.js');
    const cliCommands = manifest.cliCommands as Array<Record<string, unknown>>;
    expect(cliCommands.length).toBeGreaterThanOrEqual(10);

    const names = cliCommands.map((c) => c.name);
    expect(names).toContain('run');
    expect(names).toContain('history');
    expect(names).toContain('costs');
    expect(names).toContain('providers');
    expect(names).toContain('watch');
    expect(names).toContain('cron');
    expect(names).toContain('pipeline');
    expect(names).toContain('dashboard');
    expect(names).toContain('eject');
    expect(names).toContain('genesis');
  });

  it('declares MCP extension', () => {
    expect(manifest.mcpEntrypoint).toBe('dist/mcp-tools.js');
    const mcpTools = manifest.mcpTools as Array<Record<string, unknown>>;
    expect(mcpTools).toHaveLength(9);

    const names = mcpTools.map((t) => t.name);
    // Original 4
    expect(names).toContain('fw_weaver_run');
    expect(names).toContain('fw_weaver_history');
    expect(names).toContain('fw_weaver_costs');
    expect(names).toContain('fw_weaver_providers');
    // Bot MCP tools (4)
    expect(names).toContain('fw_weaver_bot');
    expect(names).toContain('fw_weaver_steer');
    expect(names).toContain('fw_weaver_queue');
    expect(names).toContain('fw_weaver_status');
    // Genesis MCP tool
    expect(names).toContain('fw_weaver_genesis');
  });

  it('declares init contributions', () => {
    const init = manifest.initContributions as Record<string, unknown>;
    expect(init).toBeDefined();
    const useCase = init.useCase as Record<string, unknown>;
    expect(useCase.id).toBe('ai-runner');
  });
});
