/**
 * Integration-style tests for the weaver-bot read path:
 *   weaverRouteTask (throws on mode=read)
 *     → weaverReadWorkflow (reads targets, populates resultJson)
 *     → weaverBotReport (receives readCtx, sets path='read', builds summary)
 *
 * External dependencies mocked:
 *   - node:child_process execFileSync (flow-weaver diagram / describe CLI calls)
 *
 * Real fs is used via temp directories created in beforeEach.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WeaverContext } from '../src/bot/types.js';

// ── Mock execFileSync only (real fs, real temp dirs) ──────────────────────────

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFileSync: vi.fn() };
});

const mockedExecFileSync = vi.mocked(execFileSync);

// ── Real function imports ─────────────────────────────────────────────────────

import { weaverRouteTask } from '../src/node-types/route-task.js';
import { weaverReadWorkflow } from '../src/node-types/read-workflow.js';
import { weaverBotReport } from '../src/node-types/bot-report.js';

// ── helpers ───────────────────────────────────────────────────────────────────

const BASE_ENV = {
  config: { provider: 'auto' as const },
  providerType: 'anthropic' as const,
  providerInfo: { type: 'anthropic' as const, apiKey: 'k' },
};

function makeCtx(projectDir: string, task: object): string {
  const ctx: WeaverContext = {
    env: { ...BASE_ENV, projectDir },
    taskJson: JSON.stringify(task),
  };
  return JSON.stringify(ctx);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('read path: weaverRouteTask (mode=read)', () => {
  it('throws with "read-only-route" when mode=read', () => {
    const ctx = makeCtx('/proj', { instruction: 'Describe the workflow', mode: 'read' });
    expect(() => weaverRouteTask(ctx)).toThrow('read-only-route');
  });

  it('thrown error is an Error instance (catchable in route:fail branch)', () => {
    const ctx = makeCtx('/proj', { instruction: 'Read only', mode: 'read' });
    expect(() => weaverRouteTask(ctx)).toThrowError(Error);
  });

  it('does not throw for mode=create (route:ok branch)', () => {
    const ctx = makeCtx('/proj', { instruction: 'Add node', mode: 'create' });
    expect(() => weaverRouteTask(ctx)).not.toThrow();
  });
});

// ── weaverReadWorkflow ────────────────────────────────────────────────────────

describe('read path: weaverReadWorkflow', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-read-path-'));
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Default: execFileSync throws (CLI unavailable) — graceful degradation expected
    mockedExecFileSync.mockImplementation(() => { throw new Error('CLI not found'); });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sets resultJson.success=true when targets exist', () => {
    const wfFile = path.join(tmpDir, 'workflow.ts');
    fs.writeFileSync(wfFile, '/** @flowWeaver workflow */\nexport function myWorkflow() {}');

    const ctx = makeCtx(tmpDir, {
      instruction: 'Describe workflow',
      mode: 'read',
      targets: ['workflow.ts'],
    });

    const result = weaverReadWorkflow(ctx);
    const outCtx = JSON.parse(result.ctx) as WeaverContext;
    const resultData = JSON.parse(outCtx.resultJson!);

    expect(resultData.success).toBe(true);
  });

  it('sets resultJson.results as array with one entry per target', () => {
    const wfFile = path.join(tmpDir, 'wf.ts');
    fs.writeFileSync(wfFile, '// workflow content');

    const ctx = makeCtx(tmpDir, { instruction: 'Read', mode: 'read', targets: ['wf.ts'] });

    const result = weaverReadWorkflow(ctx);
    const outCtx = JSON.parse(result.ctx) as WeaverContext;
    const resultData = JSON.parse(outCtx.resultJson!);

    expect(Array.isArray(resultData.results)).toBe(true);
    expect(resultData.results).toHaveLength(1);
    expect(resultData.results[0].file).toBe('wf.ts');
  });

  it('includes source code in results entry', () => {
    const content = '/** @flowWeaver workflow */\nexport function pipeline() { return 42; }';
    fs.writeFileSync(path.join(tmpDir, 'pipeline.ts'), content);

    const ctx = makeCtx(tmpDir, { instruction: 'Inspect', mode: 'read', targets: ['pipeline.ts'] });

    const result = weaverReadWorkflow(ctx);
    const resultData = JSON.parse(JSON.parse(result.ctx).resultJson!);

    expect(resultData.results[0].source).toBe(content);
  });

  it('sets results[].diagram from execFileSync diagram output', () => {
    fs.writeFileSync(path.join(tmpDir, 'wf.ts'), '// wf');
    mockedExecFileSync
      .mockReturnValueOnce('ASCII DIAGRAM\n' as any)  // diagram call
      .mockReturnValueOnce('DESCRIPTION TEXT\n' as any); // describe call

    const ctx = makeCtx(tmpDir, { mode: 'read', targets: ['wf.ts'] });

    const result = weaverReadWorkflow(ctx);
    const resultData = JSON.parse(JSON.parse(result.ctx).resultJson!);

    expect(resultData.results[0].diagram).toBe('ASCII DIAGRAM');
  });

  it('sets results[].description from execFileSync describe output', () => {
    fs.writeFileSync(path.join(tmpDir, 'wf.ts'), '// wf');
    mockedExecFileSync
      .mockReturnValueOnce('DIAGRAM\n' as any)
      .mockReturnValueOnce('Workflow: myWf\nNodes: 3\n' as any);

    const ctx = makeCtx(tmpDir, { mode: 'read', targets: ['wf.ts'] });

    const result = weaverReadWorkflow(ctx);
    const resultData = JSON.parse(JSON.parse(result.ctx).resultJson!);

    expect(resultData.results[0].description).toContain('Workflow: myWf');
  });

  it('gracefully sets empty diagram/description when execFileSync throws', () => {
    fs.writeFileSync(path.join(tmpDir, 'wf.ts'), '// content');
    mockedExecFileSync.mockImplementation(() => { throw new Error('CLI unavailable'); });

    const ctx = makeCtx(tmpDir, { mode: 'read', targets: ['wf.ts'] });

    const result = weaverReadWorkflow(ctx);
    const resultData = JSON.parse(JSON.parse(result.ctx).resultJson!);

    // success=true even without CLI tools
    expect(resultData.success).toBe(true);
    expect(resultData.results[0].diagram).toBe('');
    expect(resultData.results[0].description).toBe('');
  });

  it('handles multiple targets, returning one result entry per file', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), '// a');
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), '// b');

    const ctx = makeCtx(tmpDir, { mode: 'read', targets: ['a.ts', 'b.ts'] });

    const result = weaverReadWorkflow(ctx);
    const resultData = JSON.parse(JSON.parse(result.ctx).resultJson!);

    expect(resultData.results).toHaveLength(2);
    expect(resultData.results.map((r: { file: string }) => r.file)).toEqual(['a.ts', 'b.ts']);
  });

  it('sets results[].error when target file does not exist', () => {
    const ctx = makeCtx(tmpDir, { mode: 'read', targets: ['nonexistent.ts'] });

    const result = weaverReadWorkflow(ctx);
    const resultData = JSON.parse(JSON.parse(result.ctx).resultJson!);

    expect(resultData.success).toBe(true);  // overall success
    expect(resultData.results[0].error).toContain('not found');
    expect(resultData.results[0].source).toBeUndefined();
  });

  it('returns success=false and error when targets array is empty', () => {
    const ctx = makeCtx(tmpDir, { mode: 'read', targets: [] });

    const result = weaverReadWorkflow(ctx);
    const outCtx = JSON.parse(result.ctx) as WeaverContext;
    const resultData = JSON.parse(outCtx.resultJson!);

    expect(resultData.success).toBe(false);
    expect(resultData.error).toContain('No target files');
  });

  it('returns success=false when no targets key in task', () => {
    const ctx = makeCtx(tmpDir, { mode: 'read', instruction: 'Read without targets' });

    const result = weaverReadWorkflow(ctx);
    const resultData = JSON.parse(JSON.parse(result.ctx).resultJson!);

    expect(resultData.success).toBe(false);
  });

  it('sets filesModified to empty array (read path never modifies files)', () => {
    const ctx = makeCtx(tmpDir, { mode: 'read', targets: [] });

    const result = weaverReadWorkflow(ctx);
    const outCtx = JSON.parse(result.ctx) as WeaverContext;

    expect(JSON.parse(outCtx.filesModified!)).toEqual([]);
  });

  it('preserves env in output context', () => {
    const ctx = makeCtx(tmpDir, { mode: 'read', targets: [] });

    const result = weaverReadWorkflow(ctx);
    const outCtx = JSON.parse(result.ctx) as WeaverContext;

    expect(outCtx.env.projectDir).toBe(tmpDir);
  });

  it('resolves relative target path against projectDir', () => {
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'workflow.ts'), '// src workflow');

    const ctx = makeCtx(tmpDir, { mode: 'read', targets: ['src/workflow.ts'] });

    const result = weaverReadWorkflow(ctx);
    const resultData = JSON.parse(JSON.parse(result.ctx).resultJson!);

    expect(resultData.results[0].source).toBe('// src workflow');
  });
});

