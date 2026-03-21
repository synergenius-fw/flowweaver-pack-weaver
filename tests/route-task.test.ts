import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WeaverContext } from '../src/bot/types.js';

import { weaverRouteTask } from '../src/node-types/route-task.js';

function makeCtx(mode?: string): string {
  const context: WeaverContext = {
    env: {
      projectDir: '/proj',
      config: { provider: 'auto' } as WeaverContext['env']['config'],
      providerType: 'anthropic',
      providerInfo: { type: 'anthropic' },
    },
    taskJson: JSON.stringify({
      instruction: 'do something',
      ...(mode !== undefined ? { mode } : {}),
    }),
  };
  return JSON.stringify(context);
}

describe('weaverRouteTask', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('mode="read" throws read-only-route', () => {
    const ctx = makeCtx('read');
    expect(() => weaverRouteTask(ctx)).toThrow('read-only-route');
  });

  it('mode="create" returns ctx unchanged', () => {
    const ctx = makeCtx('create');
    const result = weaverRouteTask(ctx);
    expect(result.ctx).toBe(ctx);
  });

  it('mode="modify" returns ctx unchanged', () => {
    const ctx = makeCtx('modify');
    const result = weaverRouteTask(ctx);
    expect(result.ctx).toBe(ctx);
  });

  it('mode="batch" returns ctx unchanged', () => {
    const ctx = makeCtx('batch');
    const result = weaverRouteTask(ctx);
    expect(result.ctx).toBe(ctx);
  });

  it('missing mode defaults to create and returns ctx unchanged', () => {
    const ctx = makeCtx();
    const result = weaverRouteTask(ctx);
    expect(result.ctx).toBe(ctx);
  });

  it('return value has only the ctx key', () => {
    const result = weaverRouteTask(makeCtx('create'));
    expect(Object.keys(result)).toEqual(['ctx']);
  });

  it('unknown mode (not "read") returns ctx unchanged', () => {
    const ctx = makeCtx('unknown-mode');
    const result = weaverRouteTask(ctx);
    expect(result.ctx).toBe(ctx);
  });

  it('mode="read" throws an Error instance', () => {
    expect(() => weaverRouteTask(makeCtx('read'))).toThrow(Error);
  });

  it('error message is exactly "read-only-route"', () => {
    let caught: unknown;
    try { weaverRouteTask(makeCtx('read')); } catch (e) { caught = e; }
    expect((caught as Error).message).toBe('read-only-route');
  });

  it('env.projectDir is preserved in returned ctx', () => {
    const result = weaverRouteTask(makeCtx('modify'));
    const parsed = JSON.parse(result.ctx) as WeaverContext;
    expect(parsed.env.projectDir).toBe('/proj');
  });

  it('taskJson instruction is preserved in returned ctx', () => {
    const result = weaverRouteTask(makeCtx('create'));
    const parsed = JSON.parse(result.ctx) as WeaverContext;
    const task = JSON.parse(parsed.taskJson!);
    expect(task.instruction).toBe('do something');
  });

  it('logs routing message for create mode', () => {
    weaverRouteTask(makeCtx('create'));
    expect(vi.mocked(console.log)).toHaveBeenCalledWith(
      expect.stringContaining('create'),
    );
  });

  it('logs routing message for read mode before throwing', () => {
    try { weaverRouteTask(makeCtx('read')); } catch { /* expected */ }
    expect(vi.mocked(console.log)).toHaveBeenCalled();
  });

  it('mode=undefined in task (no mode key) routes successfully', () => {
    // makeCtx() with no arg omits mode from task
    const ctx = makeCtx();
    const parsed = JSON.parse(ctx) as WeaverContext;
    const task = JSON.parse(parsed.taskJson!);
    expect(task.mode).toBeUndefined();
    // Should not throw
    expect(() => weaverRouteTask(ctx)).not.toThrow();
  });
});
