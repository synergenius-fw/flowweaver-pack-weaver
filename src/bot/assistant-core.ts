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
import { c } from './ansi.js';
import { VERBOSE_TOOL_NAMES } from './tool-registry.js';
import { generateToolPromptSection, generateVerboseToolList } from './tool-registry.js';
import { CHARS_PER_TOKEN } from './safety.js';

export interface AssistantOptions {
  provider: AgentProvider;
  tools: ToolDefinition[];
  executor: ToolExecutor;
  projectDir: string;
  systemPrompt?: string;
  /** Override for testing — provide messages instead of reading stdin */
  inputMessages?: string[];
  /** Resume a specific conversation by ID */
  resumeId?: string;
  /** Always start a fresh conversation */
  newConversation?: boolean;
}

const DEFAULT_SYSTEM_PROMPT = `You are Weaver Assistant — a director-level AI that manages bot workers and the flow-weaver ecosystem.

You help users with the following tools (grouped by category):

${generateToolPromptSection()}
USE TOOLS to fulfill requests. Don't describe what you'd do — actually do it.
When the user asks to "start a bot", call bot_spawn.
When they ask for status, call bot_list or bot_status.
When they ask to add tasks, call queue_add or queue_add_batch.

Be concise. Show results, not explanations.
The user is a senior engineer — don't over-explain.

CRITICAL: You are running in a terminal. Do NOT use markdown formatting.
- No **bold**, no _italic_, no \`backticks\`, no tables with |pipes|
- No emoji (✅, 🔴, etc.)
- Use plain text with indentation for structure
- Use UPPERCASE or quotes for emphasis instead of markdown
- For lists, use simple dashes: - item
- For key-value pairs, use: key: value (one per line)
- Keep output scannable and clean

IMPORTANT: Some tool results are displayed DIRECTLY to the user in the terminal.
These tools show FULL output — the user already sees everything:
  ${generateVerboseToolList()}
For these: do NOT repeat, summarize, or reformat the output. Just add a brief comment if needed.
Never re-type ASCII art, diagrams, or large text blocks that were already printed.

Other tools show only a short preview.
For those: you may summarize or explain the result as needed.`;


