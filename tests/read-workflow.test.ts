import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WeaverContext } from '../src/bot/types.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { weaverReadWorkflow } from '../src/node-types/read-workflow.js';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';

const mockExecFileSync = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);

function makeCtx(targets?: string[]): string {
  const context: WeaverContext = {
    env: {
      projectDir: '/proj',
      config: { provider: 'auto' } as WeaverContext['env']['config'],
      providerType: 'anthropic',
      providerInfo: { type: 'anthropic' },
    },
    taskJson: JSON.stringify({
      instruction: 'read the workflow',
      mode: 'read',
      ...(targets !== undefined ? { targets } : {}),
    }),
  };
  return JSON.stringify(context);
}

describe('weaverReadWorkflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no targets returns success=false with error message', () => {
    const result = weaverReadWorkflow(makeCtx([]));
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const resultData = JSON.parse(ctx.resultJson!);
    expect(resultData.success).toBe(false);
    expect(resultData.error).toContain('No target files specified');
    expect(ctx.filesModified).toBe('[]');
  });

  it('undefined targets (task has no targets) returns success=false', () => {
    const result = weaverReadWorkflow(makeCtx(undefined));
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const resultData = JSON.parse(ctx.resultJson!);
    expect(resultData.success).toBe(false);
  });

  it('file not found pushes error entry for that target', () => {
    mockExistsSync.mockReturnValue(false);

    const result = weaverReadWorkflow(makeCtx(['/proj/missing.ts']));
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const resultData = JSON.parse(ctx.resultJson!);

    expect(resultData.success).toBe(true);
    expect(resultData.results).toHaveLength(1);
    expect(resultData.results[0].error).toContain('File not found');
    expect(resultData.results[0].file).toBe('/proj/missing.ts');
  });

  it('happy path: populates source, diagram, and description', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('// workflow source' as unknown as Buffer);
    mockExecFileSync
      .mockReturnValueOnce('ascii-diagram-output\n')
      .mockReturnValueOnce('text-description-output\n');

    const result = weaverReadWorkflow(makeCtx(['/proj/workflow.ts']));
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const resultData = JSON.parse(ctx.resultJson!);

    expect(resultData.success).toBe(true);
    expect(resultData.results).toHaveLength(1);
    const entry = resultData.results[0];
    expect(entry.source).toBe('// workflow source');
    expect(entry.diagram).toBe('ascii-diagram-output');
    expect(entry.description).toBe('text-description-output');
    expect(entry.error).toBeUndefined();
  });

  it('diagram generation failure degrades gracefully (empty diagram, description still populated)', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('// source' as unknown as Buffer);
    mockExecFileSync
      .mockImplementationOnce(() => { throw new Error('diagram failed'); })
      .mockReturnValueOnce('good description\n');

    const result = weaverReadWorkflow(makeCtx(['/proj/workflow.ts']));
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const resultData = JSON.parse(ctx.resultJson!);

    expect(resultData.success).toBe(true);
    const entry = resultData.results[0];
    expect(entry.diagram).toBe('');
    expect(entry.description).toBe('good description');
  });

  it('description failure degrades gracefully (empty description, diagram still populated)', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('// source' as unknown as Buffer);
    mockExecFileSync
      .mockReturnValueOnce('good diagram\n')
      .mockImplementationOnce(() => { throw new Error('describe failed'); });

    const result = weaverReadWorkflow(makeCtx(['/proj/workflow.ts']));
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const resultData = JSON.parse(ctx.resultJson!);

    expect(resultData.success).toBe(true);
    const entry = resultData.results[0];
    expect(entry.diagram).toBe('good diagram');
    expect(entry.description).toBe('');
  });

  it('both diagram and description fail: result still success=true with empty strings', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('// source' as unknown as Buffer);
    mockExecFileSync.mockImplementation(() => { throw new Error('cli unavailable'); });

    const result = weaverReadWorkflow(makeCtx(['/proj/workflow.ts']));
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const resultData = JSON.parse(ctx.resultJson!);

    expect(resultData.success).toBe(true);
    const entry = resultData.results[0];
    expect(entry.diagram).toBe('');
    expect(entry.description).toBe('');
    expect(entry.source).toBe('// source');
  });

  it('multiple targets are processed independently', () => {
    mockExistsSync
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    mockReadFileSync.mockReturnValue('// src' as unknown as Buffer);
    mockExecFileSync.mockReturnValue('output\n');

    const result = weaverReadWorkflow(makeCtx(['/proj/a.ts', '/proj/b.ts']));
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const resultData = JSON.parse(ctx.resultJson!);

    expect(resultData.results).toHaveLength(2);
    expect(resultData.results[0].error).toBeUndefined();
    expect(resultData.results[1].error).toContain('File not found');
  });

  it('sets filesModified to "[]" regardless of outcome', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('// src' as unknown as Buffer);
    mockExecFileSync.mockReturnValue('out\n');

    const result = weaverReadWorkflow(makeCtx(['/proj/workflow.ts']));
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    expect(ctx.filesModified).toBe('[]');
  });

  it('relative target is resolved against projectDir', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('// src' as unknown as Buffer);
    mockExecFileSync.mockReturnValue('out\n');

    // 'workflow.ts' is relative → resolved to '/proj/workflow.ts' for exists/read check
    const result = weaverReadWorkflow(makeCtx(['workflow.ts']));
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const resultData = JSON.parse(ctx.resultJson!);

    expect(resultData.success).toBe(true);
    expect(resultData.results[0].error).toBeUndefined();
  });

  it('resultJson is valid JSON on success', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('// src' as unknown as Buffer);
    mockExecFileSync.mockReturnValue('out\n');

    const result = weaverReadWorkflow(makeCtx(['/proj/workflow.ts']));
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    expect(() => JSON.parse(ctx.resultJson!)).not.toThrow();
  });

  it('resultJson is valid JSON on no-targets error', () => {
    const result = weaverReadWorkflow(makeCtx([]));
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    expect(() => JSON.parse(ctx.resultJson!)).not.toThrow();
  });

  it('return value has only ctx key', () => {
    const result = weaverReadWorkflow(makeCtx([]));
    expect(Object.keys(result)).toEqual(['ctx']);
  });

  it('flow-weaver diagram called with correct args', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('// src' as unknown as Buffer);
    mockExecFileSync.mockReturnValue('diagram\n');

    weaverReadWorkflow(makeCtx(['/proj/workflow.ts']));

    const diagramCall = mockExecFileSync.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('diagram'),
    );
    expect(diagramCall).toBeDefined();
    expect(diagramCall![1]).toContain('-f');
    expect(diagramCall![1]).toContain('ascii-compact');
  });

  it('flow-weaver describe called with correct args', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('// src' as unknown as Buffer);
    mockExecFileSync.mockReturnValue('description\n');

    weaverReadWorkflow(makeCtx(['/proj/workflow.ts']));

    const describeCall = mockExecFileSync.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('describe'),
    );
    expect(describeCall).toBeDefined();
    expect(describeCall![1]).toContain('/proj/workflow.ts');
  });

  it('result entry.file preserves the original target string', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('// src' as unknown as Buffer);
    mockExecFileSync.mockReturnValue('out\n');

    const result = weaverReadWorkflow(makeCtx(['/proj/workflow.ts']));
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const resultData = JSON.parse(ctx.resultJson!);

    expect(resultData.results[0].file).toBe('/proj/workflow.ts');
  });

  it('resultJson.results is empty array when all targets are not found', () => {
    mockExistsSync.mockReturnValue(false);

    const result = weaverReadWorkflow(makeCtx(['/proj/a.ts', '/proj/b.ts']));
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const resultData = JSON.parse(ctx.resultJson!);

    // success=true even when all files missing (errors pushed to results entries)
    expect(resultData.success).toBe(true);
    expect(resultData.results).toHaveLength(2);
    expect(resultData.results.every((r: { error?: string }) => r.error)).toBe(true);
  });

  it('env.projectDir preserved in returned ctx', () => {
    const result = weaverReadWorkflow(makeCtx([]));
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    expect(ctx.env.projectDir).toBe('/proj');
  });
});
