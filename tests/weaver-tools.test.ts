import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWeaverExecutor } from '../src/bot/weaver-tools.js';

// ---------------------------------------------------------------------------
// Tests for weaver-tools.ts error handling
// Focus: web_fetch network errors, run_tests JSON parse with isError
// ---------------------------------------------------------------------------

// Mock child_process for run_tests
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

// Mock step-executor so default-branch tools don't need real fs
vi.mock('./step-executor.js', () => ({
  executeStep: vi.fn().mockResolvedValue({ output: 'ok' }),
}));

// Mock safety — let non-blocked URLs through
vi.mock('../src/bot/safety.js', () => ({
  isBlockedUrl: (url: string) => url.includes('localhost'),
}));

// Mock tool-registry export
vi.mock('../src/bot/tool-registry.js', () => ({
  BOT_TOOLS: [],
}));

describe('createWeaverExecutor', () => {
  let executor: ReturnType<typeof createWeaverExecutor>;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = createWeaverExecutor('/tmp/test-project');
  });

  // =========================================================================
  // web_fetch error handling
  // =========================================================================
  describe('web_fetch', () => {
    it('returns isError true when fetch throws a network error', async () => {
      // Simulate a DNS/connection failure
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

      const result = await executor('web_fetch', { url: 'https://unreachable.example.com' });

      expect(result.isError).toBe(true);
      expect(result.result).toContain('fetch failed');

      globalThis.fetch = originalFetch;
    });

    it('returns isError true when fetch throws a timeout error', async () => {
      const originalFetch = globalThis.fetch;
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      globalThis.fetch = vi.fn().mockRejectedValue(abortError);

      const result = await executor('web_fetch', { url: 'https://slow.example.com' });

      expect(result.isError).toBe(true);
      expect(result.result).toContain('aborted');

      globalThis.fetch = originalFetch;
    });

    it('blocks localhost URLs', async () => {
      const result = await executor('web_fetch', { url: 'http://localhost:3000/secret' });
      expect(result.isError).toBe(true);
      expect(result.result).toContain('Blocked');
    });

    it('returns truncated body on success', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => 'hello world',
      });

      const result = await executor('web_fetch', { url: 'https://example.com' });

      expect(result.isError).toBe(false);
      expect(result.result).toBe('hello world');

      globalThis.fetch = originalFetch;
    });
  });

  // =========================================================================
  // run_tests JSON parse fallback
  // =========================================================================
  describe('run_tests', () => {
    it('returns isError true when JSON parse fails on non-error output', async () => {
      // When vitest outputs non-JSON (e.g. a warning or partial output),
      // the inner catch should NOT silently report success
      const { execFileSync } = await import('node:child_process');
      (execFileSync as ReturnType<typeof vi.fn>).mockReturnValue('not valid json at all');

      const result = await executor('run_tests', {});

      // This SHOULD be isError: true because we couldn't parse results
      // Currently the code returns isError: false — this test should FAIL
      expect(result.isError).toBe(true);
      expect(result.result).toContain('not valid json');
    });
  });
});
