import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WeaverContext } from '../src/bot/types.js';
import { weaverReport } from '../src/node-types/report.js';

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
    targetPath: '/proj/src/workflows/my-workflow.ts',
    resultJson: JSON.stringify({ outcome: 'success', summary: 'All done' }),
    ...overrides,
  };
  return JSON.stringify(ctx);
}

describe('weaverReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  describe('summary format', () => {
    it('includes outcome in summary', () => {
      const result = weaverReport(makeCtx({
        resultJson: JSON.stringify({ outcome: 'success', summary: 'All done' }),
      }));
      expect(result.summary).toContain('success');
    });

    it('includes relative path of targetPath in summary', () => {
      const result = weaverReport(makeCtx({
        targetPath: '/proj/src/workflows/my-workflow.ts',
        resultJson: JSON.stringify({ outcome: 'success', summary: 'Done' }),
      }));
      expect(result.summary).toContain('src/workflows/my-workflow.ts');
    });

    it('includes result.summary text', () => {
      const result = weaverReport(makeCtx({
        resultJson: JSON.stringify({ outcome: 'success', summary: 'Node added successfully' }),
      }));
      expect(result.summary).toContain('Node added successfully');
    });

    it('includes executionTime when present', () => {
      const result = weaverReport(makeCtx({
        resultJson: JSON.stringify({ outcome: 'success', summary: 'Done', executionTime: 3.14 }),
      }));
      expect(result.summary).toContain('3.14');
    });

    it('omits Time line when executionTime is absent', () => {
      const result = weaverReport(makeCtx({
        resultJson: JSON.stringify({ outcome: 'success', summary: 'Done' }),
      }));
      expect(result.summary).not.toContain('Time:');
    });

    it('returns object with summary string', () => {
      const result = weaverReport(makeCtx());
      expect(typeof result.summary).toBe('string');
      expect(result.summary.length).toBeGreaterThan(0);
    });
  });

  describe('relative path resolution', () => {
    it('makes path relative to projectDir', () => {
      const result = weaverReport(makeCtx({
        targetPath: '/proj/deep/nested/file.ts',
        resultJson: JSON.stringify({ outcome: 'ok', summary: 'x' }),
      }));
      expect(result.summary).toContain('deep/nested/file.ts');
      expect(result.summary).not.toContain('/proj/deep');
    });

    it('handles targetPath already relative-looking (same dir)', () => {
      const result = weaverReport(makeCtx({
        targetPath: '/proj/workflow.ts',
        resultJson: JSON.stringify({ outcome: 'ok', summary: 'x' }),
      }));
      expect(result.summary).toContain('workflow.ts');
    });
  });

  describe('logging', () => {
    it('logs a line containing the outcome', () => {
      weaverReport(makeCtx({
        resultJson: JSON.stringify({ outcome: 'applied', summary: 'Done' }),
      }));
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('applied'),
      );
    });

    it('logs with green checkmark ANSI prefix', () => {
      weaverReport(makeCtx());
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('✓'),
      );
    });
  });

  describe('multi-line output', () => {
    it('summary contains newline separating outcome line from detail', () => {
      const result = weaverReport(makeCtx({
        resultJson: JSON.stringify({ outcome: 'success', summary: 'Some detail' }),
      }));
      expect(result.summary).toContain('\n');
      expect(result.summary.split('\n')[1]).toContain('Some detail');
    });
  });
});
