import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock node:child_process before importing the module under test ─────────────

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { weaverDetectProvider } from '../src/node-types/detect-provider.js';

const mockedExecFileSync = vi.mocked(execFileSync);

// ── helpers ───────────────────────────────────────────────────────────────────

const BASE_CONFIG = { provider: 'auto' as const };

/** Save / restore env vars around a test. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) saved[key] = process.env[key];

  for (const [key, val] of Object.entries(vars)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }

  try { fn(); } finally {
    for (const [key, val] of Object.entries(saved)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('weaverDetectProvider — auto detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // whichSafe falls through (no CLI installed)
    mockedExecFileSync.mockImplementation(() => { throw new Error('not found'); });
    delete (globalThis as any).__fw_llm_provider__;
  });

  afterEach(() => {
    delete (globalThis as any).__fw_llm_provider__;
  });

  it('detects anthropic when ANTHROPIC_API_KEY is set', () => {
    withEnv({ ANTHROPIC_API_KEY: 'sk-test-123' }, () => {
      const result = weaverDetectProvider('/proj', BASE_CONFIG);
      expect(result.env.providerType).toBe('anthropic');
      expect(result.env.providerInfo.type).toBe('anthropic');
      expect(result.env.providerInfo.apiKey).toBe('sk-test-123');
    });
  });

  it('sets default model to claude-sonnet-4-6 for anthropic', () => {
    withEnv({ ANTHROPIC_API_KEY: 'key' }, () => {
      const result = weaverDetectProvider('/proj', BASE_CONFIG);
      expect(result.env.providerInfo.model).toBe('claude-sonnet-4-6');
    });
  });

  it('sets default maxTokens to 4096 for anthropic', () => {
    withEnv({ ANTHROPIC_API_KEY: 'key' }, () => {
      const result = weaverDetectProvider('/proj', BASE_CONFIG);
      expect(result.env.providerInfo.maxTokens).toBe(4096);
    });
  });

  it('detects claude-cli when "claude" is on PATH', () => {
    withEnv({ ANTHROPIC_API_KEY: undefined }, () => {
      mockedExecFileSync.mockReturnValueOnce('/usr/local/bin/claude\n' as any);
      const result = weaverDetectProvider('/proj', BASE_CONFIG);
      expect(result.env.providerType).toBe('claude-cli');
    });
  });

  it('detects copilot-cli when "claude" not found but "copilot" is', () => {
    withEnv({ ANTHROPIC_API_KEY: undefined }, () => {
      // First call (claude) throws, second call (copilot) succeeds
      mockedExecFileSync
        .mockImplementationOnce(() => { throw new Error('not found'); })
        .mockReturnValueOnce('/usr/local/bin/copilot\n' as any);
      const result = weaverDetectProvider('/proj', BASE_CONFIG);
      expect(result.env.providerType).toBe('copilot-cli');
    });
  });

  it('detects platform when __fw_llm_provider__ is set on globalThis', () => {
    withEnv({ ANTHROPIC_API_KEY: undefined }, () => {
      (globalThis as any).__fw_llm_provider__ = { type: 'platform' };
      const result = weaverDetectProvider('/proj', BASE_CONFIG);
      expect(result.env.providerType).toBe('platform');
    });
  });

  it('throws a helpful message listing all options when nothing is found', () => {
    withEnv({ ANTHROPIC_API_KEY: undefined }, () => {
      expect(() => weaverDetectProvider('/proj', BASE_CONFIG)).toThrow(
        'No AI provider found',
      );
    });
  });

  it('error message includes instructions for ANTHROPIC_API_KEY', () => {
    withEnv({ ANTHROPIC_API_KEY: undefined }, () => {
      expect(() => weaverDetectProvider('/proj', BASE_CONFIG)).toThrow(
        'ANTHROPIC_API_KEY',
      );
    });
  });
});

describe('weaverDetectProvider — explicit string provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExecFileSync.mockImplementation(() => { throw new Error('not found'); });
  });

  it('uses explicit provider string "anthropic" when ANTHROPIC_API_KEY is set', () => {
    withEnv({ ANTHROPIC_API_KEY: 'explicit-key' }, () => {
      const result = weaverDetectProvider('/proj', { provider: 'anthropic' });
      expect(result.env.providerType).toBe('anthropic');
      expect(result.env.providerInfo.apiKey).toBe('explicit-key');
    });
  });

  it('throws when explicit provider is "anthropic" but ANTHROPIC_API_KEY is not set', () => {
    withEnv({ ANTHROPIC_API_KEY: undefined }, () => {
      expect(() =>
        weaverDetectProvider('/proj', { provider: 'anthropic' }),
      ).toThrow('ANTHROPIC_API_KEY is not set');
    });
  });

  it('uses explicit provider string "claude-cli" without checking env', () => {
    withEnv({ ANTHROPIC_API_KEY: undefined }, () => {
      const result = weaverDetectProvider('/proj', { provider: 'claude-cli' });
      expect(result.env.providerType).toBe('claude-cli');
    });
  });
});

describe('weaverDetectProvider — explicit object provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExecFileSync.mockImplementation(() => { throw new Error('not found'); });
  });

  it('uses name, model, and maxTokens from object config', () => {
    withEnv({ ANTHROPIC_API_KEY: 'obj-key' }, () => {
      const result = weaverDetectProvider('/proj', {
        provider: { name: 'anthropic', model: 'claude-opus-4-6', maxTokens: 8192 },
      });
      expect(result.env.providerType).toBe('anthropic');
      expect(result.env.providerInfo.model).toBe('claude-opus-4-6');
      expect(result.env.providerInfo.maxTokens).toBe(8192);
    });
  });

  it('object config overrides the default model', () => {
    withEnv({ ANTHROPIC_API_KEY: 'key' }, () => {
      const result = weaverDetectProvider('/proj', {
        provider: { name: 'anthropic', model: 'claude-opus-4-6' },
      });
      expect(result.env.providerInfo.model).toBe('claude-opus-4-6');
    });
  });

  it('throws when object config specifies anthropic but no API key', () => {
    withEnv({ ANTHROPIC_API_KEY: undefined }, () => {
      expect(() =>
        weaverDetectProvider('/proj', {
          provider: { name: 'anthropic', model: 'claude-sonnet-4-6' },
        }),
      ).toThrow('ANTHROPIC_API_KEY is not set');
    });
  });
});

describe('weaverDetectProvider — env bundle assembly', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExecFileSync.mockImplementation(() => { throw new Error('not found'); });
  });

  it('includes projectDir and config in the returned env', () => {
    withEnv({ ANTHROPIC_API_KEY: 'key' }, () => {
      const config = { provider: 'auto' as const, target: 'wf.ts' };
      const result = weaverDetectProvider('/my/project', config);
      expect(result.env.projectDir).toBe('/my/project');
      expect(result.env.config).toBe(config);
    });
  });
});
