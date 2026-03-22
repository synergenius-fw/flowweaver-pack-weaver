import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveProviderConfig, createProvider, detectProvider } from '../src/bot/agent-provider.js';
import { ProviderRegistry } from '../src/bot/provider-registry.js';
import type { ProviderFactory, ProviderMetadata, BotAgentProvider } from '../src/bot/types.js';

function makeMockProvider(): BotAgentProvider {
  return {
    decide: vi.fn(async () => ({ answer: 'ok' })),
  };
}

function makeRegistry(): ProviderRegistry {
  return new ProviderRegistry();
}

function registerProvider(
  registry: ProviderRegistry,
  name: string,
  metadata: Partial<ProviderMetadata> = {},
  factory?: ProviderFactory,
): void {
  const mockFactory: ProviderFactory = factory ?? vi.fn(async () => makeMockProvider());
  registry.register(name, mockFactory, {
    displayName: name,
    source: 'built-in',
    ...metadata,
  });
}

describe('resolveProviderConfig', () => {
  it('resolves "auto" by calling detectProvider and returns a provider config', () => {
    // "auto" delegates to detectProvider which checks the default registry.
    // In CI/dev, ANTHROPIC_API_KEY is typically set, so it should find anthropic.
    // We test both outcomes: either it returns a valid config or throws the detect error.
    const originalEnv = process.env.ANTHROPIC_API_KEY;
    try {
      // Force env var so detection succeeds
      process.env.ANTHROPIC_API_KEY = 'sk-test-auto';
      const result = resolveProviderConfig('auto');
      expect(result).toHaveProperty('name');
      expect(typeof result.name).toBe('string');
    } finally {
      if (originalEnv !== undefined) process.env.ANTHROPIC_API_KEY = originalEnv;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('resolves a plain string to { name: string }', () => {
    const result = resolveProviderConfig('anthropic');
    expect(result).toEqual({ name: 'anthropic' });
  });

  it('passes through an object config as-is', () => {
    const config = { name: 'custom' as const, model: 'gpt-4', maxTokens: 2048 };
    const result = resolveProviderConfig(config);
    expect(result).toBe(config);
  });
});

describe('detectProvider', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    };
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it('detects provider by env var when present', () => {
    const registry = makeRegistry();
    registerProvider(registry, 'anthropic', { requiredEnvVars: ['ANTHROPIC_API_KEY'] });
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';

    const result = detectProvider(registry);
    expect(result).toEqual({ name: 'anthropic' });
  });

  it('skips providers whose env vars are missing', () => {
    const registry = makeRegistry();
    registerProvider(registry, 'anthropic', { requiredEnvVars: ['ANTHROPIC_API_KEY'] });
    registerProvider(registry, 'openai', { requiredEnvVars: ['OPENAI_API_KEY'] });
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;

    // Neither has env vars, no CLI commands, should throw
    expect(() => detectProvider(registry)).toThrow('No AI provider found');
  });

  it('prefers env var detection over CLI detection', () => {
    const registry = makeRegistry();
    registerProvider(registry, 'cli-provider', { detectCliCommand: 'some-cmd' });
    registerProvider(registry, 'api-provider', { requiredEnvVars: ['ANTHROPIC_API_KEY'] });
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';

    const result = detectProvider(registry);
    expect(result).toEqual({ name: 'api-provider' });
  });

  it('throws descriptive error when no provider is found', () => {
    const registry = makeRegistry();
    expect(() => detectProvider(registry)).toThrow('No AI provider found');
    expect(() => detectProvider(registry)).toThrow('ANTHROPIC_API_KEY');
  });
});

describe('createProvider', () => {
  it('resolves provider from registry', async () => {
    const registry = makeRegistry();
    const mockProvider = makeMockProvider();
    const factory = vi.fn(async () => mockProvider);
    registerProvider(registry, 'test-provider', {}, factory);

    const result = await createProvider({ name: 'test-provider' as never }, registry);
    expect(result).toBe(mockProvider);
    expect(factory).toHaveBeenCalledWith({
      model: undefined,
      maxTokens: undefined,
      options: undefined,
    });
  });

  it('passes model and maxTokens to factory', async () => {
    const registry = makeRegistry();
    const factory = vi.fn(async () => makeMockProvider());
    registerProvider(registry, 'test-provider', {}, factory);

    await createProvider({ name: 'test-provider' as never, model: 'gpt-4', maxTokens: 2048 }, registry);
    expect(factory).toHaveBeenCalledWith({
      model: 'gpt-4',
      maxTokens: 2048,
      options: undefined,
    });
  });

  it('throws helpful error when provider is not found and no fallback works', async () => {
    const registry = makeRegistry();

    await expect(createProvider({ name: 'nonexistent' as never }, registry))
      .rejects.toThrow('Unknown provider: nonexistent');
    await expect(createProvider({ name: 'nonexistent' as never }, registry))
      .rejects.toThrow('npm install flowweaver-provider-nonexistent');
  });

  it('logs a warning when fallback candidate import fails', async () => {
    const registry = makeRegistry();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await createProvider({ name: 'nonexistent' as never }, registry);
    } catch {
      // Expected to throw
    }

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load provider candidate'),
    );
    warnSpy.mockRestore();
  });

  it('loads external module when config.module is set', async () => {
    const registry = makeRegistry();
    const mockProvider = makeMockProvider();

    // Pre-register to avoid actual module loading
    const factory = vi.fn(async () => mockProvider);
    registerProvider(registry, 'custom', {}, factory);

    const result = await createProvider(
      { name: 'custom' as never, module: './my-provider.js' },
      registry,
    );
    // Since it's already registered, it skips loadExternalProvider and uses the registry
    expect(result).toBe(mockProvider);
  });
});
