import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import type { WeaverContext } from '../src/bot/types.js';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFileSync: vi.fn() };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, readFileSync: vi.fn(), existsSync: vi.fn() };
});

import { weaverBuildContext } from '../src/node-types/build-context.js';

const mockedExecFileSync = vi.mocked(child_process.execFileSync);
const mockedReadFileSync = vi.mocked(fs.readFileSync);
const mockedExistsSync = vi.mocked(fs.existsSync);

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeCtx(task: { mode?: string; targets?: string[] } = {}): string {
  const context: WeaverContext = {
    env: {
      projectDir: '/project',
      config: { provider: 'auto' },
      providerType: 'anthropic',
      providerInfo: { type: 'anthropic' },
    },
    taskJson: JSON.stringify(task),
  };
  return JSON.stringify(context);
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('weaverBuildContext — modify mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('calls flow-weaver context with jsdoc-grammar+advanced-annotations topics', () => {
    mockedExecFileSync.mockReturnValue('' as any);
    mockedExistsSync.mockReturnValue(false);

    weaverBuildContext(makeCtx({ mode: 'modify', targets: ['src/workflow.ts'] }));

    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'flow-weaver',
      ['context', '--topics', 'jsdoc-grammar,advanced-annotations', '--profile', 'assistant'],
      expect.objectContaining({ cwd: '/project' }),
    );
  });

  it('includes grammar output and target file source in context bundle', () => {
    mockedExecFileSync.mockReturnValue('grammar section' as any);
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('// workflow source' as any);

    const result = weaverBuildContext(makeCtx({ mode: 'modify', targets: ['src/workflow.ts'] }));
    const ctx = JSON.parse(result.ctx) as WeaverContext;

    expect(ctx.contextBundle).toContain('grammar section');
    expect(ctx.contextBundle).toContain('// workflow source');
    expect(ctx.contextBundle).toContain('## Target: src/workflow.ts');
  });

  it('does NOT call full authoring preset in modify mode', () => {
    mockedExecFileSync.mockReturnValue('' as any);
    mockedExistsSync.mockReturnValue(false);

    weaverBuildContext(makeCtx({ mode: 'modify', targets: ['src/workflow.ts'] }));

    const calls = mockedExecFileSync.mock.calls;
    expect(calls.every((c) => !(c[1] as string[]).includes('authoring'))).toBe(true);
  });

  it('skips target file that does not exist on disk', () => {
    mockedExecFileSync.mockReturnValue('grammar' as any);
    mockedExistsSync.mockReturnValue(false); // target absent

    const result = weaverBuildContext(makeCtx({ mode: 'modify', targets: ['src/missing.ts'] }));
    const ctx = JSON.parse(result.ctx) as WeaverContext;

    expect(mockedReadFileSync).not.toHaveBeenCalled();
    expect(ctx.contextBundle).not.toContain('## Target:');
  });

  it('falls back to full context when targets array is empty', () => {
    mockedExecFileSync.mockReturnValue('authoring context' as any);

    weaverBuildContext(makeCtx({ mode: 'modify', targets: [] }));

    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'flow-weaver',
      ['context', 'authoring', '--profile', 'assistant'],
      expect.any(Object),
    );
  });
});

describe('weaverBuildContext — create mode (full authoring context)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('calls flow-weaver context with authoring preset', () => {
    mockedExecFileSync.mockReturnValue('authoring context' as any);

    weaverBuildContext(makeCtx({ mode: 'create' }));

    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'flow-weaver',
      ['context', 'authoring', '--profile', 'assistant'],
      expect.objectContaining({ cwd: '/project' }),
    );
  });

  it('includes templates section in create mode', () => {
    mockedExecFileSync
      .mockReturnValueOnce('authoring context' as any)
      .mockReturnValueOnce('sequential\nforeach\nai-agent' as any);

    const result = weaverBuildContext(makeCtx({ mode: 'create' }));
    const ctx = JSON.parse(result.ctx) as WeaverContext;

    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'flow-weaver',
      ['list', 'templates'],
      expect.objectContaining({ cwd: '/project' }),
    );
    expect(ctx.contextBundle).toContain('## Available Templates');
    expect(ctx.contextBundle).toContain('sequential');
  });

  it('does not include templates section for non-create modes', () => {
    mockedExecFileSync.mockReturnValue('authoring context' as any);

    weaverBuildContext(makeCtx({ mode: 'batch' }));

    const listCalls = mockedExecFileSync.mock.calls.filter(
      (c) => (c[1] as string[])[0] === 'list',
    );
    expect(listCalls).toHaveLength(0);
  });
});

