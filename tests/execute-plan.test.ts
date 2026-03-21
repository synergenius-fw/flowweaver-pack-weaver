import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WeaverEnv } from '../src/bot/types.js';

// ── Mock step-executor ────────────────────────────────────────────────────────

vi.mock('../src/bot/step-executor.js', () => ({
  executeStep: vi.fn(),
  resetPlanFileCounter: vi.fn(),
}));

// ── Mock fs (so checkSteering returns null in most tests) ─────────────────────

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

// ── Imports after mocks ───────────────────────────────────────────────────────

import * as fs from 'node:fs';
import { executeStep, resetPlanFileCounter } from '../src/bot/step-executor.js';
import { weaverExecutePlan } from '../src/node-types/execute-plan.js';

const mockedExecuteStep = vi.mocked(executeStep);
const mockedResetPlanFileCounter = vi.mocked(resetPlanFileCounter);
const mockedExistsSync = vi.mocked(fs.existsSync);

// ── helpers ───────────────────────────────────────────────────────────────────

const BASE_ENV: WeaverEnv = {
  projectDir: '/test',
  config: { provider: 'auto' as const },
  providerType: 'anthropic' as const,
  providerInfo: { type: 'anthropic' as const, apiKey: 'key' },
};

const TASK_JSON = JSON.stringify({ instruction: 'Refactor node', targets: ['src/foo.ts'] });

function makePlan(steps: Array<{ id?: string; operation: string; description?: string; args?: Record<string, unknown> }>): string {
  return JSON.stringify({
    steps: steps.map((s, i) => ({
      id: s.id ?? `step-${i + 1}`,
      operation: s.operation,
      description: s.description ?? s.operation,
      args: s.args ?? {},
    })),
  });
}

const EMPTY_PLAN = makePlan([]);

// ── tests ─────────────────────────────────────────────────────────────────────

