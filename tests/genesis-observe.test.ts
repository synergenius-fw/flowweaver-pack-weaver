import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as child_process from 'node:child_process';
import type { GenesisContext } from '../src/bot/types.js';

// Mock execFileSync (git) but keep real fs
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFileSync: vi.fn() };
});

const mockGetWorkflowDescription = vi.hoisted(() => vi.fn().mockResolvedValue('workflow description'));
vi.mock('../src/bot/genesis-prompt-context.js', () => ({
  getWorkflowDescription: mockGetWorkflowDescription,
}));

const mockedExecFileSync = vi.mocked(child_process.execFileSync);

import { genesisObserve } from '../src/node-types/genesis-observe.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeCtx(projectDir: string, targetWorkflow: string): string {
  const ctx: GenesisContext = {
    env: {
      projectDir,
      config: { provider: 'auto' },
      providerType: 'anthropic',
      providerInfo: { type: 'anthropic' },
    },
    genesisConfigJson: JSON.stringify({
      intent: 'improve coverage',
      focus: [],
      constraints: [],
      approvalThreshold: 'MINOR',
      budgetPerCycle: 5,
      stabilize: false,
      targetWorkflow,
    }),
    cycleId: 'test-cycle-1',
  };
  return JSON.stringify(ctx);
}