describe('weaverBuildContext — CLI unavailable fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('falls back to placeholder string when flow-weaver throws in modify mode', () => {
    mockedExecFileSync.mockImplementation(() => { throw new Error('command not found'); });
    mockedExistsSync.mockReturnValue(false);

    const result = weaverBuildContext(makeCtx({ mode: 'modify', targets: ['src/workflow.ts'] }));
    const ctx = JSON.parse(result.ctx) as WeaverContext;

    expect(ctx.contextBundle).toContain('(flow-weaver context not available)');
  });

  it('falls back to placeholder string when flow-weaver throws in full context mode', () => {
    mockedExecFileSync.mockImplementation(() => { throw new Error('command not found'); });

    const result = weaverBuildContext(makeCtx({ mode: 'create' }));
    const ctx = JSON.parse(result.ctx) as WeaverContext;

    expect(ctx.contextBundle).toContain('(flow-weaver context not available)');
  });

  it('still processes target files even when CLI throws', () => {
    mockedExecFileSync.mockImplementation(() => { throw new Error('command not found'); });
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('// workflow content' as any);

    const result = weaverBuildContext(makeCtx({ mode: 'modify', targets: ['src/workflow.ts'] }));
    const ctx = JSON.parse(result.ctx) as WeaverContext;

    expect(ctx.contextBundle).toContain('(flow-weaver context not available)');
    expect(ctx.contextBundle).toContain('// workflow content');
  });
});

