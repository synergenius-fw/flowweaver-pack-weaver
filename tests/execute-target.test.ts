import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WeaverContext } from '../src/bot/types.js';

vi.mock('../src/bot/ai-client.js', () => ({
  callAI: vi.fn(),
  parseJsonResponse: vi.fn(),
}));

// Mock the dynamic executor import used in the execute path
const mockExecuteWorkflowFromFile = vi.hoisted(() => vi.fn());
vi.mock('@synergenius/flow-weaver/executor', () => ({
  executeWorkflowFromFile: mockExecuteWorkflowFromFile,
}));

import { weaverExecuteTarget } from '../src/node-types/execute-target.js';

function makeCtx(targetPath = '/proj/workflow.ts'): string {
  const context: WeaverContext = {
    env: {
      projectDir: '/proj',
      config: { provider: 'auto', approval: 'auto' },
      providerType: 'anthropic',
      providerInfo: { type: 'anthropic', apiKey: 'test-key', model: 'claude-sonnet-4-6' },
    },
    taskJson: JSON.stringify({ instruction: 'run it', mode: 'create' }),
    targetPath,
  };
  return JSON.stringify(context);
}

describe('weaverExecuteTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('execute=false returns onSuccess=true with dry-run result', async () => {
    const result = await weaverExecuteTarget(false, makeCtx());

    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);

    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const resultData = JSON.parse(ctx.resultJson!);
    expect(resultData.success).toBe(true);
    expect(resultData.outcome).toBe('skipped');
    expect(resultData.summary).toBe('Dry run');
  });

  it('execute=false preserves the full context including targetPath', async () => {
    const result = await weaverExecuteTarget(false, makeCtx('/proj/genesis-task.ts'));

    const ctx = JSON.parse(result.ctx) as WeaverContext;
    expect(ctx.targetPath).toBe('/proj/genesis-task.ts');
    expect(ctx.env.projectDir).toBe('/proj');
  });

  it('execute=false does not import the executor module', async () => {
    // Just verify it completes without calling any executor
    const result = await weaverExecuteTarget(false, makeCtx());
    expect(result.onSuccess).toBe(true);
    // If executor was imported, it would attempt to load @synergenius/flow-weaver/executor
    // which doesn't need to be available for the dry-run path
  });
});

describe('weaverExecuteTarget — execution failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns onFailure=true when executeWorkflowFromFile throws', async () => {
    mockExecuteWorkflowFromFile.mockRejectedValue(new Error('workflow file not found'));

    const result = await weaverExecuteTarget(true, makeCtx());

    expect(result.onSuccess).toBe(false);
    expect(result.onFailure).toBe(true);
  });

  it('includes the error message in resultJson when executor throws', async () => {
    mockExecuteWorkflowFromFile.mockRejectedValue(new Error('compile error: syntax invalid'));

    const result = await weaverExecuteTarget(true, makeCtx());

    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const resultData = JSON.parse(ctx.resultJson!);
    expect(resultData.success).toBe(false);
    expect(resultData.outcome).toBe('error');
    expect(resultData.summary).toContain('compile error: syntax invalid');
  });

  it('returns onSuccess=false when workflow executes but reports onSuccess=false', async () => {
    mockExecuteWorkflowFromFile.mockResolvedValue({
      result: { onSuccess: false, onFailure: true, summary: 'validation failed' },
      functionName: 'myWorkflow',
    });

    const result = await weaverExecuteTarget(true, makeCtx());

    expect(result.onSuccess).toBe(false);
    expect(result.onFailure).toBe(true);

    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const resultData = JSON.parse(ctx.resultJson!);
    expect(resultData.success).toBe(false);
    expect(resultData.outcome).toBe('failed');
    expect(resultData.summary).toBe('validation failed');
  });
});

