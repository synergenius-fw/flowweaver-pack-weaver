import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WeaverEnv } from '../src/bot/types.js';

vi.mock('../src/bot/ai-client.js', () => ({
  callAI: vi.fn(),
  parseJsonResponse: vi.fn(),
  normalizePlan: vi.fn(),
}));

import { weaverFixErrors } from '../src/node-types/fix-errors.js';
import { callAI, parseJsonResponse, normalizePlan } from '../src/bot/ai-client.js';

const mockCallAI = vi.mocked(callAI);
const mockParseJsonResponse = vi.mocked(parseJsonResponse);
const mockNormalizePlan = vi.mocked(normalizePlan);

function makeEnv(): WeaverEnv {
  return {
    projectDir: '/proj',
    config: { provider: 'auto' },
    providerType: 'anthropic',
    providerInfo: { type: 'anthropic', apiKey: 'test-key', model: 'claude-sonnet-4-6' },
  };
}

const taskJson = JSON.stringify({ instruction: 'fix the workflow', mode: 'modify' });

describe('weaverFixErrors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('execute=false returns onSuccess=true with dry-run fixPlanJson without calling AI', async () => {
    const result = await weaverFixErrors(false, makeEnv(), '[]', taskJson);

    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);
    expect(mockCallAI).not.toHaveBeenCalled();

    const plan = JSON.parse(result.fixPlanJson);
    expect(plan.steps).toEqual([]);
    expect(plan.summary).toBe('dry run');
    expect(result.taskJson).toBe(taskJson);
    expect(result.env).toEqual(makeEnv());
  });

  it('no validation errors → returns onSuccess=true without calling AI', async () => {
    const noErrors = JSON.stringify([
      { file: 'a.ts', valid: true, errors: [] },
      { file: 'b.ts', valid: true, errors: [] },
    ]);

    const result = await weaverFixErrors(true, makeEnv(), noErrors, taskJson);

    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);
    expect(mockCallAI).not.toHaveBeenCalled();

    const plan = JSON.parse(result.fixPlanJson);
    expect(plan.summary).toBe('no errors to fix');
  });

  it('validation errors → calls AI and returns fix plan on success', async () => {
    const withErrors = JSON.stringify([
      { file: 'bad.ts', valid: false, errors: ['UNKNOWN_SOURCE_PORT: bad port'] },
    ]);
    const rawPlan = { steps: [{ id: 's1', operation: 'patch-file', description: 'fix port', args: {} }], summary: 'Fix port' };
    mockCallAI.mockResolvedValue('{}');
    mockParseJsonResponse.mockReturnValue(rawPlan);
    mockNormalizePlan.mockReturnValue(rawPlan);

    const result = await weaverFixErrors(true, makeEnv(), withErrors, taskJson);

    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);
    expect(mockCallAI).toHaveBeenCalledOnce();

    const plan = JSON.parse(result.fixPlanJson);
    expect(plan.summary).toBe('Fix port');
    expect(plan.steps).toHaveLength(1);
  });

  it('AI failure returns onFailure=true with error summary in fixPlanJson', async () => {
    const withErrors = JSON.stringify([
      { file: 'bad.ts', valid: false, errors: ['CYCLE_DETECTED'] },
    ]);
    mockCallAI.mockRejectedValue(new Error('provider timeout'));

    const result = await weaverFixErrors(true, makeEnv(), withErrors, taskJson);

    expect(result.onSuccess).toBe(false);
    expect(result.onFailure).toBe(true);

    const plan = JSON.parse(result.fixPlanJson);
    expect(plan.steps).toEqual([]);
    expect(plan.summary).toContain('provider timeout');
  });

  it('passes env and taskJson through on both success and failure paths', async () => {
    const noErrors = JSON.stringify([{ file: 'ok.ts', valid: true, errors: [] }]);
    const result = await weaverFixErrors(true, makeEnv(), noErrors, taskJson);

    expect(result.env).toEqual(makeEnv());
    expect(result.taskJson).toBe(taskJson);
  });

  it('callAI is called with the providerInfo from env', async () => {
    const withErrors = JSON.stringify([{ file: 'bad.ts', valid: false, errors: ['err'] }]);
    const plan = { steps: [], summary: 'ok' };
    mockCallAI.mockResolvedValue('{}');
    mockParseJsonResponse.mockReturnValue(plan);
    mockNormalizePlan.mockReturnValue(plan);

    await weaverFixErrors(true, makeEnv(), withErrors, taskJson);

    expect(mockCallAI).toHaveBeenCalledWith(
      makeEnv().providerInfo,
      expect.any(String),
      expect.any(String),
      8192,
    );
  });

  it('parseJsonResponse is called with the raw AI text', async () => {
    const withErrors = JSON.stringify([{ file: 'bad.ts', valid: false, errors: ['err'] }]);
    const plan = { steps: [], summary: 'ok' };
    mockCallAI.mockResolvedValue('{"steps":[],"summary":"ok"}');
    mockParseJsonResponse.mockReturnValue(plan);
    mockNormalizePlan.mockReturnValue(plan);

    await weaverFixErrors(true, makeEnv(), withErrors, taskJson);

    expect(mockParseJsonResponse).toHaveBeenCalledWith('{"steps":[],"summary":"ok"}');
  });

  it('normalizePlan is called with the parseJsonResponse result', async () => {
    const withErrors = JSON.stringify([{ file: 'bad.ts', valid: false, errors: ['err'] }]);
    const parsedRaw = { steps: [{ id: 's1', operation: 'patch-file', description: 'd', args: {} }], summary: 'parsed' };
    const normalized = { steps: parsedRaw.steps, summary: 'normalized' };
    mockCallAI.mockResolvedValue('{}');
    mockParseJsonResponse.mockReturnValue(parsedRaw);
    mockNormalizePlan.mockReturnValue(normalized);

    const result = await weaverFixErrors(true, makeEnv(), withErrors, taskJson);

    expect(mockNormalizePlan).toHaveBeenCalledWith(parsedRaw);
    const plan = JSON.parse(result.fixPlanJson);
    expect(plan.summary).toBe('normalized');
  });

  it('AI prompt includes the error file and message', async () => {
    const withErrors = JSON.stringify([{ file: 'src/workflows/bad.ts', valid: false, errors: ['MISSING_REQUIRED_INPUT'] }]);
    const plan = { steps: [], summary: 'ok' };
    mockCallAI.mockResolvedValue('{}');
    mockParseJsonResponse.mockReturnValue(plan);
    mockNormalizePlan.mockReturnValue(plan);

    await weaverFixErrors(true, makeEnv(), withErrors, taskJson);

    const userPrompt = mockCallAI.mock.calls[0][2] as string;
    expect(userPrompt).toContain('src/workflows/bad.ts');
    expect(userPrompt).toContain('MISSING_REQUIRED_INPUT');
  });

  it('AI prompt includes all errors from multiple files', async () => {
    const withErrors = JSON.stringify([
      { file: 'a.ts', valid: false, errors: ['ERROR_A'] },
      { file: 'b.ts', valid: false, errors: ['ERROR_B'] },
    ]);
    const plan = { steps: [], summary: 'ok' };
    mockCallAI.mockResolvedValue('{}');
    mockParseJsonResponse.mockReturnValue(plan);
    mockNormalizePlan.mockReturnValue(plan);

    await weaverFixErrors(true, makeEnv(), withErrors, taskJson);

    const userPrompt = mockCallAI.mock.calls[0][2] as string;
    expect(userPrompt).toContain('a.ts');
    expect(userPrompt).toContain('ERROR_A');
    expect(userPrompt).toContain('b.ts');
    expect(userPrompt).toContain('ERROR_B');
  });

  it('env is pass-through on AI failure path', async () => {
    const withErrors = JSON.stringify([{ file: 'bad.ts', valid: false, errors: ['err'] }]);
    mockCallAI.mockRejectedValue(new Error('network error'));

    const result = await weaverFixErrors(true, makeEnv(), withErrors, taskJson);

    expect(result.env).toEqual(makeEnv());
  });

  it('taskJson is pass-through on AI failure path', async () => {
    const withErrors = JSON.stringify([{ file: 'bad.ts', valid: false, errors: ['err'] }]);
    mockCallAI.mockRejectedValue(new Error('network error'));

    const result = await weaverFixErrors(true, makeEnv(), withErrors, taskJson);

    expect(result.taskJson).toBe(taskJson);
  });

  it('fixPlanJson is valid JSON on AI failure', async () => {
    const withErrors = JSON.stringify([{ file: 'bad.ts', valid: false, errors: ['err'] }]);
    mockCallAI.mockRejectedValue(new Error('timeout'));

    const result = await weaverFixErrors(true, makeEnv(), withErrors, taskJson);

    expect(() => JSON.parse(result.fixPlanJson)).not.toThrow();
  });

  it('fixPlanJson.summary contains "Fix failed:" on AI error', async () => {
    const withErrors = JSON.stringify([{ file: 'bad.ts', valid: false, errors: ['err'] }]);
    mockCallAI.mockRejectedValue(new Error('timeout'));

    const result = await weaverFixErrors(true, makeEnv(), withErrors, taskJson);

    const plan = JSON.parse(result.fixPlanJson);
    expect(plan.summary).toContain('Fix failed:');
    expect(plan.summary).toContain('timeout');
  });

  it('fixPlanJson on success contains the steps from normalizePlan', async () => {
    const withErrors = JSON.stringify([{ file: 'bad.ts', valid: false, errors: ['err'] }]);
    const plan = {
      steps: [
        { id: 'fix-1', operation: 'patch-file', description: 'patch annotation', args: { file: 'bad.ts', patches: [] } },
      ],
      summary: 'Fix annotation',
    };
    mockCallAI.mockResolvedValue('{}');
    mockParseJsonResponse.mockReturnValue(plan);
    mockNormalizePlan.mockReturnValue(plan);

    const result = await weaverFixErrors(true, makeEnv(), withErrors, taskJson);

    const parsed = JSON.parse(result.fixPlanJson);
    expect(parsed.steps).toHaveLength(1);
    expect(parsed.steps[0].id).toBe('fix-1');
  });

  it('dry run: fixPlanJson has empty steps', async () => {
    const result = await weaverFixErrors(false, makeEnv(), '[]', taskJson);
    const plan = JSON.parse(result.fixPlanJson);
    expect(plan.steps).toEqual([]);
  });
});