describe('weaverBuildContext — extractReferencedNodeTypes filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('skips non-relative imports even when path contains "node-types"', () => {
    const workflowSource = [
      `import { foo } from 'lodash/node-types';`,
      `import { bar } from '@scope/node-types/foo';`,
    ].join('\n');

    mockedExecFileSync.mockReturnValue('' as any);
    mockedExistsSync.mockReturnValueOnce(true);
    mockedReadFileSync.mockReturnValueOnce(workflowSource as any);

    const result = weaverBuildContext(makeCtx({ mode: 'modify', targets: ['src/workflow.ts'] }));
    const ctx = JSON.parse(result.ctx) as WeaverContext;

    expect(ctx.contextBundle).not.toContain('## Node Type:');
    // existsSync should only be called for the target file itself (not for the skipped imports)
    expect(mockedExistsSync).toHaveBeenCalledTimes(1);
  });

  it('skips relative imports that do not contain "node-type" in path', () => {
    const workflowSource = [
      `import { foo } from '../utils/helpers.js';`,
      `import { bar } from './shared/processor.js';`,
    ].join('\n');

    mockedExecFileSync.mockReturnValue('' as any);
    mockedExistsSync.mockReturnValueOnce(true);
    mockedReadFileSync.mockReturnValueOnce(workflowSource as any);

    const result = weaverBuildContext(makeCtx({ mode: 'modify', targets: ['src/workflow.ts'] }));
    const ctx = JSON.parse(result.ctx) as WeaverContext;

    expect(ctx.contextBundle).not.toContain('## Node Type:');
    expect(mockedExistsSync).toHaveBeenCalledTimes(1);
  });

  it('includes relative node-type imports when the resolved file exists', () => {
    // target: /project/src/workflow.ts imports ../node-types/my-node.js
    // resolved: /project/node-types/my-node.js → .replace → /project/node-types/my-node.ts
    const workflowSource = `import { myNode } from '../node-types/my-node.js';`;
    const nodeTypeSource = '// my node type implementation';

    mockedExecFileSync.mockReturnValue('' as any);
    mockedExistsSync
      .mockReturnValueOnce(true)   // target file exists (/project/src/workflow.ts)
      .mockReturnValueOnce(false)  // /project/node-types/my-node.js does not exist
      .mockReturnValueOnce(false)  // /project/node-types/my-node.js.ts does not exist
      .mockReturnValueOnce(true);  // /project/node-types/my-node.ts exists (.js→.ts)
    mockedReadFileSync
      .mockReturnValueOnce(workflowSource as any) // reading target
      .mockReturnValueOnce(nodeTypeSource as any); // reading node type

    const result = weaverBuildContext(makeCtx({ mode: 'modify', targets: ['/project/src/workflow.ts'] }));
    const ctx = JSON.parse(result.ctx) as WeaverContext;

    expect(ctx.contextBundle).toContain('## Node Type:');
    expect(ctx.contextBundle).toContain('// my node type implementation');
  });

  it('deduplicates node type files included via multiple targets', () => {
    const workflowSource = `import { myNode } from '../node-types/shared.js';`;
    const nodeTypeSource = '// shared node';

    mockedExecFileSync.mockReturnValue('' as any);
    mockedExistsSync
      .mockReturnValueOnce(true)   // first target exists
      .mockReturnValueOnce(false)  // resolved .js
      .mockReturnValueOnce(false)  // resolved .js.ts
      .mockReturnValueOnce(true)   // resolved .ts found
      .mockReturnValueOnce(true)   // second target exists
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);  // same resolved .ts found again
    mockedReadFileSync
      .mockReturnValueOnce(workflowSource as any)
      .mockReturnValueOnce(nodeTypeSource as any)
      .mockReturnValueOnce(workflowSource as any);
    // The second target's node-type read should be skipped (dedup)

    const result = weaverBuildContext(makeCtx({
      mode: 'modify',
      targets: ['/project/src/workflow-a.ts', '/project/src/workflow-b.ts'],
    }));
    const ctx = JSON.parse(result.ctx) as WeaverContext;

    // Node type section appears only once
    const matches = (ctx.contextBundle ?? '').match(/## Node Type:/g);
    expect(matches).toHaveLength(1);
  });
});

describe('weaverBuildContext — WEAVER_VERBOSE logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('logs unreadable target file to console.error when WEAVER_VERBOSE is set', () => {
    const originalVerbose = process.env.WEAVER_VERBOSE;
    process.env.WEAVER_VERBOSE = '1';
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockedExecFileSync.mockReturnValue('' as any);
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation(() => { throw new Error('permission denied'); });

    weaverBuildContext(makeCtx({ mode: 'modify', targets: ['src/workflow.ts'] }));

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('[build-context] unreadable file:'),
      expect.any(Error),
    );

    process.env.WEAVER_VERBOSE = originalVerbose;
  });

  it('does not log when WEAVER_VERBOSE is not set', () => {
    delete process.env.WEAVER_VERBOSE;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockedExecFileSync.mockReturnValue('' as any);
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation(() => { throw new Error('permission denied'); });

    weaverBuildContext(makeCtx({ mode: 'modify', targets: ['src/workflow.ts'] }));

    expect(consoleError).not.toHaveBeenCalled();
  });

  it('logs CLI unavailable error when WEAVER_VERBOSE is set in modify mode', () => {
    const originalVerbose = process.env.WEAVER_VERBOSE;
    process.env.WEAVER_VERBOSE = '1';
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockedExecFileSync.mockImplementation(() => { throw new Error('flow-weaver not found'); });
    mockedExistsSync.mockReturnValue(false);

    weaverBuildContext(makeCtx({ mode: 'modify', targets: ['src/workflow.ts'] }));

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('[build-context] modify context unavailable:'),
      expect.any(Error),
    );

    process.env.WEAVER_VERBOSE = originalVerbose;
  });
});