describe('genesisObserve', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-observe-test-'));
    vi.resetAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGetWorkflowDescription.mockResolvedValue('workflow description');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('dry run (execute=false) returns empty fingerprint without reading filesystem', async () => {
    const ctxStr = makeCtx(tmpDir, 'workflow.ts');
    const result = await genesisObserve(false, ctxStr);

    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);

    const ctx = JSON.parse(result.ctx) as GenesisContext;
    const fp = JSON.parse(ctx.fingerprintJson!);

    expect(fp.files).toEqual({});
    expect(fp.packageJson).toBeNull();
    expect(fp.gitBranch).toBeNull();
    expect(fp.gitCommit).toBeNull();
    expect(fp.workflowHash).toBe('');
    expect(fp.existingWorkflows).toEqual([]);
    expect(fp.timestamp).toBeTruthy();

    // git should not be called on dry run
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('happy path: fingerprints .ts files and detects workflow files', async () => {
    // Set up tmp dir with .ts files
    fs.writeFileSync(path.join(tmpDir, 'foo.ts'), '// plain node type');
    fs.writeFileSync(path.join(tmpDir, 'workflow.ts'), '/** @flowWeaver workflow */\nexport function myWorkflow() {}');
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test-pkg', version: '1.0.0' }));

    // Mock git to return branch/commit
    mockedExecFileSync
      .mockReturnValueOnce('main\n' as any)    // git rev-parse --abbrev-ref HEAD
      .mockReturnValueOnce('abc123\n' as any); // git rev-parse HEAD

    const ctxStr = makeCtx(tmpDir, 'workflow.ts');
    const result = await genesisObserve(true, ctxStr);

    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);

    const ctx = JSON.parse(result.ctx) as GenesisContext;
    const fp = JSON.parse(ctx.fingerprintJson!);

    // Both .ts files should be hashed
    expect(Object.keys(fp.files)).toContain('foo.ts');
    expect(Object.keys(fp.files)).toContain('workflow.ts');
    // Hashes are non-empty hex strings
    expect(fp.files['workflow.ts']).toMatch(/^[0-9a-f]{64}$/);

    // Workflow detection
    expect(fp.existingWorkflows).toContain('workflow.ts');
    expect(fp.existingWorkflows).not.toContain('foo.ts');

    // Git info
    expect(fp.gitBranch).toBe('main');
    expect(fp.gitCommit).toBe('abc123');

    // Package.json
    expect(fp.packageJson).toEqual({ name: 'test-pkg', version: '1.0.0' });

    // workflowHash is a sha256 hex
    expect(fp.workflowHash).toMatch(/^[0-9a-f]{64}$/);

    // workflowDescription set via getWorkflowDescription
    expect(ctx.workflowDescription).toBe('workflow description');
    expect(mockGetWorkflowDescription).toHaveBeenCalledWith(path.resolve(tmpDir, 'workflow.ts'));
  });

  it('git unavailable falls back gracefully with null branch/commit', async () => {
    fs.writeFileSync(path.join(tmpDir, 'workflow.ts'), '/** @flowWeaver workflow */\nexport function myWorkflow() {}');

    // Mock git to throw
    mockedExecFileSync.mockImplementation(() => { throw new Error('git not found'); });

    const ctxStr = makeCtx(tmpDir, 'workflow.ts');
    const result = await genesisObserve(true, ctxStr);

    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);

    const ctx = JSON.parse(result.ctx) as GenesisContext;
    const fp = JSON.parse(ctx.fingerprintJson!);

    expect(fp.gitBranch).toBeNull();
    expect(fp.gitCommit).toBeNull();
    // Other fingerprint data still collected
    expect(fp.files['workflow.ts']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('WEAVER_VERBOSE logs git error when git is unavailable', async () => {
    const originalVerbose = process.env.WEAVER_VERBOSE;
    process.env.WEAVER_VERBOSE = '1';
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    fs.writeFileSync(path.join(tmpDir, 'workflow.ts'), '/** @flowWeaver workflow */\nexport function myWorkflow() {}');
    mockedExecFileSync.mockImplementation(() => { throw new Error('git not found'); });

    const ctxStr = makeCtx(tmpDir, 'workflow.ts');
    await genesisObserve(true, ctxStr);

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('[genesis-observe] git unavailable:'),
      expect.any(Error),
    );

    process.env.WEAVER_VERBOSE = originalVerbose;
  });

  it('missing src/ dir still scans root-level .ts files', async () => {
    // Only root-level .ts files, no src/ directory
    fs.writeFileSync(path.join(tmpDir, 'root-node.ts'), '// root level node type');
    fs.writeFileSync(path.join(tmpDir, 'workflow.ts'), '/** @flowWeaver workflow */\nexport function myWorkflow() {}');

    mockedExecFileSync
      .mockReturnValueOnce('main\n' as any)
      .mockReturnValueOnce('abc123\n' as any);

    const ctxStr = makeCtx(tmpDir, 'workflow.ts');
    const result = await genesisObserve(true, ctxStr);

    expect(result.onSuccess).toBe(true);
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    const fp = JSON.parse(ctx.fingerprintJson!);

    expect(Object.keys(fp.files)).toContain('root-node.ts');
    expect(Object.keys(fp.files)).toContain('workflow.ts');
  });

  it('workflowHash changes when target workflow content changes', async () => {
    const wfPath = path.join(tmpDir, 'workflow.ts');

    // First observation
    fs.writeFileSync(wfPath, '/** @flowWeaver workflow */\nexport function myWorkflow() { /* v1 */ }');
    mockedExecFileSync
      .mockReturnValueOnce('main\n' as any)
      .mockReturnValueOnce('abc123\n' as any);

    const r1 = await genesisObserve(true, makeCtx(tmpDir, 'workflow.ts'));
    const fp1 = JSON.parse(JSON.parse(r1.ctx).fingerprintJson);

    // Second observation with different content
    fs.writeFileSync(wfPath, '/** @flowWeaver workflow */\nexport function myWorkflow() { /* v2 — completely different */ }');
    mockedExecFileSync
      .mockReturnValueOnce('main\n' as any)
      .mockReturnValueOnce('abc123\n' as any);

    const r2 = await genesisObserve(true, makeCtx(tmpDir, 'workflow.ts'));
    const fp2 = JSON.parse(JSON.parse(r2.ctx).fingerprintJson);

    expect(fp1.workflowHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fp2.workflowHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fp1.workflowHash).not.toBe(fp2.workflowHash);
  });

  it('workflowHash is stable when target workflow content is unchanged', async () => {
    const wfPath = path.join(tmpDir, 'workflow.ts');
    const content = '/** @flowWeaver workflow */\nexport function myWorkflow() {}';
    fs.writeFileSync(wfPath, content);

    mockedExecFileSync
      .mockReturnValueOnce('main\n' as any)
      .mockReturnValueOnce('abc123\n' as any);
    const r1 = await genesisObserve(true, makeCtx(tmpDir, 'workflow.ts'));
    const fp1 = JSON.parse(JSON.parse(r1.ctx).fingerprintJson);

    mockedExecFileSync
      .mockReturnValueOnce('main\n' as any)
      .mockReturnValueOnce('abc123\n' as any);
    const r2 = await genesisObserve(true, makeCtx(tmpDir, 'workflow.ts'));
    const fp2 = JSON.parse(JSON.parse(r2.ctx).fingerprintJson);

    expect(fp1.workflowHash).toBe(fp2.workflowHash);
  });

  it('existingWorkflows lists .ts files in src/workflows that contain @flowWeaver workflow', async () => {
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir);

    // Two workflow files
    fs.writeFileSync(path.join(srcDir, 'pipeline.ts'), '/** @flowWeaver workflow */\nexport function pipeline() {}');
    fs.writeFileSync(path.join(srcDir, 'batch.ts'), '/** @flowWeaver workflow */\nexport function batch() {}');
    // A node type — should not be listed
    fs.writeFileSync(path.join(srcDir, 'validator.ts'), '/** @flowWeaver nodeType */\nexport function validate() {}');

    // Target is one of the workflows
    fs.writeFileSync(path.join(tmpDir, 'target.ts'), '/** @flowWeaver workflow */\nexport function target() {}');

    mockedExecFileSync
      .mockReturnValueOnce('main\n' as any)
      .mockReturnValueOnce('abc123\n' as any);

    const result = await genesisObserve(true, makeCtx(tmpDir, 'target.ts'));
    expect(result.onSuccess).toBe(true);

    const fp = JSON.parse(JSON.parse(result.ctx).fingerprintJson);

    expect(fp.existingWorkflows).toContain(path.join('src', 'pipeline.ts'));
    expect(fp.existingWorkflows).toContain(path.join('src', 'batch.ts'));
    expect(fp.existingWorkflows).not.toContain(path.join('src', 'validator.ts'));
    expect(fp.existingWorkflows).toContain('target.ts');
  });

  it('src/ dir is scanned in addition to root when it exists', async () => {
    // Root + src/ both have .ts files
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(tmpDir, 'workflow.ts'), '/** @flowWeaver workflow */\nexport function myWorkflow() {}');
    fs.writeFileSync(path.join(srcDir, 'helper.ts'), '// helper node type');

    mockedExecFileSync
      .mockReturnValueOnce('main\n' as any)
      .mockReturnValueOnce('abc123\n' as any);

    const ctxStr = makeCtx(tmpDir, 'workflow.ts');
    const result = await genesisObserve(true, ctxStr);

    expect(result.onSuccess).toBe(true);
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    const fp = JSON.parse(ctx.fingerprintJson!);

    expect(Object.keys(fp.files)).toContain('workflow.ts');
    expect(Object.keys(fp.files)).toContain(path.join('src', 'helper.ts'));
  });

  it('recursively scans deeply nested directories', async () => {
    const deepDir = path.join(tmpDir, 'src', 'bot', 'utils');
    fs.mkdirSync(deepDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'workflow.ts'), '/** @flowWeaver workflow */\nexport function myWorkflow() {}');
    fs.writeFileSync(path.join(deepDir, 'deep-helper.ts'), '// deeply nested');

    mockedExecFileSync
      .mockReturnValueOnce('main\n' as any)
      .mockReturnValueOnce('abc123\n' as any);

    const result = await genesisObserve(true, makeCtx(tmpDir, 'workflow.ts'));
    expect(result.onSuccess).toBe(true);

    const fp = JSON.parse(JSON.parse(result.ctx).fingerprintJson);
    expect(Object.keys(fp.files)).toContain(path.join('src', 'bot', 'utils', 'deep-helper.ts'));
  });

  it('skips node_modules, dist, .git, coverage directories', async () => {
    fs.writeFileSync(path.join(tmpDir, 'workflow.ts'), '/** @flowWeaver workflow */\nexport function myWorkflow() {}');

    for (const skipDir of ['node_modules', 'dist', '.git', 'coverage']) {
      const dir = path.join(tmpDir, skipDir);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'should-skip.ts'), '// skipped');
    }

    mockedExecFileSync
      .mockReturnValueOnce('main\n' as any)
      .mockReturnValueOnce('abc123\n' as any);

    const result = await genesisObserve(true, makeCtx(tmpDir, 'workflow.ts'));
    expect(result.onSuccess).toBe(true);

    const fp = JSON.parse(JSON.parse(result.ctx).fingerprintJson);
    const fileKeys = Object.keys(fp.files);

    for (const skipDir of ['node_modules', 'dist', '.git', 'coverage']) {
      expect(fileKeys.some(k => k.startsWith(skipDir))).toBe(false);
    }
  });

  it('returns onFailure=true when target workflow file does not exist', async () => {
    // No files created — targetWorkflow.ts doesn't exist
    mockedExecFileSync
      .mockReturnValueOnce('main\n' as any)
      .mockReturnValueOnce('abc123\n' as any);

    const result = await genesisObserve(true, makeCtx(tmpDir, 'nonexistent.ts'));

    expect(result.onSuccess).toBe(false);
    expect(result.onFailure).toBe(true);
  });

  it('fingerprintJson is "{}" on error', async () => {
    mockedExecFileSync
      .mockReturnValueOnce('main\n' as any)
      .mockReturnValueOnce('abc123\n' as any);

    const result = await genesisObserve(true, makeCtx(tmpDir, 'nonexistent.ts'));
    const ctx = JSON.parse(result.ctx) as GenesisContext;

    expect(ctx.fingerprintJson).toBe('{}');
  });

  it('env.projectDir preserved in returned ctx on success', async () => {
    fs.writeFileSync(path.join(tmpDir, 'workflow.ts'), '/** @flowWeaver workflow */\nexport function myWorkflow() {}');
    mockedExecFileSync
      .mockReturnValueOnce('main\n' as any)
      .mockReturnValueOnce('abc123\n' as any);

    const result = await genesisObserve(true, makeCtx(tmpDir, 'workflow.ts'));
    const ctx = JSON.parse(result.ctx) as GenesisContext;

    expect(ctx.env.projectDir).toBe(tmpDir);
  });

  it('return shape has onSuccess, onFailure, ctx', async () => {
    fs.writeFileSync(path.join(tmpDir, 'workflow.ts'), '/** @flowWeaver workflow */\nexport function myWorkflow() {}');
    mockedExecFileSync
      .mockReturnValueOnce('main\n' as any)
      .mockReturnValueOnce('abc123\n' as any);

    const result = await genesisObserve(true, makeCtx(tmpDir, 'workflow.ts'));

    expect(Object.keys(result).sort()).toEqual(['ctx', 'onFailure', 'onSuccess']);
  });

  it('packageJson is null when no package.json in project dir', async () => {
    fs.writeFileSync(path.join(tmpDir, 'workflow.ts'), '/** @flowWeaver workflow */\nexport function myWorkflow() {}');
    mockedExecFileSync
      .mockReturnValueOnce('main\n' as any)
      .mockReturnValueOnce('abc123\n' as any);

    const result = await genesisObserve(true, makeCtx(tmpDir, 'workflow.ts'));
    const fp = JSON.parse(JSON.parse(result.ctx).fingerprintJson);

    expect(fp.packageJson).toBeNull();
  });

  it('non-.ts files are excluded from fingerprint.files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'workflow.ts'), '/** @flowWeaver workflow */\nexport function myWorkflow() {}');
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# readme');
    fs.writeFileSync(path.join(tmpDir, 'index.js'), '// js file');
    mockedExecFileSync
      .mockReturnValueOnce('main\n' as any)
      .mockReturnValueOnce('abc123\n' as any);

    const result = await genesisObserve(true, makeCtx(tmpDir, 'workflow.ts'));
    const fp = JSON.parse(JSON.parse(result.ctx).fingerprintJson);

    expect(Object.keys(fp.files)).not.toContain('README.md');
    expect(Object.keys(fp.files)).not.toContain('index.js');
  });

  it('fingerprint.files keys are relative paths (not absolute)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'workflow.ts'), '/** @flowWeaver workflow */\nexport function myWorkflow() {}');
    mockedExecFileSync
      .mockReturnValueOnce('main\n' as any)
      .mockReturnValueOnce('abc123\n' as any);

    const result = await genesisObserve(true, makeCtx(tmpDir, 'workflow.ts'));
    const fp = JSON.parse(JSON.parse(result.ctx).fingerprintJson);

    for (const key of Object.keys(fp.files)) {
      expect(path.isAbsolute(key)).toBe(false);
    }
  });

  it('fingerprintJson is valid JSON on success', async () => {
    fs.writeFileSync(path.join(tmpDir, 'workflow.ts'), '/** @flowWeaver workflow */\nexport function myWorkflow() {}');
    mockedExecFileSync
      .mockReturnValueOnce('main\n' as any)
      .mockReturnValueOnce('abc123\n' as any);

    const result = await genesisObserve(true, makeCtx(tmpDir, 'workflow.ts'));
    const ctx = JSON.parse(result.ctx) as GenesisContext;

    expect(() => JSON.parse(ctx.fingerprintJson!)).not.toThrow();
  });

  it('fingerprintJson.timestamp is a valid ISO string on success', async () => {
    fs.writeFileSync(path.join(tmpDir, 'workflow.ts'), '/** @flowWeaver workflow */\nexport function myWorkflow() {}');
    mockedExecFileSync
      .mockReturnValueOnce('main\n' as any)
      .mockReturnValueOnce('abc123\n' as any);

    const result = await genesisObserve(true, makeCtx(tmpDir, 'workflow.ts'));
    const fp = JSON.parse(JSON.parse(result.ctx).fingerprintJson);

    expect(new Date(fp.timestamp).toISOString()).toBe(fp.timestamp);
  });
});
