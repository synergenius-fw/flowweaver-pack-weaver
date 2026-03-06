import { execSync } from 'node:child_process';
import type { BotProviderConfig, BotConfig, BotAgentProvider, OnUsageCallback } from './types.js';
import { buildSystemPrompt } from './system-prompt.js';
import { defaultRegistry, loadExternalProvider } from './provider-registry.js';
import type { ProviderRegistry } from './provider-registry.js';

const WHICH_CMD = process.platform === 'win32' ? 'where' : 'which';

export type { BotAgentProvider };

export function resolveProviderConfig(
  provider: BotConfig['provider'],
): BotProviderConfig {
  if (provider === 'auto') return detectProvider();
  if (typeof provider === 'string') return { name: provider };
  return provider;
}

export async function createProvider(
  config: BotProviderConfig,
  registry: ProviderRegistry = defaultRegistry,
): Promise<BotAgentProvider> {
  // If config.module is set, load and register it first
  if (config.module) {
    if (!registry.has(config.name)) {
      const { factory, metadata } = await loadExternalProvider(config.module);
      registry.register(config.name, factory, metadata);
    }
  }

  // Check registry (covers built-ins + loaded externals)
  const entry = registry.resolve(config.name);
  if (entry) {
    return entry.factory({
      model: config.model,
      maxTokens: config.maxTokens,
      options: config.options,
    });
  }

  // Fallback: try conventional npm package names
  const candidates = [
    `flowweaver-provider-${config.name}`,
    `@synergenius/flowweaver-provider-${config.name}`,
  ];

  for (const candidate of candidates) {
    try {
      const { factory, metadata } = await loadExternalProvider(candidate);
      registry.register(config.name, factory, metadata);
      return factory({
        model: config.model,
        maxTokens: config.maxTokens,
        options: config.options,
      });
    } catch {
      // Try next candidate
    }
  }

  throw new Error(
    `Unknown provider: ${config.name}\n` +
    `  Install a provider package: npm install flowweaver-provider-${config.name}\n` +
    `  Or specify a module path: { "provider": { "name": "${config.name}", "module": "./my-provider.js" } }`,
  );
}

export function detectProvider(registry: ProviderRegistry = defaultRegistry): BotProviderConfig {
  // Check registry metadata for env vars and CLI commands
  for (const { name, metadata } of registry.list()) {
    if (metadata.requiredEnvVars) {
      const allPresent = metadata.requiredEnvVars.every((v) => process.env[v]);
      if (allPresent) return { name };
    }
  }

  for (const { name, metadata } of registry.list()) {
    if (metadata.detectCliCommand) {
      try {
        execSync(`${WHICH_CMD} ${metadata.detectCliCommand}`, { stdio: 'pipe' });
        return { name };
      } catch { /* not installed */ }
    }
  }

  throw new Error(
    'No AI provider found. Options:\n' +
    '  1. Set ANTHROPIC_API_KEY environment variable\n' +
    '  2. Install Claude CLI: https://docs.anthropic.com/claude-code\n' +
    '  3. Install GitHub Copilot CLI: https://github.com/features/copilot',
  );
}

export class AnthropicAgentProvider implements BotAgentProvider {
  private model: string;
  private maxTokens: number;
  onUsage?: OnUsageCallback;

  constructor(config: BotProviderConfig) {
    this.model = config.model ?? 'claude-sonnet-4-6';
    this.maxTokens = config.maxTokens ?? 4096;
  }

  async decide(request: {
    agentId: string;
    context: Record<string, unknown>;
    prompt: string;
  }): Promise<Record<string, unknown>> {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        'ANTHROPIC_API_KEY environment variable is required for the Anthropic provider',
      );
    }

    const Anthropic = await this.loadSdk();
    const client = new Anthropic();
    const systemPrompt = await buildSystemPrompt();

    const contextStr =
      typeof request.context === 'string'
        ? request.context
        : JSON.stringify(request.context, null, 2);

    const response = await client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Context:\n${contextStr}\n\nInstructions:\n${request.prompt}`,
        },
      ],
    });

    if (this.onUsage && response.usage) {
      this.onUsage(request.agentId, response.model ?? this.model, {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheCreationInputTokens: response.usage.cache_creation_input_tokens,
        cacheReadInputTokens: response.usage.cache_read_input_tokens,
      });
    }

    const text =
      response.content[0].type === 'text' ? response.content[0].text : '';
    return this.parseJson(text);
  }

  private parseJson(text: string): Record<string, unknown> {
    let cleaned = text.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    try {
      return JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        return JSON.parse(match[0]);
      }
      throw new Error(`Failed to parse AI response as JSON: ${text.slice(0, 200)}`);
    }
  }

  private async loadSdk(): Promise<
    new () => {
      messages: {
        create: (opts: {
          model: string;
          max_tokens: number;
          system: string;
          messages: Array<{ role: string; content: string }>;
        }) => Promise<{
          content: Array<{ type: string; text: string }>;
          model?: string;
          usage?: {
            input_tokens: number;
            output_tokens: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          };
        }>;
      };
    }
  > {
    try {
      // @ts-expect-error -- optional peer dep, loaded at runtime
      const mod = await import('@anthropic-ai/sdk');
      return mod.default ?? mod.Anthropic;
    } catch {
      throw new Error(
        'Bot mode requires @anthropic-ai/sdk. Install it:\n  npm install @anthropic-ai/sdk',
      );
    }
  }
}