describe('weaverExecutePlan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // No steering file by default
    mockedExistsSync.mockReturnValue(false);
    // Default executeStep: success, modifies file
    mockedExecuteStep.mockResolvedValue({ file: 'src/foo.ts', created: false } as any);
  });

  // ── dry-run (execute=false) ──────────────────────────────────────────────────

  describe('dry-run (execute=false)', () => {
    it('returns onSuccess=true without calling executeStep', async () => {
      const result = await weaverExecutePlan(false, BASE_ENV, EMPTY_PLAN, TASK_JSON);
      expect(result.onSuccess).toBe(true);
      expect(result.onFailure).toBe(false);
      expect(mockedExecuteStep).not.toHaveBeenCalled();
    });

    it('returns executionResultJson with success=true and stepsCompleted=0', async () => {
      const result = await weaverExecutePlan(false, BASE_ENV, EMPTY_PLAN, TASK_JSON);
      const r = JSON.parse(result.executionResultJson);
      expect(r.success).toBe(true);
      expect(r.stepsCompleted).toBe(0);
      expect(r.stepsTotal).toBe(0);
    });

    it('returns filesModified as empty array', async () => {
      const result = await weaverExecutePlan(false, BASE_ENV, EMPTY_PLAN, TASK_JSON);
      expect(JSON.parse(result.filesModified)).toEqual([]);
    });

    it('passes env and taskJson through unchanged', async () => {
      const result = await weaverExecutePlan(false, BASE_ENV, EMPTY_PLAN, TASK_JSON);
      expect(result.env).toBe(BASE_ENV);
      expect(result.taskJson).toBe(TASK_JSON);
    });

    it('does not call resetPlanFileCounter', async () => {
      await weaverExecutePlan(false, BASE_ENV, EMPTY_PLAN, TASK_JSON);
      expect(mockedResetPlanFileCounter).not.toHaveBeenCalled();
    });
  });

  // ── plan with no steps ───────────────────────────────────────────────────────

  describe('plan with no steps', () => {
    it('returns onSuccess=true immediately', async () => {
      const result = await weaverExecutePlan(true, BASE_ENV, EMPTY_PLAN, TASK_JSON);
      expect(result.onSuccess).toBe(true);
      expect(result.onFailure).toBe(false);
    });

    it('returns stepsCompleted=0, stepsTotal=0, no errors', async () => {
      const result = await weaverExecutePlan(true, BASE_ENV, EMPTY_PLAN, TASK_JSON);
      const r = JSON.parse(result.executionResultJson);
      expect(r.stepsCompleted).toBe(0);
      expect(r.stepsTotal).toBe(0);
      expect(r.errors).toEqual([]);
    });

    it('calls resetPlanFileCounter', async () => {
      await weaverExecutePlan(true, BASE_ENV, EMPTY_PLAN, TASK_JSON);
      expect(mockedResetPlanFileCounter).toHaveBeenCalledOnce();
    });
  });

  // ── successful execution ─────────────────────────────────────────────────────

  describe('successful plan execution', () => {
    it('calls executeStep for each step', async () => {
      const plan = makePlan([
        { operation: 'modifyNode', description: 'Change label' },
        { operation: 'addEdge', description: 'Connect nodes' },
      ]);
      await weaverExecutePlan(true, BASE_ENV, plan, TASK_JSON);
      expect(mockedExecuteStep).toHaveBeenCalledTimes(2);
    });

    it('returns onSuccess=true when all steps succeed', async () => {
      const plan = makePlan([{ operation: 'modifyNode' }]);
      const result = await weaverExecutePlan(true, BASE_ENV, plan, TASK_JSON);
      expect(result.onSuccess).toBe(true);
      expect(result.onFailure).toBe(false);
    });

    it('includes modified file in filesModified', async () => {
      mockedExecuteStep.mockResolvedValue({ file: 'src/workflow.ts', created: false } as any);
      const plan = makePlan([{ operation: 'modifyNode' }]);
      const result = await weaverExecutePlan(true, BASE_ENV, plan, TASK_JSON);
      expect(JSON.parse(result.filesModified)).toContain('src/workflow.ts');
    });

    it('includes created file in filesModified (allFiles union)', async () => {
      mockedExecuteStep.mockResolvedValue({ file: 'src/new-node.ts', created: true } as any);
      const plan = makePlan([{ operation: 'addNode' }]);
      const result = await weaverExecutePlan(true, BASE_ENV, plan, TASK_JSON);
      expect(JSON.parse(result.filesModified)).toContain('src/new-node.ts');
    });

    it('deduplicates files when same file modified multiple times', async () => {
      mockedExecuteStep.mockResolvedValue({ file: 'src/workflow.ts', created: false } as any);
      const plan = makePlan([
        { operation: 'modifyNode', id: 'step-1' },
        { operation: 'modifyNode', id: 'step-2' },
      ]);
      const result = await weaverExecutePlan(true, BASE_ENV, plan, TASK_JSON);
      const files = JSON.parse(result.filesModified) as string[];
      expect(files.filter(f => f === 'src/workflow.ts')).toHaveLength(1);
    });

    it('sets stepsCompleted equal to number of successful steps', async () => {
      const plan = makePlan([
        { operation: 'modifyNode', id: 's1' },
        { operation: 'addEdge', id: 's2' },
      ]);
      const result = await weaverExecutePlan(true, BASE_ENV, plan, TASK_JSON);
      const r = JSON.parse(result.executionResultJson);
      expect(r.stepsCompleted).toBe(2);
    });

    it('accumulates step output lines in executionResultJson.output', async () => {
      mockedExecuteStep.mockResolvedValue({ file: 'src/foo.ts', created: false } as any);
      const plan = makePlan([
        { operation: 'modifyNode', id: 'step-1', description: 'Change label' },
        { operation: 'addEdge', id: 'step-2', description: 'Connect nodes' },
      ]);
      const result = await weaverExecutePlan(true, BASE_ENV, plan, TASK_JSON);
      const r = JSON.parse(result.executionResultJson);
      expect(r.output).toContain('step-1');
      expect(r.output).toContain('step-2');
    });

    it('passes projectDir from env to executeStep', async () => {
      const plan = makePlan([{ operation: 'modifyNode' }]);
      await weaverExecutePlan(true, BASE_ENV, plan, TASK_JSON);
      expect(mockedExecuteStep).toHaveBeenCalledWith(expect.any(Object), '/test');
    });

    it('passes env and taskJson through on success', async () => {
      const plan = makePlan([{ operation: 'modifyNode' }]);
      const result = await weaverExecutePlan(true, BASE_ENV, plan, TASK_JSON);
      expect(result.env).toBe(BASE_ENV);
      expect(result.taskJson).toBe(TASK_JSON);
    });
  });

  // ── step failures ────────────────────────────────────────────────────────────

  describe('step failure (executeStep throws)', () => {
    it('returns onSuccess=false, onFailure=true when a step throws', async () => {
      mockedExecuteStep.mockRejectedValue(new Error('compile error'));
      const plan = makePlan([{ operation: 'modifyNode' }]);
      const result = await weaverExecutePlan(true, BASE_ENV, plan, TASK_JSON);
      expect(result.onSuccess).toBe(false);
      expect(result.onFailure).toBe(true);
    });

    it('includes error message in executionResultJson.errors', async () => {
      mockedExecuteStep.mockRejectedValue(new Error('syntax error in file'));
      const plan = makePlan([{ operation: 'modifyNode', id: 'step-1' }]);
      const result = await weaverExecutePlan(true, BASE_ENV, plan, TASK_JSON);
      const r = JSON.parse(result.executionResultJson);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toContain('syntax error in file');
    });

    it('continues executing remaining steps after a single step fails', async () => {
      mockedExecuteStep
        .mockRejectedValueOnce(new Error('step 1 failed'))
        .mockResolvedValueOnce({ file: 'src/bar.ts', created: false } as any);
      const plan = makePlan([
        { operation: 'modifyNode', id: 'step-1' },
        { operation: 'addEdge', id: 'step-2' },
      ]);
      const result = await weaverExecutePlan(true, BASE_ENV, plan, TASK_JSON);
      expect(mockedExecuteStep).toHaveBeenCalledTimes(2);
      const r = JSON.parse(result.executionResultJson);
      expect(r.stepsCompleted).toBe(1);
      expect(r.errors).toHaveLength(1);
    });

    it('returns success=false in executionResultJson when errors occurred', async () => {
      mockedExecuteStep.mockRejectedValue(new Error('fail'));
      const plan = makePlan([{ operation: 'modifyNode' }]);
      const result = await weaverExecutePlan(true, BASE_ENV, plan, TASK_JSON);
      const r = JSON.parse(result.executionResultJson);
      expect(r.success).toBe(false);
    });
  });

  // ── blocked steps ─────────────────────────────────────────────────────────────

  describe('blocked step', () => {
    it('records blocked step as error and continues', async () => {
      mockedExecuteStep.mockResolvedValue({ blocked: true, blockReason: 'Safety limit exceeded' } as any);
      const plan = makePlan([{ operation: 'modifyNode', id: 'step-1' }]);
      const result = await weaverExecutePlan(true, BASE_ENV, plan, TASK_JSON);
      const r = JSON.parse(result.executionResultJson);
      expect(r.errors[0]).toContain('BLOCKED');
      expect(r.errors[0]).toContain('Safety limit exceeded');
    });

    it('returns onFailure=true when a step is blocked', async () => {
      mockedExecuteStep.mockResolvedValue({ blocked: true, blockReason: 'limit' } as any);
      const plan = makePlan([{ operation: 'modifyNode' }]);
      const result = await weaverExecutePlan(true, BASE_ENV, plan, TASK_JSON);
      expect(result.onFailure).toBe(true);
    });
  });

  // ── steering: cancel ─────────────────────────────────────────────────────────

  describe('steering cancel (pre-loop)', () => {
    it('returns onFailure=true when cancel steering is set before execution', async () => {
      mockedExistsSync.mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ command: 'cancel' }) as any);

      const plan = makePlan([{ operation: 'modifyNode' }]);
      const result = await weaverExecutePlan(true, BASE_ENV, plan, TASK_JSON);

      expect(result.onSuccess).toBe(false);
      expect(result.onFailure).toBe(true);
      expect(mockedExecuteStep).not.toHaveBeenCalled();
    });

    it('executionResultJson contains Cancelled error when steered to cancel', async () => {
      mockedExistsSync.mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ command: 'cancel' }) as any);

      const plan = makePlan([{ operation: 'modifyNode' }]);
      const result = await weaverExecutePlan(true, BASE_ENV, plan, TASK_JSON);
      const r = JSON.parse(result.executionResultJson);

      expect(r.errors).toContain('Cancelled via steering');
    });
  });

  // ── malformed steps ───────────────────────────────────────────────────────────

  describe('malformed step (missing operation)', () => {
    it('records error for step missing operation and continues to next step', async () => {
      const plan = JSON.stringify({
        steps: [
          { id: 'step-1', description: 'no op here', args: {} },
          { id: 'step-2', operation: 'modifyNode', description: 'valid step', args: {} },
        ],
      });
      const result = await weaverExecutePlan(true, BASE_ENV, plan, TASK_JSON);
      const r = JSON.parse(result.executionResultJson);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toContain('Missing "operation"');
      expect(mockedExecuteStep).toHaveBeenCalledOnce();
    });
  });
});
