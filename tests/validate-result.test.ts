import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WeaverEnv } from '../src/bot/types.js';
import type { FileValidationResult } from '../src/bot/file-validator.js';

vi.mock('../src/bot/file-validator.js', () => ({
  validateFiles: vi.fn(),
}));

import { validateFiles } from '../src/bot/file-validator.js';
import { weaverValidateResult } from '../src/node-types/validate-result.js';

const mockValidateFiles = vi.mocked(validateFiles);

const ENV: WeaverEnv = {
  projectDir: '/proj',
  config: { provider: 'auto' as const },
  providerType: 'anthropic' as const,
  providerInfo: { type: 'anthropic' as const, apiKey: 'key' },
};

function makeValidResult(file: string): FileValidationResult {
  return { file, valid: true, errors: [], warnings: [] };
}

function makeInvalidResult(file: string, error = 'bad port'): FileValidationResult {
  return { file, valid: false, errors: [error], warnings: [] };
}

describe('weaverValidateResult', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  describe('empty file list', () => {
    it('returns allValid=true when filesModified is an empty array', async () => {
      mockValidateFiles.mockResolvedValue([]);

      const result = await weaverValidateResult(ENV, '{}', '{}', '[]');
      expect(result.allValid).toBe(true);
    });

    it('returns empty validationResultJson array when no files', async () => {
      mockValidateFiles.mockResolvedValue([]);

      const result = await weaverValidateResult(ENV, '{}', '{}', '[]');
      expect(JSON.parse(result.validationResultJson)).toEqual([]);
    });

    it('passes through taskJson unchanged', async () => {
      mockValidateFiles.mockResolvedValue([]);
      const task = JSON.stringify({ id: 'task-1' });

      const result = await weaverValidateResult(ENV, '{}', task, '[]');
      expect(result.taskJson).toBe(task);
    });

    it('passes through env unchanged', async () => {
      mockValidateFiles.mockResolvedValue([]);

      const result = await weaverValidateResult(ENV, '{}', '{}', '[]');
      expect(result.env).toBe(ENV);
    });
  });

  describe('all files valid', () => {
    it('returns allValid=true when all files pass', async () => {
      mockValidateFiles.mockResolvedValue([
        makeValidResult('wf.ts'),
        makeValidResult('node.ts'),
      ]);

      const result = await weaverValidateResult(ENV, '{}', '{}', JSON.stringify(['wf.ts', 'node.ts']));
      expect(result.allValid).toBe(true);
    });

    it('returns validationResultJson with results array', async () => {
      const results = [makeValidResult('wf.ts')];
      mockValidateFiles.mockResolvedValue(results);

      const result = await weaverValidateResult(ENV, '{}', '{}', JSON.stringify(['wf.ts']));
      expect(JSON.parse(result.validationResultJson)).toEqual(results);
    });

    it('calls validateFiles with correct file list and projectDir', async () => {
      mockValidateFiles.mockResolvedValue([makeValidResult('wf.ts')]);

      await weaverValidateResult(ENV, '{}', '{}', JSON.stringify(['wf.ts']));
      expect(mockValidateFiles).toHaveBeenCalledWith(['wf.ts'], '/proj');
    });

    it('logs green checkmark for valid files', async () => {
      mockValidateFiles.mockResolvedValue([makeValidResult('wf.ts')]);

      await weaverValidateResult(ENV, '{}', '{}', JSON.stringify(['wf.ts']));
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('✓'),
      );
    });

    it('logs filename for valid files', async () => {
      mockValidateFiles.mockResolvedValue([makeValidResult('wf.ts')]);

      await weaverValidateResult(ENV, '{}', '{}', JSON.stringify(['wf.ts']));
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('wf.ts'),
      );
    });
  });

  describe('validation failure', () => {
    it('throws when any file is invalid', async () => {
      mockValidateFiles.mockResolvedValue([makeInvalidResult('wf.ts', 'UNKNOWN_NODE_TYPE')]);

      await expect(
        weaverValidateResult(ENV, '{}', '{}', JSON.stringify(['wf.ts'])),
      ).rejects.toThrow('Validation failed');
    });

    it('includes failing file name in thrown error message', async () => {
      mockValidateFiles.mockResolvedValue([makeInvalidResult('bad-workflow.ts', 'parse error')]);

      await expect(
        weaverValidateResult(ENV, '{}', '{}', JSON.stringify(['bad-workflow.ts'])),
      ).rejects.toThrow('bad-workflow.ts');
    });

    it('throws even if some files are valid (partial failure)', async () => {
      mockValidateFiles.mockResolvedValue([
        makeValidResult('good.ts'),
        makeInvalidResult('bad.ts'),
      ]);

      await expect(
        weaverValidateResult(ENV, '{}', '{}', JSON.stringify(['good.ts', 'bad.ts'])),
      ).rejects.toThrow();
    });

    it('lists all failing files in error message', async () => {
      mockValidateFiles.mockResolvedValue([
        makeInvalidResult('a.ts'),
        makeInvalidResult('b.ts'),
      ]);

      await expect(
        weaverValidateResult(ENV, '{}', '{}', JSON.stringify(['a.ts', 'b.ts'])),
      ).rejects.toThrow(expect.objectContaining({ message: expect.stringContaining('a.ts') }));
    });

    it('logs red x for invalid files', async () => {
      mockValidateFiles.mockResolvedValue([makeInvalidResult('wf.ts', 'bad port')]);

      await weaverValidateResult(ENV, '{}', '{}', JSON.stringify(['wf.ts'])).catch(() => {});
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('x'),
      );
    });

    it('logs error message for invalid files', async () => {
      mockValidateFiles.mockResolvedValue([makeInvalidResult('wf.ts', 'bad port')]);

      await weaverValidateResult(ENV, '{}', '{}', JSON.stringify(['wf.ts'])).catch(() => {});
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('bad port'),
      );
    });
  });

  describe('validateFiles receives parsed file list', () => {
    it('passes multiple files to validateFiles', async () => {
      mockValidateFiles.mockResolvedValue([
        makeValidResult('a.ts'),
        makeValidResult('b.ts'),
      ]);

      await weaverValidateResult(ENV, '{}', '{}', JSON.stringify(['a.ts', 'b.ts']));
      expect(mockValidateFiles).toHaveBeenCalledWith(['a.ts', 'b.ts'], '/proj');
    });

    it('calls validateFiles exactly once', async () => {
      mockValidateFiles.mockResolvedValue([]);

      await weaverValidateResult(ENV, '{}', '{}', '[]');
      expect(mockValidateFiles).toHaveBeenCalledTimes(1);
    });
  });

  describe('pass-through fields', () => {
    it('returns env as-is', async () => {
      mockValidateFiles.mockResolvedValue([makeValidResult('wf.ts')]);

      const result = await weaverValidateResult(ENV, '{}', '{}', JSON.stringify(['wf.ts']));
      expect(result.env).toBe(ENV);
    });

    it('returns taskJson unchanged', async () => {
      mockValidateFiles.mockResolvedValue([makeValidResult('wf.ts')]);
      const task = JSON.stringify({ id: 'task-42', description: 'do stuff' });

      const result = await weaverValidateResult(ENV, '{}', task, JSON.stringify(['wf.ts']));
      expect(result.taskJson).toBe(task);
    });
  });
});