export async function runAssistant(opts: AssistantOptions): Promise<void> {
  const { provider, tools, executor, projectDir } = opts;

  // Build system prompt — include project plan if it exists
  let systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const planPath = path.resolve(projectDir, '.weaver-plan.md');
    if (fs.existsSync(planPath)) {
      const plan = fs.readFileSync(planPath, 'utf-8').trim();
      systemPrompt += '\n\n## Project Plan & Vision\n\nAll bots you spawn and tasks you queue MUST align with this plan.\n\n' + plan;
    }
  } catch { /* plan not available */ }

  const out = (s: string) => process.stderr.write(s);

  // Persistent conversation store
  const { ConversationStore } = await import('./conversation-store.js');
  const store = new ConversationStore();

  // Resolve conversation: resume, new, or auto
  let conversation: { id: string; title: string; messageCount: number };
  const history: AgentMessage[] = [];

  if (opts.resumeId) {
    const existing = store.get(opts.resumeId);
    if (!existing) {
      out(`  ${c.red('Conversation not found:')} ${opts.resumeId}\n`);
      return;
    }
    conversation = existing;
    history.push(...store.loadMessages(existing.id));
    compressHistory(history);
  } else if (opts.newConversation) {
    conversation = store.create(projectDir);
  } else {
    // Auto-resume most recent if within 1 hour, else create new
    const recent = store.getMostRecent();
    if (recent && Date.now() - recent.lastMessageAt < 3600_000) {
      conversation = recent;
      history.push(...store.loadMessages(recent.id));
      compressHistory(history);
    } else {
      conversation = store.create(projectDir);
    }
  }

  // Welcome
  out(`\n  ${c.bold('weaver assistant')}\n`);
  out(`  ${c.dim(`Project: ${projectDir}`)}\n`);
  if (conversation.title) {
    out(`  ${c.dim(`Resuming: "${conversation.title}" (${conversation.messageCount} messages)`)}\n`);
  } else {
    out(`  ${c.dim(`Conversation: ${conversation.id}`)}\n`);
  }
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
      const raw = event.result ?? '';
      // Show full output for diagram/describe/docs tools; truncate others
      const isVerboseTool = VERBOSE_TOOL_NAMES.has(event.name);
      if (isVerboseTool && raw.length > 150) {
        out(`  ${icon}\n${raw}\n`);
      } else {
        const result = raw.replace(/\n/g, ' ').slice(0, 200);
        out(`  ${icon} ${result}\n`);
      }
    }
  };

  // Main conversation loop
  while (true) {
    const input = await getNextInput();
    if (input === null) break;
    if (!input.trim()) continue;

    out('\n');

    // Add user message to history
    history.push({ role: 'user', content: input });

    try {
      const result = await runAgentLoop(
        provider,
        tools,
        executor,
        history, // full conversation history
        {
          systemPrompt,
          maxIterations: 20,
          onStreamEvent,
          onToolEvent,
        },
      );

      // Collect new messages from the agent loop
      const newMessages: AgentMessage[] = [];
      if (result.messages.length > history.length) {
        for (let i = history.length; i < result.messages.length; i++) {
          history.push(result.messages[i]);
          newMessages.push(result.messages[i]);
        }
      }

      // Persist to disk
      const tokensUsed = result.usage.promptTokens + result.usage.completionTokens;
      store.appendMessages(conversation.id, [{ role: 'user', content: input }, ...newMessages]);
      store.updateAfterTurn(conversation.id, [{ role: 'user', content: input }, ...newMessages], tokensUsed);

      // Auto-title from first assistant response
      if (!conversation.title) {
        const firstAssistant = newMessages.find(m => m.role === 'assistant');
        if (firstAssistant && typeof firstAssistant.content === 'string') {
          const title = firstAssistant.content.split('\n')[0].slice(0, 80).trim();
          if (title) {
            conversation.title = title;
            store.setTitle(conversation.id, title);
          }
        }
      }

      // Token-aware compression
      compressHistory(history);

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

// --- Token-aware history compression ---

// Budget: leave room for system prompt (~2k) + tools (~3k) + response (~4k)
const MAX_HISTORY_TOKENS = 80_000;
// When compressing, truncate tool results to this size
const COMPRESSED_TOOL_RESULT_SIZE = 200;

function estimateTokens(msg: AgentMessage): number {
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  return Math.ceil(content.length / CHARS_PER_TOKEN);
}

function totalTokens(history: AgentMessage[]): number {
  return history.reduce((sum, m) => sum + estimateTokens(m), 0);
}

/**
 * Compress conversation history to stay within token budget.
 * Strategy (progressive, stops as soon as under budget):
 * 1. Truncate long tool results to 200 chars (keep tool call structure)
 * 2. Summarize old tool results to just "[tool_name: ok/error]"
 * 3. Drop oldest turns (keep most recent 10 turns)
 */
function compressHistory(history: AgentMessage[]): void {
  if (totalTokens(history) <= MAX_HISTORY_TOKENS) return;

  // Phase 1: Truncate tool results older than last 6 messages
  const cutoff = Math.max(0, history.length - 6);
  for (let i = 0; i < cutoff; i++) {
    const msg = history[i];
    if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > COMPRESSED_TOOL_RESULT_SIZE) {
      msg.content = msg.content.slice(0, COMPRESSED_TOOL_RESULT_SIZE) + '... (truncated)';
    }
  }
  if (totalTokens(history) <= MAX_HISTORY_TOKENS) return;

  // Phase 2: Summarize all tool results older than last 10 messages
  const summaryCutoff = Math.max(0, history.length - 10);
  for (let i = 0; i < summaryCutoff; i++) {
    const msg = history[i];
    if (msg.role === 'tool' && typeof msg.content === 'string') {
      const isError = msg.content.toLowerCase().includes('error') || msg.content.toLowerCase().includes('not found');
      msg.content = isError ? '(error — details truncated)' : '(ok — details truncated)';
    }
    // Also truncate long assistant messages
    if (msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.length > 500) {
      msg.content = msg.content.slice(0, 500) + '... (truncated)';
    }
  }
  if (totalTokens(history) <= MAX_HISTORY_TOKENS) return;

  // Phase 3: Drop oldest turns, keep last 10 messages
  const keep = 10;
  if (history.length > keep) {
    // Insert a summary of what was dropped
    const dropped = history.length - keep;
    history.splice(0, dropped, {
      role: 'user',
      content: `(${dropped} earlier messages compressed. Key context: this is an ongoing assistant session managing bots and workflows.)`,
    });
  }
}
