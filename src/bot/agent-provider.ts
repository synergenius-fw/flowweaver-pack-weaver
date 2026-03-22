import { execFileSync } from 'node:child_process';
import type { BotProviderConfig, BotConfig, BotAgentProvider, OnUsageCallback, StreamChunk, ToolDefinition, ToolUseResult } from './types.js';
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Failed to load provider candidate "${candidate}": ${msg}`);
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
        execFileSync(WHICH_CMD, [metadata.detectCliCommand], { stdio: 'pipe' });
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

  async *stream(request: {
    agentId: string;
    context: Record<string, unknown>;
    prompt: string;
  }): AsyncIterable<StreamChunk> {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required for the Anthropic provider');
    }

    const Anthropic = await this.loadSdk();
    const client = new Anthropic();
    const systemPrompt = await buildSystemPrompt();

    const contextStr = typeof request.context === 'string'
      ? request.context
      : JSON.stringify(request.context, null, 2);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = (client as any).messages.stream({
      model: this.model,
      max_tokens: this.maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Context:\n${contextStr}\n\nInstructions:\n${request.prompt}` }],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const event of stream as AsyncIterable<any>) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        yield { type: 'text', text: event.delta.text };
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const finalMessage = await (stream as any).finalMessage();
    if (finalMessage?.usage) {
      const usage = {
        inputTokens: finalMessage.usage.input_tokens,
        outputTokens: finalMessage.usage.output_tokens,
        cacheCreationInputTokens: finalMessage.usage.cache_creation_input_tokens,
        cacheReadInputTokens: finalMessage.usage.cache_read_input_tokens,
      };
      if (this.onUsage) this.onUsage(request.agentId, finalMessage.model ?? this.model, usage);
      yield { type: 'usage', usage };
    }
    yield { type: 'done' };
  }

  async decideWithTools(request: {
    agentId: string;
    context: Record<string, unknown>;
    prompt: string;
    tools: ToolDefinition[];
  }): Promise<{ result: Record<string, unknown>; toolCalls?: ToolUseResult[] }> {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required for the Anthropic provider');
    }

    const Anthropic = await this.loadSdk();
    const client = new Anthropic();
    const systemPrompt = await buildSystemPrompt();

    const contextStr = typeof request.context === 'string'
      ? request.context
      : JSON.stringify(request.context, null, 2);

    const response = await client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Context:\n${contextStr}\n\nInstructions:\n${request.prompt}` }],
      tools: request.tools,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    if (this.onUsage && response.usage) {
      this.onUsage(request.agentId, response.model ?? this.model, {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheCreationInputTokens: response.usage.cache_creation_input_tokens,
        cacheReadInputTokens: response.usage.cache_read_input_tokens,
      });
    }

    const toolCalls: ToolUseResult[] = [];
    let text = '';
    for (const block of response.content) {
      if (block.type === 'text') text = block.text;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      else if (block.type === 'tool_use') toolCalls.push({ toolName: (block as any).name, toolInput: (block as any).input });
    }

    return { result: this.parseJson(text || '{}'), toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async loadSdk(): Promise<new () => any> {
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