// ── weaverBotReport (read path) ───────────────────────────────────────────────

describe('read path: weaverBotReport with readCtx', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  function makeReadCtx(
    tmpDir: string,
    task: object,
    resultJson: object,
  ): string {
    const ctx: WeaverContext = {
      env: { ...BASE_ENV, projectDir: tmpDir },
      taskJson: JSON.stringify(task),
      resultJson: JSON.stringify(resultJson),
      filesModified: '[]',
    };
    return JSON.stringify(ctx);
  }

  it('sets pathName=read in reportJson', async () => {
    const readCtx = makeReadCtx('/proj', { instruction: 'Read wf' }, { success: true });
    const result = await weaverBotReport(true, undefined, readCtx, undefined);
    const report = JSON.parse(result.reportJson);
    expect(report.path).toBe('read');
  });

  it('returns onSuccess=true for successful read', async () => {
    const readCtx = makeReadCtx('/proj', { instruction: 'Inspect' }, { success: true });
    const result = await weaverBotReport(true, undefined, readCtx, undefined);
    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);
  });

  it('summary includes task instruction', async () => {
    const readCtx = makeReadCtx('/proj', { instruction: 'Show me the workflow structure' }, { success: true });
    const result = await weaverBotReport(true, undefined, readCtx, undefined);
    expect(result.summary).toContain('Show me the workflow structure');
  });

  it('summary includes outcome from resultJson', async () => {
    const readCtx = makeReadCtx('/proj', { instruction: 'Describe' }, { success: true, outcome: 'read-complete' });
    const result = await weaverBotReport(true, undefined, readCtx, undefined);
    expect(result.summary).toContain('read-complete');
  });

  it('summary shows "completed" outcome when resultJson has no explicit outcome', async () => {
    const readCtx = makeReadCtx('/proj', { instruction: 'Read' }, { success: true });
    const result = await weaverBotReport(true, undefined, readCtx, undefined);
    expect(result.summary).toContain('completed');
  });

  it('summary includes result.summary when present', async () => {
    const readCtx = makeReadCtx(
      '/proj',
      { instruction: 'Describe workflow' },
      { success: true, summary: 'Found 5 nodes and 4 connections' },
    );
    const result = await weaverBotReport(true, undefined, readCtx, undefined);
    expect(result.summary).toContain('Found 5 nodes');
  });

  it('does not show "Files: N modified" when filesModified is empty', async () => {
    const readCtx = makeReadCtx('/proj', { instruction: 'Read' }, { success: true });
    const result = await weaverBotReport(true, undefined, readCtx, undefined);
    expect(result.summary).not.toContain('Files:');
  });

  it('reportJson.result contains the parsed resultJson from context', async () => {
    const readCtx = makeReadCtx('/proj', { instruction: 'Inspect' }, { success: true, results: [{ file: 'wf.ts' }] });
    const result = await weaverBotReport(true, undefined, readCtx, undefined);
    const report = JSON.parse(result.reportJson);
    expect(report.result.results).toHaveLength(1);
    expect(report.result.results[0].file).toBe('wf.ts');
  });
});

