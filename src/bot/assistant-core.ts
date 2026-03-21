/**
 * Assistant Core — provider-agnostic conversational loop.
 * The user types, the assistant responds with text and tool calls.
 * UI-agnostic: terminal is one frontend, platform AI chat is another.
 *
 * Supports two provider modes:
 * - CLI provider: tools handled internally via MCP bridge (tool_result events)
 * - API provider: tools collected and executed manually (tool_use_start/end events)
 */

import * as readline from 'node:readline';
import {
  runAgentLoop,
  type AgentProvider,
  type AgentMessage,
  type ToolDefinition,
  type ToolExecutor,
  type StreamEvent,
} from '@synergenius/flow-weaver/agent';

export interface AssistantOptions {
  provider: AgentProvider;
  tools: ToolDefinition[];
  executor: ToolExecutor;
  projectDir: string;
  systemPrompt?: string;
  /** Override for testing — provide messages instead of reading stdin */
  inputMessages?: string[];
}

const DEFAULT_SYSTEM_PROMPT = `You are Weaver Assistant — a director-level AI that manages bot workers and the flow-weaver ecosystem.

You help users:
1. Spawn and manage multiple bot sessions (bot_spawn, bot_list, bot_status, bot_pause, bot_resume, bot_stop, bot_logs)
2. Queue tasks for bots (queue_add, queue_add_batch, queue_list, queue_retry)
3. Inspect workflows (fw_validate, fw_diagram, fw_describe)
4. Read and analyze project files (read_file, list_files, run_shell)
5. Generate reports on bot progress and costs

USE TOOLS to fulfill requests. Don't describe what you'd do — actually do it.
When the user asks to "start a bot", call bot_spawn.
When they ask for status, call bot_list or bot_status.
When they ask to add tasks, call queue_add or queue_add_batch.

Be concise. Show results, not explanations. Use tables and formatting for multi-item results.
The user is a senior engineer — don't over-explain.`;

// ANSI helpers
const c = {
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

export async function runAssistant(opts: AssistantOptions): Promise<void> {
  const { provider, tools, executor, projectDir } = opts;
  const systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  const out = (s: string) => process.stderr.write(s);

  // Welcome
  out(`\n  ${c.bold('weaver assistant')}\n`);
  out(`  ${c.dim(`Project: ${projectDir}`)}\n`);
  out(`  ${c.dim('Type your request. Ctrl+C to exit.')}\n\n`);

  // Input source
  const rl = opts.inputMessages
    ? null
    : readline.createInterface({ input: process.stdin, output: process.stderr, prompt: `${c.cyan('❯')} ` });

  const getNextInput = opts.inputMessages
    ? (() => {
        let i = 0;
        return (): Promise<string | null> => Promise.resolve(opts.inputMessages![i++] ?? null);
      })()
    : (): Promise<string | null> => new Promise<string | null>((resolve) => {
        rl!.prompt();
        rl!.once('line', (line) => resolve(line.trim() || null));
        rl!.once('close', () => resolve(null));
      });

  // Main conversation loop — each user message triggers a full agent loop
  while (true) {
    const input = await getNextInput();
    if (input === null) break;
    if (!input) continue;

    out('\n');

    // Use runAgentLoop which handles both CLI (MCP bridge) and API (manual tool execution)
    // This is the same battle-tested loop that bot tasks use
    const onStreamEvent = (event: StreamEvent) => {
      if (event.type === 'text_delta') {
        out(event.text);
      } else if (event.type === 'thinking_delta') {
        out(c.dim(event.text));
      }
    };

    const onToolEvent = (event: { type: string; name: string; args?: Record<string, unknown>; result?: string; isError?: boolean }) => {
      if (event.type === 'tool_call_start') {
        const preview = toolPreview(event.name, event.args ?? {});
        out(`\n  ${c.cyan('◆')} ${event.name}${preview ? c.dim(`(${preview})`) : ''}\n`);
      }
      if (event.type === 'tool_call_result') {
        const icon = event.isError ? c.red('✗') : c.dim('→');
        const result = (event.result ?? '').replace(/\n/g, ' ').slice(0, 150);
        out(`  ${icon} ${result}\n`);
      }
    };

    try {
      const result = await runAgentLoop(
        provider,
        tools,
        executor,
        [{ role: 'user', content: input }],
        {
          systemPrompt,
          maxIterations: 20,
          onStreamEvent,
          onToolEvent,
        },
      );

      if (!result.success && result.summary) {
        out(`\n  ${c.red(result.summary)}\n`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      out(`\n  ${c.red('Error:')} ${msg}\n`);
    }

    out('\n');
  }

  rl?.close();
  out(`\n  ${c.dim('Goodbye.')}\n\n`);
}

function toolPreview(name: string, args: Record<string, unknown>): string {
  if (args.name) return String(args.name);
  if (args.bot) return String(args.bot);
  if (args.file) return String(args.file).split('/').pop() ?? '';
  if (args.path) return String(args.path).split('/').pop() ?? '';
  if (args.instruction) return String(args.instruction).slice(0, 40);
  if (args.command) return String(args.command).slice(0, 40);
  return '';
}
