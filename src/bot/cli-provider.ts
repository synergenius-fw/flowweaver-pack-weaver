import { execSync } from 'node:child_process';
import type { BotAgentProvider } from './agent-provider.js';
import { buildSystemPrompt } from './system-prompt.js';

export class CliAgentProvider implements BotAgentProvider {
  private cli: 'claude-cli' | 'copilot-cli';

  constructor(cli: 'claude-cli' | 'copilot-cli') {
    this.cli = cli;
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
      raw = execSync('claude -p --output-format text', {
        input: fullPrompt,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120_000,
      }).trim();
    } else {
      raw = execSync('copilot -p --silent --allow-all-tools', {
        input: fullPrompt,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120_000,
      }).trim();
    }

    return this.parseJson(raw);
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
