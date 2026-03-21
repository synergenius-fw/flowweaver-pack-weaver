import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WeaverContext } from '../src/bot/types.js';

vi.mock('../src/bot/ai-client.js', () => ({
  callAI: vi.fn(),
  parseJsonResponse: vi.fn(),
  normalizePlan: vi.fn(),
}));
vi.mock('../src/bot/audit-logger.js', () => ({
  auditEmit: vi.fn(),
}));
vi.mock('../src/bot/system-prompt.js', () => ({
  buildSystemPrompt: vi.fn(),
  buildBotSystemPrompt: vi.fn(),
}));
vi.mock('@synergenius/flow-weaver/doc-metadata', () => {
  throw new Error('doc-metadata not available');
});

import { weaverPlanTask } from '../src/node-types/plan-task.js';
import { weaverAbortTask } from '../src/node-types/abort-task.js';
import { callAI, parseJsonResponse } from '../src/bot/ai-client.js';
import { buildSystemPrompt, buildBotSystemPrompt } from '../src/bot/system-prompt.js';

const mockCallAI = vi.mocked(callAI);
const mockParseJsonResponse = vi.mocked(parseJsonResponse);
const mockBuildSystemPrompt = vi.mocked(buildSystemPrompt);
const mockBuildBotSystemPrompt = vi.mocked(buildBotSystemPrompt);

function makeCtx(overrides: Partial<WeaverContext> = {}): string {
  const context: WeaverContext = {
    env: {
      projectDir: '/proj',
      config: { provider: 'auto' } as WeaverContext['env']['config'],
      providerType: 'anthropic',
      providerInfo: { type: 'anthropic' },
    },
    taskJson: JSON.stringify({ instruction: 'Add a new feature', mode: 'create' }),
    contextBundle: '',
    ...overrides,
  };
  return JSON.stringify(context);
}

describe('weaverPlanTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildSystemPrompt.mockResolvedValue('base prompt');
    mockBuildBotSystemPrompt.mockReturnValue('bot prompt');
  });

  it('execute=false returns dry-run plan without calling AI', async () => {
    const result = await weaverPlanTask(false, makeCtx());

    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);
    expect(mockCallAI).not.toHaveBeenCalled();

    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const plan = JSON.parse(ctx.planJson!);
    expect(plan.steps).toEqual([]);
    expect(plan.summary).toBe('dry run');
  });

  it('successful AI response sets ctx.planJson and returns onSuccess', async () => {
    const fakePlan = { steps: [{ id: 's1', operation: 'run-shell', description: 'lint', args: {} }], summary: 'Run lint' };
    mockCallAI.mockResolvedValue('{}');
    mockParseJsonResponse.mockReturnValue(fakePlan);

    const result = await weaverPlanTask(true, makeCtx());

    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);
    expect(mockCallAI).toHaveBeenCalledOnce();

    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const plan = JSON.parse(ctx.planJson!);
    expect(plan.summary).toBe('Run lint');
    expect(plan.steps).toHaveLength(1);
  });

  it('callAI failure returns onFailure with error in planJson', async () => {
    mockCallAI.mockRejectedValue(new Error('provider timeout'));

    const result = await weaverPlanTask(true, makeCtx());

    expect(result.onSuccess).toBe(false);
    expect(result.onFailure).toBe(true);

    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const plan = JSON.parse(ctx.planJson!);
    expect(plan.steps).toEqual([]);
    expect(plan.summary).toContain('provider timeout');
  });

  it('parseJsonResponse throws after successful callAI returns onFailure', async () => {
    mockCallAI.mockResolvedValue('{}');
    mockParseJsonResponse.mockImplementation(() => { throw new Error('malformed JSON'); });

    const result = await weaverPlanTask(true, makeCtx());

    expect(result.onSuccess).toBe(false);
    expect(result.onFailure).toBe(true);
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const plan = JSON.parse(ctx.planJson!);
    expect(plan.summary).toContain('malformed JSON');
  });

  it('missing taskJson returns onFailure', async () => {
    const result = await weaverPlanTask(true, makeCtx({ taskJson: undefined }));

    expect(result.onSuccess).toBe(false);
    expect(result.onFailure).toBe(true);
  });

  it('system-prompt build throws → falls back to hardcoded prompt, callAI still called and returns onSuccess', async () => {
    mockBuildSystemPrompt.mockRejectedValue(new Error('system-prompt unavailable'));
    const fakePlan = { steps: [], summary: 'ok' };
    mockCallAI.mockResolvedValue('{}');
    mockParseJsonResponse.mockReturnValue(fakePlan);

    const result = await weaverPlanTask(true, makeCtx());

    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);
    expect(mockCallAI).toHaveBeenCalledOnce();

    const [, systemPromptArg] = mockCallAI.mock.calls[0] as [unknown, string, string, number];
    expect(systemPromptArg).toBe('You are Weaver, an AI workflow bot. Return ONLY valid JSON with a plan.');
  });

  it('doc-metadata import fails → cliCommands defaults to [], buildBotSystemPrompt called with empty array, planning succeeds', async () => {
    const fakePlan = { steps: [], summary: 'ok' };
    mockCallAI.mockResolvedValue('{}');
    mockParseJsonResponse.mockReturnValue(fakePlan);

    const result = await weaverPlanTask(true, makeCtx());

    expect(result.onSuccess).toBe(true);
    expect(mockBuildBotSystemPrompt).toHaveBeenCalledWith('', []);
    expect(mockCallAI).toHaveBeenCalledOnce();
  });
});

describe('weaverAbortTask', () => {
  it('sets outcome="aborted" in resultJson', () => {
    const result = weaverAbortTask(makeCtx({ rejectionReason: 'too risky' }));

    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const resultData = JSON.parse(ctx.resultJson!);
    expect(resultData.outcome).toBe('aborted');
    expect(resultData.success).toBe(false);
  });

  it('summary includes the rejectionReason', () => {
    const result = weaverAbortTask(makeCtx({ rejectionReason: 'scope too wide' }));

    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const resultData = JSON.parse(ctx.resultJson!);
    expect(resultData.summary).toContain('scope too wide');
  });

  it('sets filesModified to "[]"', () => {
    const result = weaverAbortTask(makeCtx({ rejectionReason: 'no reason' }));

    const ctx = JSON.parse(result.ctx) as WeaverContext;
    expect(ctx.filesModified).toBe('[]');
  });

  it('undefined rejectionReason produces stable summary string', () => {
    const result = weaverAbortTask(makeCtx());

    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const resultData = JSON.parse(ctx.resultJson!);
    expect(resultData.outcome).toBe('aborted');
    expect(resultData.summary).toBeDefined();
    expect(resultData.summary).not.toContain('undefined');
  });

  it('missing taskJson instruction produces summary without crash', () => {
    const result = weaverAbortTask(makeCtx({ taskJson: undefined }));

    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const resultData = JSON.parse(ctx.resultJson!);
    expect(resultData.outcome).toBe('aborted');
    expect(typeof resultData.summary).toBe('string');
  });
});
