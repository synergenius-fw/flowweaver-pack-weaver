import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WeaverContext } from '../src/bot/types.js';

const { mockExecFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFileSync: mockExecFileSync };
});

import { weaverValidateGate } from '../src/node-types/validate-gate.js';

function makeCtx(overrides: Partial<WeaverContext> = {}): string {
  const ctx: WeaverContext = {
    env: {
      projectDir: '/proj',
      config: { provider: 'auto' as const },
      providerType: 'anthropic' as const,
      providerInfo: { type: 'anthropic' as const, apiKey: 'key' },
    },
    taskJson: '{}',
    hasTask: true,
    ...overrides,
  };
  return JSON.stringify(ctx);
}

describe('weaverValidateGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  describe('no filesModified (or empty)', () => {
    it('returns onSuccess=true when filesModified is absent', () => {
      const result = weaverValidateGate(makeCtx());
      expect(result.onSuccess).toBe(true);
      expect(result.onFailure).toBe(false);
    });

    it('does not call execFileSync when filesModified is absent', () => {
      weaverValidateGate(makeCtx());
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('sets validationResultJson with skipped=true when no files', () => {
      const result = weaverValidateGate(makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      const vr = JSON.parse(ctx.validationResultJson!);
      expect(vr.skipped).toBe(true);
      expect(vr.reason).toContain('no files modified');
    });

    it('returns onSuccess=true when filesModified is an empty array', () => {
      const result = weaverValidateGate(makeCtx({ filesModified: JSON.stringify([]) }));
      expect(result.onSuccess).toBe(true);
    });

    it('returns onSuccess=true when filesModified has only non-.ts files', () => {
      const result = weaverValidateGate(makeCtx({ filesModified: JSON.stringify(['README.md', 'package.json']) }));
      expect(result.onSuccess).toBe(true);
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('sets skipped reason to "no .ts files" for non-ts files', () => {
      const result = weaverValidateGate(makeCtx({ filesModified: JSON.stringify(['file.json']) }));
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      const vr = JSON.parse(ctx.validationResultJson!);
      expect(vr.reason).toContain('no .ts files');
    });
  });

  describe('all files valid', () => {
    it('returns onSuccess=true when validate returns 0 errors', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify({ errorCount: 0, errors: [] }));

      const result = weaverValidateGate(makeCtx({ filesModified: JSON.stringify(['workflow.ts']) }));
      expect(result.onSuccess).toBe(true);
      expect(result.onFailure).toBe(false);
    });

    it('calls npx flow-weaver validate for each .ts file', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify({ errorCount: 0 }));

      weaverValidateGate(makeCtx({ filesModified: JSON.stringify(['a.ts', 'b.ts']) }));
      const validateCalls = mockExecFileSync.mock.calls.filter(
        (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('validate'),
      );
      expect(validateCalls).toHaveLength(2);
    });

    it('sets allValid=true on ctx when all pass', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify({ errorCount: 0 }));

      const result = weaverValidateGate(makeCtx({ filesModified: JSON.stringify(['wf.ts']) }));
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(ctx.allValid).toBe(true);
    });

    it('sets validationResultJson.allValid=true', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify({ errorCount: 0 }));

      const result = weaverValidateGate(makeCtx({ filesModified: JSON.stringify(['wf.ts']) }));
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      const vr = JSON.parse(ctx.validationResultJson!);
      expect(vr.allValid).toBe(true);
    });

    it('skips non-.ts files (json, md) even when mixed with .ts', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify({ errorCount: 0 }));

      weaverValidateGate(makeCtx({ filesModified: JSON.stringify(['wf.ts', 'notes.md']) }));
      // 1 call for flow-weaver validate + 1 call for tsc --noEmit
      expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    });
  });

  describe('validation failure', () => {
    it('returns onFailure=true when a file has errors', () => {
      mockExecFileSync.mockReturnValue(
        JSON.stringify({ errorCount: 2, errors: [{ message: 'bad port' }, { message: 'missing node' }] }),
      );

      const result = weaverValidateGate(makeCtx({ filesModified: JSON.stringify(['wf.ts']) }));
      expect(result.onFailure).toBe(true);
      expect(result.onSuccess).toBe(false);
    });

    it('sets allValid=false on ctx', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify({ errorCount: 1, errors: [{ message: 'err' }] }));

      const result = weaverValidateGate(makeCtx({ filesModified: JSON.stringify(['wf.ts']) }));
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(ctx.allValid).toBe(false);
    });

    it('records error messages in validationResultJson.errors', () => {
      mockExecFileSync.mockReturnValue(
        JSON.stringify({ errorCount: 1, errors: [{ message: 'UNKNOWN_NODE_TYPE' }] }),
      );

      const result = weaverValidateGate(makeCtx({ filesModified: JSON.stringify(['wf.ts']) }));
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      const vr = JSON.parse(ctx.validationResultJson!);
      expect(vr.errors[0].errors[0]).toContain('UNKNOWN_NODE_TYPE');
    });

    it('records errorCount per file', () => {
      mockExecFileSync.mockReturnValue(JSON.stringify({ errorCount: 3, errors: [] }));

      const result = weaverValidateGate(makeCtx({ filesModified: JSON.stringify(['wf.ts']) }));
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      const vr = JSON.parse(ctx.validationResultJson!);
      expect(vr.errors[0].errorCount).toBe(3);
    });

    it('uses errors.length when errorCount is absent', () => {
      mockExecFileSync.mockReturnValue(
        JSON.stringify({ errors: [{ message: 'e1' }, { message: 'e2' }] }),
      );

      const result = weaverValidateGate(makeCtx({ filesModified: JSON.stringify(['wf.ts']) }));
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      const vr = JSON.parse(ctx.validationResultJson!);
      expect(vr.errors[0].errorCount).toBe(2);
    });

    it('handles partial failure: one file fails, one passes → onFailure=true', () => {
      mockExecFileSync
        .mockReturnValueOnce(JSON.stringify({ errorCount: 0 }))
        .mockReturnValueOnce(JSON.stringify({ errorCount: 1, errors: [{ message: 'fail' }] }));

      const result = weaverValidateGate(
        makeCtx({ filesModified: JSON.stringify(['good.ts', 'bad.ts']) }),
      );
      expect(result.onFailure).toBe(true);
    });
  });

  describe('execFileSync throws (command error)', () => {
    it('returns onFailure=true when validate command throws', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('parse error'); });

      const result = weaverValidateGate(makeCtx({ filesModified: JSON.stringify(['wf.ts']) }));
      expect(result.onFailure).toBe(true);
    });

    it('records the thrown error message', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('tsc failed'); });

      const result = weaverValidateGate(makeCtx({ filesModified: JSON.stringify(['wf.ts']) }));
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      const vr = JSON.parse(ctx.validationResultJson!);
      expect(vr.errors[0].errors[0]).toContain('tsc failed');
    });

    it('ignores "No @flowWeaver annotation" errors (not a workflow file)', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('No @flowWeaver annotation found');
      });

      const result = weaverValidateGate(makeCtx({ filesModified: JSON.stringify(['helper.ts']) }));
      expect(result.onSuccess).toBe(true);
    });

    it('ignores "not a workflow" errors', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('helper.ts is not a workflow');
      });

      const result = weaverValidateGate(makeCtx({ filesModified: JSON.stringify(['helper.ts']) }));
      expect(result.onSuccess).toBe(true);
    });
  });

  describe('non-JSON output from validate', () => {
    it('treats text with "error" as a failure', () => {
      mockExecFileSync.mockReturnValue('Parse error: 1 error found');

      const result = weaverValidateGate(makeCtx({ filesModified: JSON.stringify(['wf.ts']) }));
      expect(result.onFailure).toBe(true);
    });

    it('treats "0 error" text as success', () => {
      mockExecFileSync.mockReturnValue('Validated with 0 errors');

      const result = weaverValidateGate(makeCtx({ filesModified: JSON.stringify(['wf.ts']) }));
      expect(result.onSuccess).toBe(true);
    });
  });

  describe('WEAVER_VERBOSE stderr logging', () => {
    it('writes to stderr when WEAVER_VERBOSE is set and validation fails', () => {
      vi.stubEnv('WEAVER_VERBOSE', '1');
      mockExecFileSync.mockReturnValue(
        JSON.stringify({ errorCount: 1, errors: [{ message: 'bad' }] }),
      );

      weaverValidateGate(makeCtx({ filesModified: JSON.stringify(['wf.ts']) }));
      expect(vi.mocked(process.stderr.write)).toHaveBeenCalled();

      vi.unstubAllEnvs();
    });

    it('does not write to stderr when WEAVER_VERBOSE is unset', () => {
      vi.unstubAllEnvs();
      mockExecFileSync.mockReturnValue(
        JSON.stringify({ errorCount: 1, errors: [{ message: 'bad' }] }),
      );

      weaverValidateGate(makeCtx({ filesModified: JSON.stringify(['wf.ts']) }));
      expect(vi.mocked(process.stderr.write)).not.toHaveBeenCalled();
    });
  });

  describe('ctx pass-through', () => {
    it('preserves env fields on returned ctx', () => {
      const result = weaverValidateGate(makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(ctx.env.projectDir).toBe('/proj');
    });

    it('returns a valid JSON string as ctx', () => {
      const result = weaverValidateGate(makeCtx());
      expect(() => JSON.parse(result.ctx)).not.toThrow();
    });
  });
});
