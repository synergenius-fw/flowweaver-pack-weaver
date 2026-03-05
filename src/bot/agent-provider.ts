import { execSync } from 'node:child_process';
import type { BotProviderConfig, BotConfig } from './types.js';
import { buildSystemPrompt } from './system-prompt.js';
import { CliAgentProvider } from './cli-provider.js';

export interface BotAgentProvider {
  decide(request: {
    agentId: string;
    context: Record<string, unknown>;
    prompt: string;
  }): Promise<Record<string, unknown>>;
}

export function resolveProviderConfig(
  provider: BotConfig['provider'],
): BotProviderConfig {
  if (provider === 'auto') return detectProvider();
  if (typeof provider === 'string') return { name: provider };
  return provider;
}

export function createProvider(config: BotProviderConfig): BotAgentProvider {
  if (config.name === 'anthropic') return new AnthropicAgentProvider(config);
  if (config.name === 'claude-cli' || config.name === 'copilot-cli') {
    return new CliAgentProvider(config.name);
  }
  throw new Error(`Unknown provider: ${config.name}`);
}

export function detectProvider(): BotProviderConfig {
  if (process.env.ANTHROPIC_API_KEY) return { name: 'anthropic' };

  try {
    execSync('which claude', { stdio: 'pipe' });
    return { name: 'claude-cli' };
  } catch { /* not installed */ }

  try {
    execSync('which copilot', { stdio: 'pipe' });
    return { name: 'copilot-cli' };
  } catch { /* not installed */ }

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
