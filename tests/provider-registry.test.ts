import { describe, it, expect, beforeEach } from 'vitest';
import { ProviderRegistry, defaultRegistry, loadExternalProvider } from '../src/bot/provider-registry.js';
import type { ProviderFactory, ProviderMetadata } from '../src/bot/types.js';

/* ---------- helpers ---------- */

function stubFactory(label = 'stub'): ProviderFactory {
  return () => ({ name: label }) as any;
}

function stubMetadata(overrides: Partial<ProviderMetadata> = {}): ProviderMetadata {
  return {
    displayName: 'Test Provider',
    source: 'built-in',
    ...overrides,
  };
}

/* ---------- ProviderRegistry ---------- */

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  describe('register and resolve', () => {
    it('stores a factory and returns it via resolve', () => {
      const factory = stubFactory();
      const metadata = stubMetadata();
      registry.register('test-provider', factory, metadata);

      const entry = registry.resolve('test-provider');
      expect(entry).toBeDefined();
      expect(entry!.factory).toBe(factory);
      expect(entry!.metadata).toBe(metadata);
    });

    it('preserves all metadata fields', () => {
      const metadata = stubMetadata({
        displayName: 'My Provider',
        description: 'Does things',
        source: 'npm',
        requiredEnvVars: ['API_KEY', 'API_SECRET'],
        detectCliCommand: 'my-cli',
      });
      registry.register('full-meta', stubFactory(), metadata);

      const entry = registry.resolve('full-meta');
      expect(entry!.metadata).toEqual(metadata);
    });
  });

  describe('has', () => {
    it('returns true for a registered provider', () => {
      registry.register('present', stubFactory(), stubMetadata());
      expect(registry.has('present')).toBe(true);
    });

    it('returns false for an unregistered provider', () => {
      expect(registry.has('absent')).toBe(false);
    });

    it('returns false after checking a name that was never registered', () => {
      registry.register('alpha', stubFactory(), stubMetadata());
      expect(registry.has('beta')).toBe(false);
    });
  });

  describe('list', () => {
    it('returns an empty array for a fresh registry', () => {
      expect(registry.list()).toEqual([]);
    });

    it('returns all registered providers with name and metadata', () => {
      const metaA = stubMetadata({ displayName: 'A' });
      const metaB = stubMetadata({ displayName: 'B' });
      registry.register('a', stubFactory('a'), metaA);
      registry.register('b', stubFactory('b'), metaB);

      const items = registry.list();
      expect(items).toHaveLength(2);

      const names = items.map((i) => i.name);
      expect(names).toContain('a');
      expect(names).toContain('b');

      const itemA = items.find((i) => i.name === 'a')!;
      expect(itemA.metadata).toBe(metaA);
    });

    it('does not expose the factory in list output', () => {
      registry.register('x', stubFactory(), stubMetadata());
      const item = registry.list()[0] as Record<string, unknown>;
      expect(item).not.toHaveProperty('factory');
    });
  });

  describe('resolve returns undefined for unknown name', () => {
    it('returns undefined when no providers are registered', () => {
      expect(registry.resolve('ghost')).toBeUndefined();
    });

    it('returns undefined for a wrong name when others exist', () => {
      registry.register('real', stubFactory(), stubMetadata());
      expect(registry.resolve('fake')).toBeUndefined();
    });
  });

  describe('overwrite existing registration', () => {
    it('replaces the factory and metadata for an existing name', () => {
      const factoryV1 = stubFactory('v1');
      const metaV1 = stubMetadata({ displayName: 'V1' });
      registry.register('provider', factoryV1, metaV1);

      const factoryV2 = stubFactory('v2');
      const metaV2 = stubMetadata({ displayName: 'V2', source: 'npm' });
      registry.register('provider', factoryV2, metaV2);

      const entry = registry.resolve('provider');
      expect(entry!.factory).toBe(factoryV2);
      expect(entry!.metadata.displayName).toBe('V2');
      expect(entry!.metadata.source).toBe('npm');
    });

    it('does not increase list length when overwriting', () => {
      registry.register('dup', stubFactory(), stubMetadata());
      registry.register('dup', stubFactory(), stubMetadata({ displayName: 'Updated' }));
      expect(registry.list()).toHaveLength(1);
    });
  });
});