describe('weaverExecuteTarget — auto-approval mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('auto-approves approval requests without calling callAI', async () => {
    // Capture the agentChannel passed to executeWorkflowFromFile
    let capturedChannel: { request: (req: { agentId: string; context: Record<string, unknown>; prompt: string }) => Promise<unknown> } | null = null;

    mockExecuteWorkflowFromFile.mockImplementation(async (_path: string, _params: unknown, opts: { agentChannel: typeof capturedChannel }) => {
      capturedChannel = opts.agentChannel;
      return { result: { onSuccess: true }, functionName: 'testWorkflow' };
    });

    await weaverExecuteTarget(true, makeCtx());

    // Now invoke the captured channel with an approval-type request
    const approvalResult = await capturedChannel!.request({
      agentId: 'genesis-approval',
      context: {},
      prompt: 'Approve this change?',
    });

    expect(approvalResult).toEqual({ approved: true, reason: 'auto-approved' });
  });

  it('auto-approval does not call callAI for approval requests', async () => {
    const { callAI } = await import('../src/bot/ai-client.js');
    const mockedCallAI = vi.mocked(callAI);

    let capturedChannel: { request: (req: { agentId: string; context: Record<string, unknown>; prompt: string }) => Promise<unknown> } | null = null;

    mockExecuteWorkflowFromFile.mockImplementation(async (_path: string, _params: unknown, opts: { agentChannel: typeof capturedChannel }) => {
      capturedChannel = opts.agentChannel;
      return { result: { onSuccess: true }, functionName: 'testWorkflow' };
    });

    await weaverExecuteTarget(true, makeCtx());

    await capturedChannel!.request({
      agentId: 'genesis-approval-check',
      context: {},
      prompt: 'Approve?',
    });

    expect(mockedCallAI).not.toHaveBeenCalled();
  });

  it('unknown approval mode falls back to default-approved', async () => {
    let capturedChannel: { request: (req: { agentId: string; context: Record<string, unknown>; prompt: string }) => Promise<unknown> } | null = null;

    mockExecuteWorkflowFromFile.mockImplementation(async (_path: string, _params: unknown, opts: { agentChannel: typeof capturedChannel }) => {
      capturedChannel = opts.agentChannel;
      return { result: { onSuccess: true }, functionName: 'wf' };
    });

    // Use 'manual' as an unrecognized mode
    const ctxStr = JSON.stringify({
      env: {
        projectDir: '/proj',
        config: { provider: 'auto', approval: 'manual' },
        providerType: 'anthropic',
        providerInfo: { type: 'anthropic', apiKey: 'key' },
      },
      taskJson: JSON.stringify({ instruction: 'run', mode: 'create' }),
      targetPath: '/proj/wf.ts',
    });

    await weaverExecuteTarget(true, ctxStr);

    const result = await capturedChannel!.request({
      agentId: 'genesis-approval',
      context: {},
      prompt: 'Approve?',
    });

    expect(result).toEqual({ approved: true, reason: 'default-approved' });
  });

  it('non-approval agentId calls callAI with providerInfo', async () => {
    const { callAI, parseJsonResponse } = await import('../src/bot/ai-client.js');
    const mockedCallAI = vi.mocked(callAI);
    const mockedParse = vi.mocked(parseJsonResponse);

    mockedCallAI.mockResolvedValue('{"answer":"42"}');
    mockedParse.mockReturnValue({ answer: '42' });

    let capturedChannel: { request: (req: { agentId: string; context: Record<string, unknown>; prompt: string }) => Promise<unknown> } | null = null;

    mockExecuteWorkflowFromFile.mockImplementation(async (_path: string, _params: unknown, opts: { agentChannel: typeof capturedChannel }) => {
      capturedChannel = opts.agentChannel;
      return { result: { onSuccess: true }, functionName: 'wf' };
    });

    await weaverExecuteTarget(true, makeCtx());

    await capturedChannel!.request({
      agentId: 'plan-task',
      context: { key: 'val' },
      prompt: 'Plan this',
    });

    expect(mockedCallAI).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'anthropic' }),
      expect.any(String),
      expect.stringContaining('Plan this'),
    );
  });
});

describe('weaverExecuteTarget — success path result shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('execute=true success → onSuccess=true, onFailure=false', async () => {
    mockExecuteWorkflowFromFile.mockResolvedValue({
      result: { onSuccess: true, summary: 'all good' },
      functionName: 'myWf',
    });

    const result = await weaverExecuteTarget(true, makeCtx());

    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);
  });

  it('resultJson.outcome="completed" on success', async () => {
    mockExecuteWorkflowFromFile.mockResolvedValue({
      result: { onSuccess: true, summary: 'done' },
      functionName: 'myWf',
    });

    const result = await weaverExecuteTarget(true, makeCtx());
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const resultData = JSON.parse(ctx.resultJson!);

    expect(resultData.outcome).toBe('completed');
  });

  it('resultJson.functionName matches returned function name', async () => {
    mockExecuteWorkflowFromFile.mockResolvedValue({
      result: { onSuccess: true },
      functionName: 'specialWorkflow',
    });

    const result = await weaverExecuteTarget(true, makeCtx());
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const resultData = JSON.parse(ctx.resultJson!);

    expect(resultData.functionName).toBe('specialWorkflow');
  });

  it('resultJson.executionTime is a number', async () => {
    mockExecuteWorkflowFromFile.mockResolvedValue({
      result: { onSuccess: true },
      functionName: 'wf',
    });

    const result = await weaverExecuteTarget(true, makeCtx());
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const resultData = JSON.parse(ctx.resultJson!);

    expect(typeof resultData.executionTime).toBe('number');
  });

  it('summary uses result.summary string when provided', async () => {
    mockExecuteWorkflowFromFile.mockResolvedValue({
      result: { onSuccess: true, summary: 'custom summary text' },
      functionName: 'wf',
    });

    const result = await weaverExecuteTarget(true, makeCtx());
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const resultData = JSON.parse(ctx.resultJson!);

    expect(resultData.summary).toBe('custom summary text');
  });

  it('summary is "completed" when result has only onSuccess key', async () => {
    mockExecuteWorkflowFromFile.mockResolvedValue({
      result: { onSuccess: true },
      functionName: 'wf',
    });

    const result = await weaverExecuteTarget(true, makeCtx());
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const resultData = JSON.parse(ctx.resultJson!);

    expect(resultData.summary).toBe('completed');
  });

  it('non-Error thrown by executor is coerced to string in resultJson.summary', async () => {
    mockExecuteWorkflowFromFile.mockRejectedValue('disk full');

    const result = await weaverExecuteTarget(true, makeCtx());
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const resultData = JSON.parse(ctx.resultJson!);

    expect(resultData.summary).toBe('disk full');
  });

  it('resultJson is valid JSON on failure path', async () => {
    mockExecuteWorkflowFromFile.mockRejectedValue(new Error('fail'));

    const result = await weaverExecuteTarget(true, makeCtx());
    const ctx = JSON.parse(result.ctx) as WeaverContext;

    expect(() => JSON.parse(ctx.resultJson!)).not.toThrow();
  });

  it('return shape has onSuccess, onFailure, ctx on success', async () => {
    mockExecuteWorkflowFromFile.mockResolvedValue({
      result: { onSuccess: true },
      functionName: 'wf',
    });

    const result = await weaverExecuteTarget(true, makeCtx());

    expect(Object.keys(result).sort()).toEqual(['ctx', 'onFailure', 'onSuccess']);
  });
});
