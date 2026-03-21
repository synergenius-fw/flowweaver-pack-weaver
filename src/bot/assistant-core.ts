/**
 * Assistant Core — provider-agnostic conversational loop.
 * The user types, the assistant responds with text and tool calls.
 * UI-agnostic: terminal is one frontend, platform AI chat is another.
 */

import * as readline from 'node:readline';
import type {
  AgentProvider,
  AgentMessage,
  ToolDefinition,
  ToolExecutor,
  StreamEvent,
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
1. Spawn and manage multiple bot sessions (bot_spawn, bot_list, bot_status, bot_pause, bot_resume, bot_stop)
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
  const messages: AgentMessage[] = [];

  const out = (s: string) => process.stderr.write(s);

  // Welcome
  out(`\n  ${c.bold('weaver assistant')}\n`);
  out(`  ${c.dim(`Project: ${projectDir}`)}\n`);
  out(`  ${c.dim('Type your request. Ctrl+C to exit.')}\n\n`);

  // Input source: stdin readline or test messages
  const rl = opts.inputMessages
    ? null
    : readline.createInterface({ input: process.stdin, output: process.stderr, prompt: `${c.cyan('❯')} ` });

  const getNextInput = opts.inputMessages
    ? (() => {
        let i = 0;
        return () => opts.inputMessages![i++] ?? null;
      })()
    : () => new Promise<string | null>((resolve) => {
        rl!.prompt();
        rl!.once('line', (line) => resolve(line.trim() || null));
        rl!.once('close', () => resolve(null));
      });

  // Main conversation loop
  while (true) {
    const input = await getNextInput();
    if (input === null) break; // EOF or Ctrl+C
    if (!input) continue; // empty line

    messages.push({ role: 'user', content: input });
    out('\n');

    // Run the agent loop manually — stream events to terminal
    let assistantText = '';
    let toolCallCount = 0;
    const pendingToolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
    const activeChunks = new Map<string, { name: string; chunks: string[] }>();

    // Multi-turn loop: stream → collect tool calls → execute → repeat
    let continueLoop = true;
    while (continueLoop) {
      continueLoop = false;
      assistantText = '';

      const stream = provider.stream(messages, tools, { systemPrompt });

      for await (const event of stream) {
        switch (event.type) {
          case 'text_delta':
            out(event.text);
            assistantText += event.text;
            break;

          case 'thinking_delta':
            // Show thinking as dim text
            out(c.dim(event.text));
            break;

          case 'tool_use_start':
            activeChunks.set(event.id, { name: event.name, chunks: [] });
            break;

          case 'tool_use_delta':
            // Accumulate JSON chunks
            break;

          case 'tool_use_end':
            pendingToolCalls.push({ id: event.id, name: activeChunks.get(event.id)?.name ?? event.id, arguments: event.arguments });
            activeChunks.delete(event.id);
            break;

          case 'tool_result':
            // CLI handled tool internally
            toolCallCount++;
            break;

          case 'message_stop':
            if (event.finishReason === 'tool_calls' && pendingToolCalls.length > 0) {
              continueLoop = true;
            }
            break;
        }
      }

      // Add assistant message
      if (pendingToolCalls.length > 0) {
        messages.push({ role: 'assistant', content: assistantText || '', toolCalls: [...pendingToolCalls] });
      } else if (assistantText) {
        messages.push({ role: 'assistant', content: assistantText });
      }

      // Execute pending tool calls
      if (pendingToolCalls.length > 0) {
        for (const tc of pendingToolCalls) {
          toolCallCount++;
          const preview = toolPreview(tc.name, tc.arguments);
          out(`\n  ${c.cyan('◆')} ${tc.name}${preview ? c.dim(`(${preview})`) : ''}\n`);

          let result: string;
          let isError: boolean;
          try {
            const res = await executor(tc.name, tc.arguments);
            result = res.result;
            isError = res.isError;
          } catch (err) {
            result = err instanceof Error ? err.message : String(err);
            isError = true;
          }

          // Show result (truncated)
          const icon = isError ? c.red('✗') : c.dim('→');
          const preview2 = result.replace(/\n/g, ' ').slice(0, 150);
          out(`  ${icon} ${preview2}\n`);

          messages.push({ role: 'tool', content: result.slice(0, 10_000), toolCallId: tc.id });
        }

        pendingToolCalls.length = 0;
      }
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
