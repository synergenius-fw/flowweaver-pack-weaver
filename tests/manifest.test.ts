import * as fs from 'node:fs';
import * as path from 'node:path';

describe('flowweaver.manifest.json', () => {
  const manifestPath = path.join(__dirname, '..', 'flowweaver.manifest.json');
  let manifest: Record<string, unknown>;

  beforeAll(() => {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  });

  it('is valid JSON with required fields', () => {
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.name).toBe('@synergenius/flowweaver-pack-weaver');
    expect(typeof manifest.version).toBe('string');
  });

  it('declares 6 node types', () => {
    const nodeTypes = manifest.nodeTypes as Array<Record<string, unknown>>;
    expect(nodeTypes).toHaveLength(6);

    const names = nodeTypes.map((n) => n.name);
    expect(names).toContain('weaverLoadConfig');
    expect(names).toContain('weaverDetectProvider');
    expect(names).toContain('weaverResolveTarget');
    expect(names).toContain('weaverExecuteTarget');
    expect(names).toContain('weaverSendNotify');
    expect(names).toContain('weaverReport');
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

  it('declares executeTarget as async', () => {
    const nodeTypes = manifest.nodeTypes as Array<Record<string, unknown>>;
    const exec = nodeTypes.find((n) => n.name === 'weaverExecuteTarget');
    expect(exec?.isAsync).toBe(true);
  });

  it('declares other node types as sync', () => {
    const nodeTypes = manifest.nodeTypes as Array<Record<string, unknown>>;
    const syncNodes = nodeTypes.filter((n) => n.name !== 'weaverExecuteTarget');
    for (const nt of syncNodes) {
      expect(nt.isAsync).toBe(false);
    }
  });

  it('declares CLI extension', () => {
    expect(manifest.cliEntrypoint).toBe('dist/cli-bridge.js');
    const cliCommands = manifest.cliCommands as Array<Record<string, unknown>>;
    expect(cliCommands.length).toBeGreaterThanOrEqual(9);

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
  });

  it('declares MCP extension', () => {
    expect(manifest.mcpEntrypoint).toBe('dist/mcp-tools.js');
    const mcpTools = manifest.mcpTools as Array<Record<string, unknown>>;
    expect(mcpTools).toHaveLength(4);

    const names = mcpTools.map((t) => t.name);
    expect(names).toContain('fw_weaver_run');
    expect(names).toContain('fw_weaver_history');
    expect(names).toContain('fw_weaver_costs');
    expect(names).toContain('fw_weaver_providers');
  });

  it('declares init contributions', () => {
    const init = manifest.initContributions as Record<string, unknown>;
    expect(init).toBeDefined();
    const useCase = init.useCase as Record<string, unknown>;
    expect(useCase.id).toBe('ai-runner');
  });
});
