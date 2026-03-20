import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';

// Mock execFileSync and fs
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

const mockedExec = vi.mocked(child_process.execFileSync);
const mockedExists = vi.mocked(fs.existsSync);
const mockedRead = vi.mocked(fs.readFileSync);

describe('weaverBuildContext', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Suppress console.log
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  async function loadModule() {
    // Re-import to get fresh module with mocks
    vi.resetModules();
    const mod = await import('../src/node-types/build-context.js');
    return mod.weaverBuildContext;
  }

  function makeCtx(mode: string, targets?: string[]): string {
    return JSON.stringify({
      env: { projectDir: '/project', config: {}, providerType: 'claude-cli', providerInfo: { type: 'claude-cli' } },
      taskJson: JSON.stringify({ mode, targets, instruction: 'fix stuff' }),
    });
  }

  it('uses minimal topics for modify tasks', async () => {
    const fn = await loadModule();
    mockedExec.mockReturnValue('minimal grammar context' as any);
    mockedExists.mockReturnValue(true);
    mockedRead.mockReturnValue('// workflow source' as any);

    const result = fn(makeCtx('modify', ['src/templates/my-workflow.ts']));
    const ctx = JSON.parse(result.ctx);

    // Should call with minimal topics, not full authoring
    expect(mockedExec).toHaveBeenCalledWith(
      'flow-weaver',
      ['context', '--topics', 'jsdoc-grammar,advanced-annotations', '--profile', 'assistant'],
      expect.any(Object),
    );
    expect(ctx.contextBundle).toContain('minimal grammar context');
  });

  it('uses full authoring for create tasks', async () => {
    const fn = await loadModule();
    mockedExec.mockReturnValue('full authoring context' as any);

    const result = fn(makeCtx('create'));
    const ctx = JSON.parse(result.ctx);

    expect(mockedExec).toHaveBeenCalledWith(
      'flow-weaver',
      ['context', 'authoring', '--profile', 'assistant'],
      expect.any(Object),
    );
    expect(ctx.contextBundle).toContain('full authoring context');
  });

  it('includes target file source for modify tasks', async () => {
    const fn = await loadModule();
    mockedExec.mockReturnValue('grammar' as any);
    mockedExists.mockReturnValue(true);
    mockedRead.mockReturnValue('// my workflow code' as any);

    const result = fn(makeCtx('modify', ['src/templates/agent.ts']));
    const ctx = JSON.parse(result.ctx);

    expect(ctx.contextBundle).toContain('## Target: src/templates/agent.ts');
    expect(ctx.contextBundle).toContain('// my workflow code');
  });

  it('extracts referenced node type sources from imports', async () => {
    const fn = await loadModule();
    mockedExec.mockReturnValue('grammar' as any);

    const workflowSource = `
import { myNode } from '../node-types/my-node.js';
import { otherNode } from '../node-types/other-node.js';
`;
    const nodeTypeSource = '/** @flowWeaver nodeType */\nexport function myNode() {}';

    mockedExists.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith('agent.ts')) return true;
      if (s.endsWith('my-node.ts')) return true;
      if (s.endsWith('other-node.ts')) return true;
      return false;
    });

    mockedRead.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith('agent.ts')) return workflowSource as any;
      return nodeTypeSource as any;
    });

    const result = fn(makeCtx('modify', ['src/templates/agent.ts']));
    const ctx = JSON.parse(result.ctx);

    expect(ctx.contextBundle).toContain('## Node Type:');
    expect(ctx.contextBundle).toContain('/** @flowWeaver nodeType */');
  });

  it('does not duplicate node types already included', async () => {
    const fn = await loadModule();
    mockedExec.mockReturnValue('grammar' as any);

    const workflowSource = `
import { myNode } from '../node-types/my-node.js';
import { myNode as alias } from '../node-types/my-node.js';
`;

    mockedExists.mockReturnValue(true);
    mockedRead.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith('agent.ts')) return workflowSource as any;
      return '// node type' as any;
    });

    const result = fn(makeCtx('modify', ['src/templates/agent.ts']));
    const ctx = JSON.parse(result.ctx);

    // Should only appear once
    const matches = ctx.contextBundle.match(/## Node Type:/g) || [];
    expect(matches.length).toBe(1);
  });

  it('skips non-relative and non-node-type imports', async () => {
    const fn = await loadModule();
    mockedExec.mockReturnValue('grammar' as any);

    const workflowSource = `
import { something } from '@synergenius/flow-weaver';
import { utils } from '../utils/helpers.js';
import { myNode } from '../node-types/my-node.js';
`;

    mockedExists.mockReturnValue(true);
    mockedRead.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith('agent.ts')) return workflowSource as any;
      return '// node source' as any;
    });

    const result = fn(makeCtx('modify', ['src/templates/agent.ts']));
    const ctx = JSON.parse(result.ctx);

    // Only one node type (my-node), not utils or external packages
    const matches = ctx.contextBundle.match(/## Node Type:/g) || [];
    expect(matches.length).toBe(1);
  });

  it('falls back gracefully when context CLI fails', async () => {
    const fn = await loadModule();
    mockedExec.mockImplementation(() => { throw new Error('not found'); });
    mockedExists.mockReturnValue(true);
    mockedRead.mockReturnValue('// source' as any);

    const result = fn(makeCtx('modify', ['src/templates/agent.ts']));
    const ctx = JSON.parse(result.ctx);

    expect(ctx.contextBundle).toContain('(flow-weaver context not available)');
    expect(ctx.contextBundle).toContain('// source');
  });
});
