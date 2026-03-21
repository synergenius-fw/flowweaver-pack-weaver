import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WeaverContext } from '../src/bot/types.js';

vi.mock('../src/bot/step-executor.js', () => ({
  executeStep: vi.fn(),
}));
vi.mock('../src/bot/file-validator.js', () => ({
  validateFiles: vi.fn(),
}));
vi.mock('../src/bot/ai-client.js', () => ({
  callAI: vi.fn(),
  parseJsonResponse: vi.fn(),
  normalizePlan: vi.fn(),
}));
vi.mock('../src/bot/audit-logger.js', () => ({
  auditEmit: vi.fn(),
}));

import { weaverExecValidateRetry } from '../src/node-types/exec-validate-retry.js';
import { executeStep } from '../src/bot/step-executor.js';
import { validateFiles } from '../src/bot/file-validator.js';
import { callAI, parseJsonResponse, normalizePlan } from '../src/bot/ai-client.js';

const mockExecuteStep = vi.mocked(executeStep);
const mockValidateFiles = vi.mocked(validateFiles);
const mockCallAI = vi.mocked(callAI);
const mockParseJsonResponse = vi.mocked(parseJsonResponse);
const mockNormalizePlan = vi.mocked(normalizePlan);

function makeCtx(plan = { steps: [] as unknown[] }): string {
  const context: WeaverContext = {
    env: {
      projectDir: '/proj',
      config: { provider: 'auto' } as WeaverContext['env']['config'],
      providerType: 'anthropic',
      providerInfo: { type: 'anthropic' },
    },
    planJson: JSON.stringify(plan),
  };
  return JSON.stringify(context);
}

function validResult() {
  return [{ file: '/proj/a.ts', valid: true, errors: [], warnings: [] }];
}

function invalidResult(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    file: `/proj/f${i}.ts`,
    valid: false,
    errors: ['error'],
    warnings: [],
  }));
}

const singleStep = {
  steps: [{ id: 'step1', operation: 'run-shell', description: 'do thing', args: {} }],
};