/* ---------- defaultRegistry ---------- */

describe('defaultRegistry', () => {
  it('is an instance of ProviderRegistry', () => {
    expect(defaultRegistry).toBeInstanceOf(ProviderRegistry);
  });

  it('has anthropic, claude-cli, and copilot-cli registered', () => {
    expect(defaultRegistry.has('anthropic')).toBe(true);
    expect(defaultRegistry.has('claude-cli')).toBe(true);
    expect(defaultRegistry.has('copilot-cli')).toBe(true);
  });

  it('does not have random unregistered providers', () => {
    expect(defaultRegistry.has('openai')).toBe(false);
    expect(defaultRegistry.has('gemini')).toBe(false);
  });

  describe('anthropic metadata', () => {
    it('has correct displayName and source', () => {
      const entry = defaultRegistry.resolve('anthropic');
      expect(entry).toBeDefined();
      expect(entry!.metadata.displayName).toBe('Anthropic API');
      expect(entry!.metadata.source).toBe('built-in');
    });

    it('requires ANTHROPIC_API_KEY', () => {
      const entry = defaultRegistry.resolve('anthropic')!;
      expect(entry.metadata.requiredEnvVars).toContain('ANTHROPIC_API_KEY');
    });
  });

  describe('claude-cli metadata', () => {
    it('has correct displayName and source', () => {
      const entry = defaultRegistry.resolve('claude-cli')!;
      expect(entry.metadata.displayName).toBe('Claude CLI');
      expect(entry.metadata.source).toBe('built-in');
    });

    it('detects the claude command', () => {
      const entry = defaultRegistry.resolve('claude-cli')!;
      expect(entry.metadata.detectCliCommand).toBe('claude');
    });
  });

  describe('copilot-cli metadata', () => {
    it('has correct displayName and source', () => {
      const entry = defaultRegistry.resolve('copilot-cli')!;
      expect(entry.metadata.displayName).toBe('GitHub Copilot CLI');
      expect(entry.metadata.source).toBe('built-in');
    });

    it('detects the copilot command', () => {
      const entry = defaultRegistry.resolve('copilot-cli')!;
      expect(entry.metadata.detectCliCommand).toBe('copilot');
    });
  });

  it('list includes at least the three built-in providers', () => {
    const names = defaultRegistry.list().map((p) => p.name);
    expect(names).toContain('anthropic');
    expect(names).toContain('claude-cli');
    expect(names).toContain('copilot-cli');
  });
});

/* ---------- loadExternalProvider ---------- */

describe('loadExternalProvider', () => {
  it('throws for a nonexistent npm module', async () => {
    await expect(
      loadExternalProvider('@nonexistent/flowweaver-provider-fake-xyz-999'),
    ).rejects.toThrow(/Failed to load provider from/);
  });

  it('throws for a nonexistent local path', async () => {
    await expect(
      loadExternalProvider('./does-not-exist/provider.js'),
    ).rejects.toThrow(/Failed to load provider from/);
  });

  it('includes install hint for npm packages', async () => {
    try {
      await loadExternalProvider('@nonexistent/flowweaver-provider-fake-xyz-999');
      expect.unreachable('should have thrown');
    } catch (err: any) {
      expect(err.message).toContain('npm install @nonexistent/flowweaver-provider-fake-xyz-999');
    }
  });

  it('includes path hint for local modules starting with ./', async () => {
    try {
      await loadExternalProvider('./no-such-dir/provider.js');
      expect.unreachable('should have thrown');
    } catch (err: any) {
      expect(err.message).toContain('Check the path exists');
    }
  });

  it('includes path hint for local modules starting with /', async () => {
    try {
      await loadExternalProvider('/tmp/no-such-provider-abc123.js');
      expect.unreachable('should have thrown');
    } catch (err: any) {
      expect(err.message).toContain('Check the path exists');
      expect(err.message).toContain('/tmp/no-such-provider-abc123.js');
    }
  });

  it('error message includes the original module spec', async () => {
    const spec = 'some-fantasy-package-that-does-not-exist-xyz';
    await expect(loadExternalProvider(spec)).rejects.toThrow(
      `Failed to load provider from "${spec}"`,
    );
  });
});
