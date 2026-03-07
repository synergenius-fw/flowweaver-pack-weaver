import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  BotAgentProvider,
  BotProviderConfig,
  ProviderFactory,
  ProviderFactoryConfig,
  ProviderMetadata,
  ProviderModule,
} from './types.js';

interface RegistryEntry {
  factory: ProviderFactory;
  metadata: ProviderMetadata;
}

export class ProviderRegistry {
  private factories = new Map<string, RegistryEntry>();

  register(name: string, factory: ProviderFactory, metadata: ProviderMetadata): void {
    this.factories.set(name, { factory, metadata });
  }

  resolve(name: string): RegistryEntry | undefined {
    return this.factories.get(name);
  }

  has(name: string): boolean {
    return this.factories.has(name);
  }

  list(): Array<{ name: string; metadata: ProviderMetadata }> {
    return Array.from(this.factories.entries()).map(([name, entry]) => ({
      name,
      metadata: entry.metadata,
    }));
  }
}

export const defaultRegistry = new ProviderRegistry();

defaultRegistry.register(
  'anthropic',
  async (config) => {
    const { AnthropicAgentProvider } = await import('./agent-provider.js');
    return new AnthropicAgentProvider({ name: 'anthropic', model: config.model, maxTokens: config.maxTokens });
  },
  {
    displayName: 'Anthropic API',
    description: 'Direct Anthropic API calls via @anthropic-ai/sdk',
    source: 'built-in',
    requiredEnvVars: ['ANTHROPIC_API_KEY'],
  },
);

defaultRegistry.register(
  'claude-cli',
  async (config) => {
    const { CliAgentProvider } = await import('./cli-provider.js');
    return new CliAgentProvider('claude-cli', config.model);
  },
  {
    displayName: 'Claude CLI',
    description: 'Claude Code CLI (claude -p)',
    source: 'built-in',
    detectCliCommand: 'claude',
  },
);

defaultRegistry.register(
  'copilot-cli',
  async (config) => {
    const { CliAgentProvider } = await import('./cli-provider.js');
    return new CliAgentProvider('copilot-cli', config.model);
  },
  {
    displayName: 'GitHub Copilot CLI',
    description: 'GitHub Copilot CLI (copilot -p)',
    source: 'built-in',
    detectCliCommand: 'copilot',
  },
);

export async function loadExternalProvider(
  moduleSpec: string,
): Promise<{ factory: ProviderFactory; metadata: ProviderMetadata }> {
  let mod: Record<string, unknown>;

  try {
    if (moduleSpec.startsWith('.') || moduleSpec.startsWith('/')) {
      const absPath = path.resolve(moduleSpec);
      const fileUrl = pathToFileURL(absPath).href;
      mod = await import(fileUrl);
    } else {
      mod = await import(moduleSpec);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isLocal = moduleSpec.startsWith('.') || moduleSpec.startsWith('/');
    const hint = isLocal
      ? `Check the path exists: ${path.resolve(moduleSpec)}`
      : `Install it with: npm install ${moduleSpec}`;
    throw new Error(`Failed to load provider from "${moduleSpec}": ${msg}\n  ${hint}`);
  }

  // Accept: default export object with createProvider, named createProvider, or default function
  const defaultExport = (mod.default ?? mod) as Record<string, unknown>;
  let factory: ProviderFactory;
  let metadata: ProviderMetadata;

  if (typeof defaultExport === 'function') {
    factory = defaultExport as ProviderFactory;
    metadata = { displayName: moduleSpec, source: moduleSpec.startsWith('.') || moduleSpec.startsWith('/') ? 'local' : 'npm' };
  } else if (typeof defaultExport.createProvider === 'function') {
    const providerModule = defaultExport as unknown as ProviderModule;
    factory = providerModule.createProvider;
    metadata = providerModule.metadata ?? {
      displayName: moduleSpec,
      source: moduleSpec.startsWith('.') || moduleSpec.startsWith('/') ? 'local' : 'npm',
    };
  } else if (typeof mod.createProvider === 'function') {
    factory = mod.createProvider as ProviderFactory;
    metadata = (mod.metadata as ProviderMetadata) ?? {
      displayName: moduleSpec,
      source: moduleSpec.startsWith('.') || moduleSpec.startsWith('/') ? 'local' : 'npm',
    };
  } else {
    throw new Error(
      `Provider module "${moduleSpec}" must export a createProvider function ` +
      `(as default export, default.createProvider, or named export)`,
    );
  }

  return { factory, metadata };
}

let discoveredProviders: Array<{ name: string; metadata: ProviderMetadata }> | null = null;

export async function discoverProviders(
  registry: ProviderRegistry = defaultRegistry,
): Promise<Array<{ name: string; metadata: ProviderMetadata }>> {
  if (discoveredProviders) return discoveredProviders;

  const discovered: Array<{ name: string; metadata: ProviderMetadata }> = [];
  let dir = process.cwd();

  for (let depth = 0; depth < 10; depth++) {
    const nodeModules = path.join(dir, 'node_modules');
    if (fs.existsSync(nodeModules)) {
      await scanNodeModules(nodeModules, registry, discovered);
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  discoveredProviders = discovered;
  return discovered;
}

async function scanNodeModules(
  nodeModulesDir: string,
  registry: ProviderRegistry,
  results: Array<{ name: string; metadata: ProviderMetadata }>,
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    if (entry.name.startsWith('@')) {
      // Scoped packages
      const scopeDir = path.join(nodeModulesDir, entry.name);
      let scopeEntries: fs.Dirent[];
      try {
        scopeEntries = fs.readdirSync(scopeDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const scopeEntry of scopeEntries) {
        if (!scopeEntry.isDirectory()) continue;
        await checkProviderPackage(
          path.join(scopeDir, scopeEntry.name),
          `${entry.name}/${scopeEntry.name}`,
          registry,
          results,
        );
      }
    } else {
      await checkProviderPackage(
        path.join(nodeModulesDir, entry.name),
        entry.name,
        registry,
        results,
      );
    }
  }
}

async function checkProviderPackage(
  pkgDir: string,
  pkgName: string,
  registry: ProviderRegistry,
  results: Array<{ name: string; metadata: ProviderMetadata }>,
): Promise<void> {
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return;

  try {
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    const keywords: string[] = pkgJson.keywords ?? [];
    if (!keywords.includes('flowweaver-provider')) return;

    // Derive provider name
    const providerName: string =
      pkgJson.flowWeaver?.providerName ??
      pkgName
        .replace(/^@[^/]+\//, '')
        .replace(/^flowweaver-provider-/, '');

    if (registry.has(providerName)) return;

    const { factory, metadata } = await loadExternalProvider(pkgName);
    registry.register(providerName, factory, metadata);
    results.push({ name: providerName, metadata });
  } catch {
    // Skip packages that fail to load
  }
}
