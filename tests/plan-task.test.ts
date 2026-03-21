import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WeaverContext } from '../src/bot/types.js';

// ── Mock heavy dependencies before importing the module ───────────────────────

vi.mock('../src/bot/ai-client.js', () => ({
  callAI: vi.fn(),
  parseJsonResponse: vi.fn(),
}));

vi.mock('../src/bot/audit-logger.js', () => ({
  auditEmit: vi.fn(),
}));

vi.mock('../src/bot/system-prompt.js', () => ({
  buildSystemPrompt: vi.fn().mockResolvedValue('base system prompt'),
  buildBotSystemPrompt: vi.fn().mockReturnValue('bot system prompt'),
}));

import { weaverPlanTask } from '../src/node-types/plan-task.js';
import * as aiClient from '../src/bot/ai-client.js';
import * as auditLogger from '../src/bot/audit-logger.js';

const mockedCallAI = vi.mocked(aiClient.callAI);
const mockedParseJsonResponse = vi.mocked(aiClient.parseJsonResponse);

// ── helpers ───────────────────────────────────────────────────────────────────

function makeCtx(task: { instruction?: string; mode?: string; targets?: string[] } = {}): string {
  const context: WeaverContext = {
    env: {
      projectDir: '/project',
      config: { provider: 'auto' },
      providerType: 'anthropic',
      providerInfo: { type: 'anthropic', apiKey: 'test-key' },
    },
    taskJson: JSON.stringify({
      instruction: 'Add a new node',
      mode: 'create',
      ...task,
    }),
    contextBundle: '# Context bundle',
  };
  return JSON.stringify(context);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('weaverPlanTask — dry-run mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns onSuccess=true with empty steps and dry-run summary when execute=false', async () => {
    const result = await weaverPlanTask(false, makeCtx());

    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);

    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const plan = JSON.parse(ctx.planJson!);
    expect(plan.steps).toEqual([]);
    expect(plan.summary).toBe('dry run');
  });

  it('does not call callAI in dry-run mode', async () => {
    await weaverPlanTask(false, makeCtx());
    expect(mockedCallAI).not.toHaveBeenCalled();
  });
});

describe('weaverPlanTask — planning failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns onFailure=true when callAI throws', async () => {
    mockedCallAI.mockRejectedValue(new Error('API rate limit exceeded'));

    const result = await weaverPlanTask(true, makeCtx());

    expect(result.onSuccess).toBe(false);
    expect(result.onFailure).toBe(true);
  });

  it('includes error message in planJson summary when callAI throws', async () => {
    mockedCallAI.mockRejectedValue(new Error('network timeout'));

    const result = await weaverPlanTask(true, makeCtx());

    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const plan = JSON.parse(ctx.planJson!);
    expect(plan.summary).toContain('network timeout');
    expect(plan.steps).toEqual([]);
  });

  it('returns onFailure=true when parseJsonResponse throws', async () => {
    mockedCallAI.mockResolvedValue('not valid json response');
    mockedParseJsonResponse.mockImplementation(() => { throw new Error('invalid JSON'); });

    const result = await weaverPlanTask(true, makeCtx());

    expect(result.onSuccess).toBe(false);
    expect(result.onFailure).toBe(true);

    const ctx = JSON.parse(result.ctx) as WeaverContext;
    const plan = JSON.parse(ctx.planJson!);
    expect(plan.summary).toContain('invalid JSON');
  });
});

describe('weaverPlanTask — happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns onSuccess=true with planJson set when callAI succeeds', async () => {
    const fakePlan = {
      steps: [
        { tool: 'read-file', args: { file: 'src/workflow.ts' } },
        { tool: 'patch-file', args: { file: 'src/workflow.ts', find: 'old', replace: 'new' } },
      ],
      summary: 'Read and patch the workflow',
    };
    mockedCallAI.mockResolvedValue(JSON.stringify(fakePlan));
    mockedParseJsonResponse.mockReturnValue(fakePlan);

    const result = await weaverPlanTask(true, makeCtx({ instruction: 'Fix the workflow' }));

    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);

    const ctx = JSON.parse(result.ctx) as WeaverContext;
    expect(ctx.planJson).toBeTruthy();
    const plan = JSON.parse(ctx.planJson!);
    expect(plan.steps).toHaveLength(2);
    expect(plan.summary).toBe('Read and patch the workflow');
  });

  it('calls callAI with provider info and prompts', async () => {
    const fakePlan = { steps: [], summary: 'no-op plan' };
    mockedCallAI.mockResolvedValue('{}');
    mockedParseJsonResponse.mockReturnValue(fakePlan);

    await weaverPlanTask(true, makeCtx({ instruction: 'Do something' }));

    expect(mockedCallAI).toHaveBeenCalledOnce();
    const [pInfo, systemPrompt, userPrompt] = mockedCallAI.mock.calls[0];
    expect(pInfo).toMatchObject({ type: 'anthropic' });
    expect(systemPrompt).toContain('system prompt');
    expect(userPrompt).toContain('Do something');
  });

  it('calls auditEmit with plan-created event on success', async () => {
    const fakePlan = { steps: [{ tool: 'read-file', args: {} }], summary: 'audit test' };
    mockedCallAI.mockResolvedValue('{}');
    mockedParseJsonResponse.mockReturnValue(fakePlan);

    await weaverPlanTask(true, makeCtx());

    const mockedAuditEmit = vi.mocked(auditLogger.auditEmit);
    expect(mockedAuditEmit).toHaveBeenCalledWith('plan-created', expect.objectContaining({
      summary: 'audit test',
      stepCount: 1,
    }));
  });
});