// ── Full read path integration ────────────────────────────────────────────────

describe('full read path integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-read-integration-'));
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockedExecFileSync.mockImplementation(() => { throw new Error('CLI not available'); });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('complete read path: route throws → readWorkflow → botReport (onSuccess=true)', async () => {
    const wfPath = path.join(tmpDir, 'my-workflow.ts');
    fs.writeFileSync(wfPath, '/** @flowWeaver workflow */\nexport function myWorkflow() {}');

    const initialCtx = makeCtx(tmpDir, {
      instruction: 'Describe my workflow',
      mode: 'read',
      targets: ['my-workflow.ts'],
    });

    // Step 1: route task → throws for read mode (route:fail branch)
    expect(() => weaverRouteTask(initialCtx)).toThrow('read-only-route');

    // Step 2: readWorkflow gets the same ctx (passed via route:fail output)
    const readResult = weaverReadWorkflow(initialCtx);

    const readCtx = JSON.parse(readResult.ctx) as WeaverContext;
    expect(JSON.parse(readCtx.resultJson!).success).toBe(true);
    expect(JSON.parse(readCtx.resultJson!).results).toHaveLength(1);

    // Step 3: botReport receives the readCtx
    const reportResult = await weaverBotReport(true, undefined, readResult.ctx, undefined);

    expect(reportResult.onSuccess).toBe(true);
    expect(reportResult.onFailure).toBe(false);
    expect(JSON.parse(reportResult.reportJson).path).toBe('read');
    expect(reportResult.summary).toContain('Describe my workflow');
  });

  it('read path with diagram available: diagram appears in results', async () => {
    const wfPath = path.join(tmpDir, 'wf.ts');
    fs.writeFileSync(wfPath, '/** @flowWeaver workflow */\nexport function wf() {}');
    mockedExecFileSync
      .mockReturnValueOnce('[Start] -> [node1] -> [Exit]\n' as any)
      .mockReturnValueOnce('Workflow: wf\nNodes: 2\n' as any);

    const initialCtx = makeCtx(tmpDir, {
      instruction: 'Show workflow diagram',
      mode: 'read',
      targets: ['wf.ts'],
    });

    const readResult = weaverReadWorkflow(initialCtx);
    const resultData = JSON.parse(JSON.parse(readResult.ctx).resultJson!);

    expect(resultData.results[0].diagram).toBe('[Start] -> [node1] -> [Exit]');
    expect(resultData.results[0].description).toContain('Workflow: wf');

    const reportResult = await weaverBotReport(true, undefined, readResult.ctx, undefined);
    expect(reportResult.onSuccess).toBe(true);
    expect(reportResult.summary).toContain('Show workflow diagram');
  });

  it('read path with missing file: still returns success with error in results', async () => {
    const initialCtx = makeCtx(tmpDir, {
      instruction: 'Read a missing file',
      mode: 'read',
      targets: ['does-not-exist.ts'],
    });

    const readResult = weaverReadWorkflow(initialCtx);
    const resultData = JSON.parse(JSON.parse(readResult.ctx).resultJson!);

    expect(resultData.success).toBe(true);
    expect(resultData.results[0].error).toBeDefined();

    const reportResult = await weaverBotReport(true, undefined, readResult.ctx, undefined);
    expect(reportResult.onSuccess).toBe(true);
    expect(JSON.parse(reportResult.reportJson).path).toBe('read');
  });

  it('read path with no targets: botReport reflects overall failure', async () => {
    const initialCtx = makeCtx(tmpDir, {
      instruction: 'Read without targets',
      mode: 'read',
      targets: [],
    });

    const readResult = weaverReadWorkflow(initialCtx);
    const resultData = JSON.parse(JSON.parse(readResult.ctx).resultJson!);
    expect(resultData.success).toBe(false);

    const reportResult = await weaverBotReport(true, undefined, readResult.ctx, undefined);
    // success=false propagates — pathName is still 'read' but onSuccess depends on result.success
    expect(JSON.parse(reportResult.reportJson).path).toBe('read');
    // result.success=false + pathName=read → weaverBotReport success=false
    expect(reportResult.onSuccess).toBe(false);
    expect(reportResult.onFailure).toBe(true);
  });
});
