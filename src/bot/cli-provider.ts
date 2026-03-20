import { execSync, spawn } from 'node:child_process';
import type { BotAgentProvider, OnUsageCallback, StreamChunk, ToolDefinition, ToolUseResult } from './types.js';
import { buildSystemPrompt } from './system-prompt.js';
import { parseStreamLine, extractTextFromChunks } from './cli-stream-parser.js';
import { trackChild } from './child-process-tracker.js';

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

    const userPrompt = `Context:\n${contextStr}\n\nInstructions:\n${request.prompt}`;

    if (this.cli === 'claude-cli') {
      const chunks: StreamChunk[] = [];
      for await (const chunk of this.streamRaw(userPrompt, systemPrompt)) {
        chunks.push(chunk);
      }
      const raw = extractTextFromChunks(chunks);
      return this.parseJson(raw);
    }

    // copilot-cli: no --system-prompt support, keep concatenated
    const raw = execSync('copilot -p --silent --allow-all-tools', {
      input: systemPrompt + '\n\n' + userPrompt,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120_000,
      env: childEnv,
    }).trim();

    return this.parseJson(raw);
  }

  async *stream(request: {
    agentId: string;
    context: Record<string, unknown>;
    prompt: string;
  }): AsyncIterable<StreamChunk> {
    const systemPrompt = await buildSystemPrompt();

    const contextStr =
      typeof request.context === 'string'
        ? request.context
        : JSON.stringify(request.context, null, 2);

    const userPrompt = `Context:\n${contextStr}\n\nInstructions:\n${request.prompt}`;

    if (this.cli === 'claude-cli') {
      yield* this.streamRaw(userPrompt, systemPrompt);
    } else {
      const result = await this.decide(request);
      yield { type: 'text', text: JSON.stringify(result) };
      yield { type: 'done' };
    }
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

  private async *streamRaw(userPrompt: string, systemPrompt?: string): AsyncGenerator<StreamChunk> {
    const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages'];
    if (this.model) {
      args.push('--model', this.model);
    }
    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }

    const child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    });
    trackChild(child);

    child.stdin.write(userPrompt);
    child.stdin.end();

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
    }, 120_000);

    let buffer = '';

    try {
      for await (const data of child.stdout) {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          const chunk = parseStreamLine(line);
          if (!chunk) continue;

          if (chunk.type === 'usage' && chunk.usage && this.onUsage) {
            this.onUsage('stream', this.model ?? 'unknown', chunk.usage);
          }

          yield chunk;
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        const chunk = parseStreamLine(buffer);
        if (chunk) {
          if (chunk.type === 'usage' && chunk.usage && this.onUsage) {
            this.onUsage('stream', this.model ?? 'unknown', chunk.usage);
          }
          yield chunk;
        }
      }
    } finally {
      clearTimeout(timeout);
    }

    // Wait for process exit
    await new Promise<void>((resolve, reject) => {
      child.on('close', (code) => {
        if (code && code !== 0) {
          reject(new Error(`claude CLI exited with code ${code}`));
        } else {
          resolve();
        }
      });
      child.on('error', reject);
    });
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
