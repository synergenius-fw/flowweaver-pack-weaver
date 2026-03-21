/**
 * Assistant Core — provider-agnostic conversational loop.
 * The user types, the assistant responds with text and tool calls.
 * UI-agnostic: terminal is one frontend, platform AI chat is another.
 *
 * Supports two provider modes:
 * - CLI provider: tools handled internally via MCP bridge (tool_result events)
 * - API provider: tools collected and executed manually (tool_use_start/end events)
 */

import * as path from 'node:path';
import * as os from 'node:os';
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

export interface AssistantDebugTurn {
  turn: number;
  input: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown>; result: string; isError: boolean }>;
  response: string;
  tokensUsed: number;
  systemPromptLength: number;
  insightNudge?: string;
  conversationId: string;
}

export interface AssistantOptions {
  provider: AgentProvider;
  tools: ToolDefinition[];
  executor: ToolExecutor;
  projectDir: string;
  systemPrompt?: string;
  /** Override for testing — provide messages instead of reading stdin */
  inputMessages?: string[];
  /** Watch a directory for file changes and auto-suggest fixes */
  watchDir?: string;
  /** Resume a specific conversation by ID */
  resumeId?: string;
  /** Always start a fresh conversation */
  newConversation?: boolean;
  /** Debug mode: output structured NDJSON per turn, no ANSI, full conversation loop */
  debug?: boolean;
}

const DEFAULT_SYSTEM_PROMPT = `You are Weaver — a hands-on AI assistant for Flow Weaver projects.

You help people build, validate, debug, and manage workflows. You can also spawn autonomous bot workers that execute tasks in the background.

## What you do

Tell me what you want to build or fix. I will:
1. Break it into steps
2. Use tools to read, write, validate, and test code
3. Spawn bots for longer tasks that run in the background
4. Track project health and surface insights proactively
5. Propose bot workflow improvements based on execution patterns
6. Report results — not plans

## How to respond

Be direct and helpful. Adapt to the user — explain more for beginners, less for experts.
When someone asks "what can you do", give a SHORT overview (5-6 lines max), not an exhaustive list. Mention /help for the full reference.

USE TOOLS to fulfill requests. Don't describe what you'd do — do it.
When asked to start a bot, call bot_spawn. For status, call bot_list. For tasks, call queue_add.

## Available tools

${generateToolPromptSection()}

## Terminal output rules

You are running in a terminal. Plain text only.
- No markdown: no **bold**, \`backticks\`, or |tables|
- No emoji
- Use plain dashes for lists, UPPERCASE or "quotes" for emphasis
- Keep responses concise and scannable

## Tool output handling

CRITICAL: These tools display their FULL output directly to the user:
  ${generateVerboseToolList()}
The user ALREADY SEES the complete output from these tools. After calling them:
- Do NOT list, enumerate, or walk through the output
- Do NOT restate what the diagram/description shows
- ONLY add a brief insight the user cannot see (e.g. "Notice the fan-out at step 5 — that's where parallelism happens")
- If the output speaks for itself, say nothing or just "There it is."
For all other tools, you may explain the result briefly.

## Personality

- Helpful, practical, no fluff
- Lead with the RESULT, not narration of what you did. Never start with "Let me...", "Found it.", "Now let me...", "Good, I have..."
- If something fails, say what went wrong and what you'll try next
- Never apologize for tool usage — tools are how you work
- When you don't know something, say so

## Project intelligence

You have access to project health, bot performance, failure patterns, cost trends, and evolution history.
Be proactive: when you see something relevant to what the user is doing, mention it.
At session start, briefly acknowledge the project state if there's something worth noting.
You can propose workflow improvements with genesis_propose when patterns suggest a structural fix.
If a bot workflow needs modification and isn't ejected yet, auto-eject it first.`;