describe('weaverExecValidateRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns early with success when execute=false', async () => {
    const result = await weaverExecValidateRetry(false, makeCtx());

    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);
    expect(mockExecuteStep).not.toHaveBeenCalled();
    expect(mockValidateFiles).not.toHaveBeenCalled();

    const ctx = JSON.parse(result.ctx) as WeaverContext;
    expect(ctx.allValid).toBe(true);
    expect(JSON.parse(ctx.filesModified!)).toEqual([]);
    expect(JSON.parse(ctx.validationResultJson!)).toEqual([]);
  });

  it('respects maxAttempts=3 — runs all three attempts when errors decrease each time', async () => {
    // Attempts: 3 errors → 2 errors → 1 error. All attempts run.
    mockExecuteStep.mockResolvedValue({ blocked: false });
    mockValidateFiles
      .mockResolvedValueOnce(invalidResult(3)) // attempt 1
      .mockResolvedValueOnce(invalidResult(2)) // attempt 2
      .mockResolvedValueOnce(invalidResult(1)); // attempt 3

    // Fix plan calls for attempts 1 and 2 (attempt 3 doesn't trigger fix since attempt >= maxAttempts)
    const fixPlan = { steps: singleStep.steps };
    mockCallAI.mockResolvedValue('{}');
    mockParseJsonResponse.mockReturnValue(fixPlan);
    mockNormalizePlan.mockReturnValue(fixPlan as ReturnType<typeof normalizePlan>);

    await weaverExecValidateRetry(true, makeCtx(singleStep));

    expect(mockValidateFiles).toHaveBeenCalledTimes(3);
    // callAI called for attempts 1 and 2 (not 3, since attempt === maxAttempts)
    expect(mockCallAI).toHaveBeenCalledTimes(2);
  });

  it('stops retrying when errorCount does not decrease', async () => {
    mockExecuteStep.mockResolvedValue({ blocked: false });
    mockValidateFiles
      .mockResolvedValueOnce(invalidResult(2)) // attempt 1: 2 errors
      .mockResolvedValueOnce(invalidResult(2)); // attempt 2: still 2 — stop

    mockCallAI.mockResolvedValue('{}');
    mockParseJsonResponse.mockReturnValue(singleStep);
    mockNormalizePlan.mockReturnValue(singleStep as ReturnType<typeof normalizePlan>);

    const result = await weaverExecValidateRetry(true, makeCtx(singleStep));

    expect(mockValidateFiles).toHaveBeenCalledTimes(2);
    // Only 1 fix attempt (after attempt 1), stopped before attempt 3
    expect(mockCallAI).toHaveBeenCalledTimes(1);
    expect(result.onSuccess).toBe(false);
    expect(result.onFailure).toBe(true);
  });

  it('exits loop immediately on task deadline timeout', async () => {
    const now = Date.now();
    const dateSpy = vi.spyOn(globalThis.Date, 'now')
      .mockReturnValueOnce(now)                  // taskDeadline = now + 180_000
      .mockReturnValue(now + 181_000);           // all subsequent calls exceed deadline

    mockExecuteStep.mockResolvedValue({ blocked: false });
    mockValidateFiles.mockResolvedValue(validResult());

    const result = await weaverExecValidateRetry(true, makeCtx(singleStep));

    // Loop exits on the timeout check before executing any step
    expect(mockExecuteStep).not.toHaveBeenCalled();
    expect(mockValidateFiles).not.toHaveBeenCalled();
    // allValid never set to true → onFailure
    expect(result.onSuccess).toBe(false);
    expect(result.onFailure).toBe(true);

    dateSpy.mockRestore();
  });

  // ── design warnings path ─────────────────────────────────────────────────────

  describe('design warnings path', () => {
    function validWithActionableWarnings() {
      return [{
        file: '/proj/a.ts',
        valid: true as const,
        errors: [],
        warnings: ['[W001] some design warning'],
        designReport: { checks: [{ severity: 'warning', code: 'W001', message: 'some design warning' }] },
      }];
    }

    function validWithNonActionableWarnings() {
      return [{
        file: '/proj/a.ts',
        valid: true as const,
        errors: [],
        warnings: ['[I001] info note'],
        designReport: { checks: [{ severity: 'info', code: 'I001', message: 'info note' }] },
      }];
    }

    beforeEach(() => {
      mockExecuteStep.mockResolvedValue({ blocked: false } as any);
      mockCallAI.mockResolvedValue('{}');
      mockParseJsonResponse.mockReturnValue(singleStep as any);
      mockNormalizePlan.mockReturnValue(singleStep as ReturnType<typeof normalizePlan>);
    });

    it('actionable warning severity checks trigger callAI on next attempt', async () => {
      // attempt 1: allValid + actionable warnings → callAI
      // attempt 2: allValid + no warnings → prevErrorCount check (0>=0) breaks loop
      mockValidateFiles
        .mockResolvedValueOnce(validWithActionableWarnings())
        .mockResolvedValueOnce(validResult());

      const result = await weaverExecValidateRetry(true, makeCtx(singleStep));

      expect(mockCallAI).toHaveBeenCalledTimes(1);
      expect(result.onSuccess).toBe(true);
    });

    it('non-actionable severity (info) breaks loop without requesting fix plan', async () => {
      // allValid + warnings, but hasActionable=false → break immediately, no callAI
      mockValidateFiles.mockResolvedValue(validWithNonActionableWarnings());

      const result = await weaverExecValidateRetry(true, makeCtx(singleStep));

      expect(mockCallAI).not.toHaveBeenCalled();
      expect(mockValidateFiles).toHaveBeenCalledTimes(1);
      expect(result.onSuccess).toBe(true);
    });

    it('no design warnings at all breaks loop immediately after first attempt', async () => {
      // allValid + warnings=[] → designWarnings='' → allValid && !designWarnings → break
      mockValidateFiles.mockResolvedValue(validResult());

      const result = await weaverExecValidateRetry(true, makeCtx(singleStep));

      expect(mockValidateFiles).toHaveBeenCalledTimes(1);
      expect(mockCallAI).not.toHaveBeenCalled();
      expect(result.onSuccess).toBe(true);
    });

    it('on final attempt (3) with actionable warnings, breaks without requesting another fix plan', async () => {
      // Reach attempt 3 via decreasing error path, then allValid+actionable on attempt 3
      mockValidateFiles
        .mockResolvedValueOnce(invalidResult(2))          // attempt 1: 2 errors → callAI
        .mockResolvedValueOnce(invalidResult(1))          // attempt 2: 1 error  → callAI
        .mockResolvedValueOnce(validWithActionableWarnings()); // attempt 3: allValid+warnings → break (no callAI)

      const result = await weaverExecValidateRetry(true, makeCtx(singleStep));

      expect(mockValidateFiles).toHaveBeenCalledTimes(3);
      // callAI for attempts 1 and 2, but NOT attempt 3 (attempt === maxAttempts)
      expect(mockCallAI).toHaveBeenCalledTimes(2);
      expect(result.onSuccess).toBe(true);
    });
  });

  // ── fix plan generation path ──────────────────────────────────────────────────

  describe('fix plan generation path', () => {
    beforeEach(() => {
      mockExecuteStep.mockResolvedValue({ blocked: false } as any);
      mockCallAI.mockResolvedValue('{}');
      mockParseJsonResponse.mockReturnValue(singleStep as any);
      mockNormalizePlan.mockReturnValue(singleStep as ReturnType<typeof normalizePlan>);
    });

    it('callAI receives validation error details in the fix prompt', async () => {
      mockValidateFiles
        .mockResolvedValueOnce(invalidResult(1))  // attempt 1: error → callAI
        .mockResolvedValueOnce(validResult());     // attempt 2: valid → break

      await weaverExecValidateRetry(true, makeCtx(singleStep));

      expect(mockCallAI).toHaveBeenCalledOnce();
      const fixPrompt = mockCallAI.mock.calls[0][2] as string;
      expect(fixPrompt).toContain('validation errors occurred');
      expect(fixPrompt).toContain('/proj/f0.ts');
      expect(fixPrompt).toContain('error');
    });

    it('fix prompt includes "Discovery step outputs" when executeStep produced output', async () => {
      mockExecuteStep.mockResolvedValue({ output: 'stdout: compiled ok', file: 'src/foo.ts', blocked: false } as any);
      mockValidateFiles
        .mockResolvedValueOnce(invalidResult(1))
        .mockResolvedValueOnce(validResult());

      await weaverExecValidateRetry(true, makeCtx(singleStep));

      const fixPrompt = mockCallAI.mock.calls[0][2] as string;
      expect(fixPrompt).toContain('Discovery step outputs');
      expect(fixPrompt).toContain('stdout: compiled ok');
    });

    it('fix plan returned by normalizePlan replaces currentPlan for next iteration', async () => {
      const newPlan = {
        steps: [{ id: 'step-fix', operation: 'patch-file', description: 'Apply patch', args: {} }],
        summary: 'fix plan',
      };
      mockNormalizePlan.mockReturnValue(newPlan as ReturnType<typeof normalizePlan>);
      mockValidateFiles
        .mockResolvedValueOnce(invalidResult(1))
        .mockResolvedValueOnce(validResult());

      await weaverExecValidateRetry(true, makeCtx(singleStep));

      // Two executeStep calls total: attempt 1 (original singleStep) + attempt 2 (newPlan)
      expect(mockExecuteStep).toHaveBeenCalledTimes(2);
      const secondCallStep = mockExecuteStep.mock.calls[1][0] as { id: string };
      expect(secondCallStep.id).toBe('step-fix');
    });

    it('when callAI throws on fix planning, loop breaks without a further attempt', async () => {
      mockValidateFiles.mockResolvedValue(invalidResult(1));
      mockCallAI.mockRejectedValue(new Error('AI service unavailable'));

      const result = await weaverExecValidateRetry(true, makeCtx(singleStep));

      // callAI called once (attempt 1), loop breaks — no attempt 2 or 3
      expect(mockCallAI).toHaveBeenCalledOnce();
      expect(mockValidateFiles).toHaveBeenCalledOnce();
      expect(result.onSuccess).toBe(false);
      expect(result.onFailure).toBe(true);
    });

    it('stepOutputs are capped at 4000 chars before inclusion in fix prompt', async () => {
      const longOutput = 'x'.repeat(5000);
      mockExecuteStep.mockResolvedValue({ output: longOutput, blocked: false } as any);
      mockValidateFiles
        .mockResolvedValueOnce(invalidResult(1))
        .mockResolvedValueOnce(validResult());

      await weaverExecValidateRetry(true, makeCtx(singleStep));

      const fixPrompt = mockCallAI.mock.calls[0][2] as string;
      // The longest run of 'x' in the prompt must be exactly 4000 (capped), not 5000
      const longestRun = fixPrompt.match(/x+/)?.[0] ?? '';
      expect(longestRun.length).toBe(4000);
    });
  });

  // ── task timeout and stepLog accumulation ────────────────────────────────────

  describe('task timeout and stepLog accumulation', () => {
    /**
     * Returns a Date.now spy that:
     *   - 1st call: returns `base` (used to compute taskDeadline = base + 180_000)
     *   - 2nd call: returns `attempt1Value` (attempt 1 timeout check)
     *   - all further calls: return `laterValue`
     */
    function mockDateNow(base: number, attempt1Value: number, laterValue: number) {
      return vi.spyOn(globalThis.Date, 'now')
        .mockReturnValueOnce(base)
        .mockReturnValueOnce(attempt1Value)
        .mockReturnValue(laterValue);
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('timeout fires at attempt 2 check — only attempt 1 runs', async () => {
      const base = 1_000;
      // attempt 1 check: base (within deadline); attempt 2 check: base+181k (exceeds deadline)
      const spy = mockDateNow(base, base, base + 181_000);

      mockExecuteStep.mockResolvedValue({ file: '/proj/attempt1.ts', blocked: false } as any);
      mockValidateFiles.mockResolvedValue(invalidResult(1));

      await weaverExecValidateRetry(true, makeCtx(singleStep));

      // Exactly one validateFiles call (attempt 1 only)
      expect(mockValidateFiles).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it('result filesModified contains only files from completed attempt 1', async () => {
      const base = 1_000;
      const spy = mockDateNow(base, base, base + 181_000);

      mockExecuteStep.mockResolvedValue({ file: '/proj/only-attempt1.ts', blocked: false } as any);
      mockValidateFiles.mockResolvedValue(invalidResult(1));

      const result = await weaverExecValidateRetry(true, makeCtx(singleStep));

      const ctx = JSON.parse(result.ctx) as WeaverContext;
      const files = JSON.parse(ctx.filesModified!) as string[];
      expect(files).toContain('/proj/only-attempt1.ts');
      // Only one attempt ran, so length is 1
      expect(files).toHaveLength(1);
      spy.mockRestore();
    });

    it('context.allValid reflects validation result from last completed attempt', async () => {
      const base = 1_000;
      const spy = mockDateNow(base, base, base + 181_000);

      mockExecuteStep.mockResolvedValue({ blocked: false } as any);
      // Attempt 1 returns invalid → allValid = false
      mockValidateFiles.mockResolvedValue(invalidResult(2));

      const result = await weaverExecValidateRetry(true, makeCtx(singleStep));

      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(ctx.allValid).toBe(false);
      expect(result.onSuccess).toBe(false);
      expect(result.onFailure).toBe(true);
      spy.mockRestore();
    });

    it('exact boundary: taskDeadline = Date.now() + 180000ms — equal is NOT a timeout', async () => {
      const base = 1_000;
      // Spy: 1st call=base (deadline=base+180k), 2nd call=base+180k (NOT > deadline), 3rd+ = base+181k
      const spy = vi.spyOn(globalThis.Date, 'now')
        .mockReturnValueOnce(base)
        .mockReturnValueOnce(base + 180_000)  // attempt 1: equal → NOT > deadline → runs
        .mockReturnValue(base + 181_000);     // attempt 2+: exceeds → break

      mockExecuteStep.mockResolvedValue({ blocked: false } as any);
      mockValidateFiles.mockResolvedValue(invalidResult(1));

      await weaverExecValidateRetry(true, makeCtx(singleStep));

      // Attempt 1 must have run (equal is not a timeout)
      expect(mockValidateFiles).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it('all 3 attempts within deadline accumulate stepLog entries in context', async () => {
      // 3 attempts: 2errors → 1error → valid. No timeout.
      mockExecuteStep.mockResolvedValue({ blocked: false } as any);
      mockValidateFiles
        .mockResolvedValueOnce(invalidResult(2))  // attempt 1
        .mockResolvedValueOnce(invalidResult(1))  // attempt 2
        .mockResolvedValueOnce(validResult());     // attempt 3 → break

      mockCallAI.mockResolvedValue('{}');
      mockParseJsonResponse.mockReturnValue(singleStep as any);
      mockNormalizePlan.mockReturnValue(singleStep as ReturnType<typeof normalizePlan>);

      const result = await weaverExecValidateRetry(true, makeCtx(singleStep));

      const ctx = JSON.parse(result.ctx) as WeaverContext;
      const stepLog = JSON.parse(ctx.stepLogJson!) as Array<{ step: string; status: string }>;
      // Each attempt executes singleStep (1 step per attempt × 3 attempts = 3 entries)
      expect(stepLog).toHaveLength(3);
      expect(stepLog.every(e => e.step === 'step1')).toBe(true);
    });
  });

  it('steering cancel signal breaks the step loop without calling executeStep', async () => {
    // Write cancel signal to tmp home dir
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-cancel-'));
    const weaverDir = path.join(tmpHome, '.weaver');
    fs.mkdirSync(weaverDir, { recursive: true });
    fs.writeFileSync(path.join(weaverDir, 'control.json'), JSON.stringify({ command: 'cancel' }));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;

    try {
      mockValidateFiles.mockResolvedValue([]);

      const result = await weaverExecValidateRetry(true, makeCtx(singleStep));

      // executeStep never called — steering cancelled before reaching it
      expect(mockExecuteStep).not.toHaveBeenCalled();

      // stepLogJson contains the cancel entry
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      const stepLog = JSON.parse(ctx.stepLogJson!) as Array<{ step: string; status: string; detail: string }>;
      expect(stepLog.length).toBe(1);
      expect(stepLog[0].status).toBe('error');
      expect(stepLog[0].detail).toContain('Cancelled');
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
