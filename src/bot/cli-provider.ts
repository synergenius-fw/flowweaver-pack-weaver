import { execSync } from 'node:child_process';
import type { BotAgentProvider, OnUsageCallback, StreamChunk, ToolDefinition, ToolUseResult } from './types.js';
import { buildSystemPrompt } from './system-prompt.js';

// Strip CLAUDECODE from child env so nested claude CLI invocations work.
const childEnv = { ...process.env };
delete childEnv.CLAUDECODE;

export class CliAgentProvider implements BotAgentProvider {
  private cli: 'claude-cli' | 'copilot-cli';
  private model?: string;
  onUsage?: OnUsageCallback;

  constructor(cli: 'claude-cli' | 'copilot-cli', model?: string) {
    this.cli = cli;
    this.model = model;
  }

  async decide(request: {
    agentId: string;
    context: Record<string, unknown>;
    prompt: string;
  }): Promise<Record<string, unknown>> {
    const systemPrompt = await buildSystemPrompt();

    const contextStr =
      typeof request.context === 'string'
        ? request.context
        : JSON.stringify(request.context, null, 2);

    const fullPrompt = `${systemPrompt}\n\nContext:\n${contextStr}\n\nInstructions:\n${request.prompt}`;

    let raw: string;
    if (this.cli === 'claude-cli') {
      const modelFlag = this.model ? ` --model ${this.model}` : '';
      raw = execSync(`claude -p --output-format text${modelFlag}`, {
        input: fullPrompt,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120_000,
        env: childEnv,
      }).trim();
    } else {
      raw = execSync('copilot -p --silent --allow-all-tools', {
        input: fullPrompt,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120_000,
        env: childEnv,
      }).trim();
    }

    return this.parseJson(raw);
  }

  async *stream(request: {
    agentId: string;
    context: Record<string, unknown>;
    prompt: string;
  }): AsyncIterable<StreamChunk> {
    const result = await this.decide(request);
    yield { type: 'text', text: JSON.stringify(result) };
    yield { type: 'done' };
  }

  async decideWithTools(request: {
    agentId: string;
    context: Record<string, unknown>;
    prompt: string;
    tools: ToolDefinition[];
  }): Promise<{ result: Record<string, unknown>; toolCalls?: ToolUseResult[] }> {
    const result = await this.decide(request);
    return { result };
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
      throw new Error(`Failed to parse CLI response as JSON: ${text.slice(0, 200)}`);
    }
  }
}