export async function runAssistant(opts: AssistantOptions): Promise<void> {
  const { provider, tools, executor, projectDir } = opts;
  const isDebug = !!opts.debug;
  const out = (s: string) => process.stderr.write(s);

  // Pipe mode: if stdin is not a TTY, read all input as one message
  if (!process.stdin.isTTY && !opts.inputMessages) {
    const chunks: string[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    }
    const pipeInput = chunks.join('').trim();
    if (!pipeInput) {
      process.stderr.write('  No input provided. Pipe a message: echo "describe my workflows" | flow-weaver weaver assistant\n');
      return;
    }

    // Build system prompt for pipe mode
    let systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    try {
      const fsMod = await import('node:fs');
      const pathMod = await import('node:path');
      const planPath = pathMod.resolve(projectDir, '.weaver-plan.md');
      if (fsMod.existsSync(planPath)) {
        const plan = fsMod.readFileSync(planPath, 'utf-8').trim();
        systemPrompt += '\n\n## Project Plan & Vision\n\nAll bots you spawn and tasks you queue MUST align with this plan.\n\n' + plan;
      }
    } catch { /* plan not available */ }

    // Inject project intelligence (ambient awareness)
    try {
      const { ProjectModelStore } = await import('./project-model.js');
      const pms = new ProjectModelStore(projectDir);
      const model = await pms.getOrBuild();
      if (model && (model.health.workflows.length > 0 || model.bots.length > 0)) {
        systemPrompt += '\n\n## Project Intelligence\n\n' + pms.formatSummary(model);
      }
    } catch { /* project model not available yet */ }

    // Run single message, print result, exit
    await runAgentLoop(provider, tools, executor, [{ role: 'user', content: pipeInput }], {
      systemPrompt, maxIterations: 20,
      onStreamEvent: (e) => { if (e.type === 'text_delta') out(e.text); },
      onToolEvent: (e) => {
        if (e.type === 'tool_call_start') out(`\n  ${c.cyan('◆')} ${e.name}\n`);
        if (e.type === 'tool_call_result') out(`  ${c.dim('→')} ${(e.result ?? '').slice(0, 500)}\n`);
      },
    });
    out('\n');
    return;
  }

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

  // Inject project intelligence (ambient awareness)
  try {
    const { ProjectModelStore } = await import('./project-model.js');
    const pms = new ProjectModelStore(projectDir);
    const model = await pms.getOrBuild();
    if (model && (model.health.workflows.length > 0 || model.bots.length > 0)) {
      systemPrompt += '\n\n## Project Intelligence\n\n' + pms.formatSummary(model);
    }
  } catch { /* project model not available yet */ }

  // Persistent conversation store
  const { ConversationStore } = await import('./conversation-store.js');
  const store = new ConversationStore();

  // Resolve conversation: resume, new, or auto
  let conversation: { id: string; title: string; messageCount: number; lastMessageAt: number };
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

  // Resolve versions
  let fwVersion = '?';
  let weaverVersion = '?';
  try {
    const { execFileSync: vExec } = await import('node:child_process');
    fwVersion = vExec('npx', ['flow-weaver', '--version'], { encoding: 'utf-8', cwd: projectDir, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim().replace(/^flow-weaver\s+v?/i, '');
  } catch { /* not available */ }
  try {
    const fsMod = await import('node:fs');
    const url = await import('node:url');
    const packPkg = JSON.parse(fsMod.readFileSync(new url.URL('../../package.json', import.meta.url), 'utf-8'));
    weaverVersion = packPkg.version;
  } catch { /* not available */ }

  // Welcome — detect cloud status from credentials
  let cloudStatus = '';
  let cloudPlan = '';
  try {
    const credPath = path.join(os.homedir(), '.fw', 'credentials.json');
    const fsMod = await import('node:fs');
    if (fsMod.existsSync(credPath)) {
      const creds = JSON.parse(fsMod.readFileSync(credPath, 'utf-8'));
      if (creds.token && creds.expiresAt > Date.now()) {
        cloudPlan = creds.plan ?? 'connected';
        cloudStatus = `Cloud: ${cloudPlan}`;
      } else if (creds.token) {
        cloudStatus = 'Cloud: expired (run "fw login" to refresh)';
      }
    }
  } catch { /* credentials not available */ }

  if (!isDebug) {
    const header = [`weaver assistant v${weaverVersion}`, `flow-weaver v${fwVersion}`];
    if (cloudStatus) header.push(cloudStatus);
    out(`\n  ${c.bold(header[0])}  ${c.dim(`· ${header.slice(1).join('  · ')}`)}\n`);
    out(`  ${c.dim(`Project: ${path.basename(projectDir)}`)}\n`);
    if (!cloudStatus) {
      out(`  ${c.dim('AI: Local (set ANTHROPIC_API_KEY or run "fw login" to connect)')}\n`);
    }
    if (conversation.title) {
      const ago = Math.round((Date.now() - conversation.lastMessageAt) / 60000);
      out(`  ${c.dim(`Resuming: "${conversation.title}" (${conversation.messageCount} messages, ${ago}m ago). /new to start fresh`)}\n`);
    } else {
      out(`  ${c.dim('New conversation')}\n`);
    }
    out(`  ${c.dim('Type your request. Ctrl+C to exit. /help for commands.')}\n`);
    out(`  ${c.dim('Try: "describe my workflows" or "fix validation errors"')}\n\n`);
  }

  // Proactive session greeting with project status
  if (!isDebug) {
    try {
      const { ProjectModelStore } = await import('./project-model.js');
      const pms = new ProjectModelStore(projectDir);
      const model = await pms.getOrBuild();
      if (model && (model.health.workflows.length > 0 || model.bots.length > 0)) {
        out(`  ${c.dim(pms.formatSessionGreeting(model))}\n`);
      }
    } catch { /* project model not available yet */ }
  }

  // Rich input with history, arrows, tab completion, slash commands
  const { RichInput } = await import('./rich-input.js');
  const { getSlashCompletions, handleSlashCommand } = await import('./slash-commands.js');
  const { formatResponse } = await import('./response-formatter.js');

  const richInput = opts.inputMessages ? null : new RichInput({
    historyFile: path.join(os.homedir(), '.weaver', 'input-history.txt'),
    prompt: `${c.cyan('❯')} `,
    completionProvider: (partial) => {
      if (partial.startsWith('/')) return getSlashCompletions(partial);
      return [];
    },
  });

  const getNextInput = opts.inputMessages
    ? (() => {
        let i = 0;
        return (): Promise<string | null> => Promise.resolve(opts.inputMessages![i++] ?? null);
      })()
    : (): Promise<string | null> => richInput!.getInput();

  // Debug mode: collect tool calls and response text per turn
  let debugToolCalls: Array<{ name: string; args: Record<string, unknown>; result: string; isError: boolean }> = [];
  const debugStreamToolNames = new Map<string, string>(); // id -> name for CLI provider tool tracking
  let debugResponseText = '';
  let debugInsightNudge: string | undefined;
  let debugTurnCount = 0;

  let lastStreamType = '';
  const onStreamEvent = (event: StreamEvent) => {
    if (event.type === 'text_delta') {
      if (lastStreamType === 'thinking_delta' && !isDebug) out('\n\n');
      if (isDebug) { debugResponseText += event.text; }
      else { out(event.text); }
    } else if (event.type === 'thinking_delta') {
      if (!isDebug) out(c.dim(event.text));
    }
    // Capture tool events from stream (CLI provider handles tools via MCP,
    // so onToolEvent never fires — we catch them here instead)
    if (isDebug) {
      const e = event as Record<string, unknown>;
      if (event.type === 'tool_use_start') {
        debugStreamToolNames.set(String(e.id), String(e.name));
      }
      if (event.type === 'tool_result') {
        debugToolCalls.push({
          name: debugStreamToolNames.get(String(e.id)) ?? 'unknown',
          args: {},
          result: String(e.result ?? '').slice(0, 2000),
          isError: !!e.isError,
        });
      }
    }
    lastStreamType = event.type;
  };

  let currentToolName = '';
  let currentToolArgs: Record<string, unknown> = {};
  const onToolEvent = (event: { type: string; name: string; args?: Record<string, unknown>; result?: string; isError?: boolean }) => {
    if (event.type === 'tool_call_start') {
      currentToolName = event.name;
      currentToolArgs = event.args ?? {};
      if (!isDebug) {
        const preview = toolPreview(event.name, event.args ?? {});
        out(`\n  ${c.cyan('◆')} ${event.name}${preview ? c.dim(`(${preview})`) : ''}\n`);
      }
    }
    if (event.type === 'tool_call_result') {
      if (isDebug) {
        debugToolCalls.push({
          name: currentToolName,
          args: currentToolArgs,
          result: (event.result ?? '').slice(0, 2000),
          isError: !!event.isError,
        });
      } else {
        const icon = event.isError ? c.red('✗') : c.dim('→');
        const raw = event.result ?? '';
        const isVerboseTool = VERBOSE_TOOL_NAMES.has(event.name);
        if (isVerboseTool && raw.length > 150) {
          out(`  ${icon}\n${raw}\n`);
        } else {
          const result = raw.replace(/\n/g, ' ').slice(0, 200);
          out(`  ${icon} ${result}\n`);
        }
      }
    }
  };

  // Slash command context
  let shouldExit = false;
  const slashCtx = {
    executor,
    out,
    projectDir,
    conversationId: conversation.id,
    onClear: () => { history.length = 0; },
    onExit: () => { shouldExit = true; },
    onNew: () => { history.length = 0; conversation = store.create(projectDir); },
    onVerbose: () => { out(`  ${c.dim('Verbose toggling not yet wired to streaming.')}\n`); },
  };

  // Watch mode: monitor directory for file changes, auto-validate
  let watcher: import('node:fs').FSWatcher | null = null;
  if (opts.watchDir) {
    try {
      const fsMod = await import('node:fs');
      const { execFileSync } = await import('node:child_process');
      watcher = fsMod.watch(opts.watchDir, { recursive: true }, (_event, filename) => {
        if (!filename || !filename.endsWith('.ts')) return;
        const filePath = `${opts.watchDir}/${filename}`;
        try {
          const result = execFileSync('npx', ['flow-weaver', 'validate', filePath, '--json'], {
            encoding: 'utf-8', cwd: projectDir, timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'],
          });
          const parsed = JSON.parse(result);
          const errorCount = parsed.errorCount ?? parsed.errors?.length ?? 0;
          if (errorCount > 0) {
            out(`\n  ${c.yellow('⚠')} ${opts.watchDir}/${filename}: ${errorCount} validation error(s). Ask me to fix them.\n`);
            out(`  ${c.dim('Type a message to fix, or ignore.')}\n`);
          }
        } catch { /* validation failed or not a workflow — ignore */ }
      });
      out(`  ${c.dim(`Watching: ${opts.watchDir}`)}\n\n`);
    } catch { /* watch not available */ }
  }

  // Track which insights have been nudged (by ID) to avoid repetition
  const nudgedInsightIds = new Set<string>();

  // Main conversation loop
  while (!shouldExit) {
    const input = await getNextInput();
    if (input === null) break;
    if (!input.trim()) continue;

    // Handle slash commands
    if (input.startsWith('/')) {
      if (isDebug) {
        // Capture slash command output for debug JSON
        let slashOutput = '';
        const debugSlashCtx = { ...slashCtx, out: (s: string) => { slashOutput += s; } };
        const handled = await handleSlashCommand(input, debugSlashCtx);
        if (handled) {
          debugTurnCount++;
          // Strip ANSI codes for clean debug output
          const clean = slashOutput.replace(/\x1b\[[0-9;]*m/g, '').trim();
          process.stdout.write(JSON.stringify({
            turn: debugTurnCount,
            input,
            slashCommand: true,
            response: clean,
            conversationId: conversation.id,
          }) + '\n');
          continue;
        }
      } else {
        const handled = await handleSlashCommand(input, slashCtx);
        if (handled) continue;
      }
      if (!isDebug) out(`  ${c.dim('Unknown command. Type /help for available commands.')}\n\n`);
      continue;
    }

    out('\n');

    // Reset Ctrl+C counter after successful input
    richInput?.resetCtrlC();

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

      // Sync to cloud if logged in (fire-and-forget)
      store.syncToCloud(conversation.id, [{ role: 'user', content: input }, ...newMessages]).catch(() => {});

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

      // Proactive insight surfacing — update system prompt for next turn
      // Max 3 nudges per session to avoid being annoying
      if (nudgedInsightIds.size < 3) {
        try {
          const { ProjectModelStore } = await import('./project-model.js');
          const { InsightEngine } = await import('./insight-engine.js');
          const pms = new ProjectModelStore(projectDir);
          const model = await pms.getOrBuild();
          const engine = new InsightEngine();
          const insights = engine.analyze(model).filter(i => i.confidence >= 0.6);

          if (insights.length > 0) {
            // Skip insights already nudged (by ID) or mentioned in conversation
            const unsurfaced = insights.filter(insight =>
              !nudgedInsightIds.has(insight.id) &&
              !history.some(m =>
                m.role === 'assistant' &&
                typeof m.content === 'string' &&
                m.content.includes(insight.title)
              )
            );
            if (unsurfaced.length > 0) {
              const top = unsurfaced[0]!;
              nudgedInsightIds.add(top.id);
              const nudge = `\n\n[PROACTIVE CONTEXT: ${top.title}. ${top.description}${top.suggestion ? ` Suggestion: ${top.suggestion}` : ''}. Mention this naturally if relevant, or bring it up if there's a lull.]`;
              if (isDebug) debugInsightNudge = nudge;
              if (!systemPrompt.includes('[PROACTIVE CONTEXT:')) {
                systemPrompt += nudge;
              } else {
                systemPrompt = systemPrompt.replace(/\n\n\[PROACTIVE CONTEXT:.*\]/s, nudge);
              }
            } else {
              // Remove stale nudge from system prompt
              systemPrompt = systemPrompt.replace(/\n\n\[PROACTIVE CONTEXT:.*\]/s, '');
            }
          }
        } catch { /* insights not available */ }
      }

      // Debug mode: emit structured NDJSON per turn
      if (isDebug) {
        debugTurnCount++;
        const debugOutput: AssistantDebugTurn = {
          turn: debugTurnCount,
          input,
          toolCalls: debugToolCalls,
          response: debugResponseText,
          tokensUsed,
          systemPromptLength: systemPrompt.length,
          insightNudge: debugInsightNudge,
          conversationId: conversation.id,
        };
        process.stdout.write(JSON.stringify(debugOutput) + '\n');
        // Reset for next turn
        debugToolCalls = [];
        debugStreamToolNames.clear();
        debugResponseText = '';
        debugInsightNudge = undefined;
      }

      if (!result.success && result.summary) {
        if (!isDebug) out(`\n  ${c.red(result.summary)}\n`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isDebug) {
        process.stdout.write(JSON.stringify({ turn: ++debugTurnCount, error: msg, conversationId: conversation.id }) + '\n');
      } else {
        out(`\n  ${c.red('Error:')} ${msg}\n`);
      }
    }

    if (!isDebug) out('\n');
  }

  watcher?.close();
  richInput?.destroy();
  if (!isDebug) out(`\n  ${c.dim('Goodbye.')}\n\n`);
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
