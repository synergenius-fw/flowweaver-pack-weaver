import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { DesignReport } from '../src/bot/design-checker.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFwValidate = vi.fn();
const mockCheckDesignQuality = vi.fn();

vi.mock('../src/bot/fw-api.js', () => ({
  fwValidate: (...args: unknown[]) => mockFwValidate(...args),
}));

vi.mock('../src/bot/design-checker.js', () => ({
  checkDesignQuality: (...args: unknown[]) => mockCheckDesignQuality(...args),
}));

// Import AFTER mocks are set up
const { validateFiles } = await import('../src/bot/file-validator.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeValidateResult(overrides?: Record<string, unknown>) {
  return {
    valid: true,
    errors: [],
    warnings: [],
    ast: { instances: [], connections: [], nodeTypes: [] },
    ...overrides,
  };
}

function makeDesignReport(overrides?: Partial<DesignReport>): DesignReport {
  return {
    score: 100,
    checks: [],
    passed: 0,
    failed: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckDesignQuality.mockReturnValue(makeDesignReport());
  });

  it('returns empty array for empty file list', async () => {
    const results = await validateFiles([], '/project');
    expect(results).toEqual([]);
    expect(mockFwValidate).not.toHaveBeenCalled();
  });

  it('skips non-TypeScript files', async () => {
    const results = await validateFiles(
      ['readme.md', 'style.css', 'data.json', 'script.js'],
      '/project',
    );
    expect(results).toEqual([]);
    expect(mockFwValidate).not.toHaveBeenCalled();
  });

  it('processes .ts files and skips others in mixed list', async () => {
    mockFwValidate.mockResolvedValue(makeValidateResult());

    const results = await validateFiles(
      ['readme.md', 'workflow.ts', 'style.css'],
      '/project',
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.file).toBe('workflow.ts');
    expect(mockFwValidate).toHaveBeenCalledTimes(1);
    expect(mockFwValidate).toHaveBeenCalledWith('workflow.ts');
  });

  it('returns invalid result when fwValidate reports errors', async () => {
    mockFwValidate.mockResolvedValue(makeValidateResult({
      valid: false,
      errors: ['Missing node type definition'],
      warnings: ['Unused port'],
    }));

    const results = await validateFiles(['broken.ts'], '/project');

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      file: 'broken.ts',
      valid: false,
      errors: ['Missing node type definition'],
      warnings: ['Unused port'],
    });
    // Should NOT run design checks on invalid files
    expect(mockCheckDesignQuality).not.toHaveBeenCalled();
  });

  it('returns valid result with design warnings merged', async () => {
    const ast = { instances: [], connections: [], nodeTypes: [] };
    mockFwValidate.mockResolvedValue(makeValidateResult({
      warnings: ['fw-warning'],
      ast,
    }));
    mockCheckDesignQuality.mockReturnValue(makeDesignReport({
      checks: [
        { code: 'WEAVER_GENERIC_NODE_ID', severity: 'warning', message: 'Generic ID' },
        { code: 'WEAVER_NO_DESCRIPTION', severity: 'info', message: 'No description' },
      ],
    }));

    const results = await validateFiles(['good.ts'], '/project');

    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    // fw-warning from validator + design warning (only warning/error severity, not info)
    expect(result.warnings).toEqual([
      'fw-warning',
      '[WEAVER_GENERIC_NODE_ID] Generic ID',
    ]);
    expect(result.designReport).toBeDefined();
    expect(mockCheckDesignQuality).toHaveBeenCalledWith(ast);
  });

  it('includes design checks with error severity in warnings', async () => {
    mockFwValidate.mockResolvedValue(makeValidateResult());
    mockCheckDesignQuality.mockReturnValue(makeDesignReport({
      checks: [
        { code: 'WEAVER_TOO_MANY_NODES', severity: 'error', message: '60 nodes' },
      ],
    }));

    const results = await validateFiles(['big.ts'], '/project');

    expect(results[0]!.warnings).toContain('[WEAVER_TOO_MANY_NODES] 60 nodes');
  });

  it('excludes design checks with info severity from warnings', async () => {
    mockFwValidate.mockResolvedValue(makeValidateResult());
    mockCheckDesignQuality.mockReturnValue(makeDesignReport({
      checks: [
        { code: 'WEAVER_MISSING_VISUALS', severity: 'info', message: 'No color' },
      ],
    }));

    const results = await validateFiles(['clean.ts'], '/project');

    expect(results[0]!.warnings).toEqual([]);
  });

  it('catches errors thrown by fwValidate and wraps them', async () => {
    mockFwValidate.mockRejectedValue(new Error('File not found: missing.ts'));

    const results = await validateFiles(['missing.ts'], '/project');

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      file: 'missing.ts',
      valid: false,
      errors: ['File not found: missing.ts'],
      warnings: [],
    });
  });

  it('catches non-Error throws and converts to string', async () => {
    mockFwValidate.mockRejectedValue('raw string error');

    const results = await validateFiles(['bad.ts'], '/project');

    expect(results).toHaveLength(1);
    expect(results[0]!.errors).toEqual(['raw string error']);
  });

  it('processes multiple .ts files independently', async () => {
    mockFwValidate
      .mockResolvedValueOnce(makeValidateResult())
      .mockRejectedValueOnce(new Error('parse failed'))
      .mockResolvedValueOnce(makeValidateResult({ valid: false, errors: ['bad'] }));

    const results = await validateFiles(
      ['a.ts', 'b.ts', 'c.ts'],
      '/project',
    );

    expect(results).toHaveLength(3);
    expect(results[0]!.valid).toBe(true);
    expect(results[1]!.valid).toBe(false);
    expect(results[1]!.errors).toEqual(['parse failed']);
    expect(results[2]!.valid).toBe(false);
    expect(results[2]!.errors).toEqual(['bad']);
  });
});
