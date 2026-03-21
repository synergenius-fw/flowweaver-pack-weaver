import type { WeaverContext } from '../bot/types.js';
import {
  runAgentLoop,
  createAnthropicProvider,
  getOrCreateCliSession,
  killAllCliSessions,
  type AgentProvider,
  type AgentMessage,
  type ToolDefinition,
  type StreamEvent,
  type StreamOptions,
  type ToolEvent,
} from '@synergenius/flow-weaver/agent';
import { WEAVER_TOOLS, createWeaverExecutor } from '../bot/weaver-tools.js';
import { auditEmit } from '../bot/audit-logger.js';
import { withRetry } from '../bot/retry-utils.js';
import { CostTracker } from '../bot/cost-tracker.js';

// Clean up persistent sessions on process exit
let cleanupRegistered = false;
function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const cleanup = () => { try { killAllCliSessions(); } catch (err) { if (process.env.WEAVER_VERBOSE) console.error('[agent-execute] session cleanup failed:', err); } };
  process.on('exit', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
}

/**
 * Adapter: wraps a persistent CliSession as an AgentProvider.
 * The agent loop sends full message history each iteration;
 * we only forward the latest user/tool messages since the session
 * maintains its own conversation state.
 */
class CliSessionProvider implements AgentProvider {
  private sentCount = 0;

  constructor(
    private session: { ready: boolean; spawn: () => Promise<void>; send: (msg: string, systemPrompt?: string) => AsyncGenerator<StreamEvent> },
  ) {}

  async *stream(
    messages: AgentMessage[],
    _tools: ToolDefinition[],
    options?: StreamOptions,
  ): AsyncGenerator<StreamEvent> {
    if (!this.session.ready) await this.session.spawn();

    // Only send new messages (session has history of previous ones)
    const newMessages = messages.slice(this.sentCount);
    this.sentCount = messages.length;

    // Format new messages into a prompt string
    const prompt = newMessages
      .map((m) => {
        if (m.role === 'user') return typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        if (m.role === 'tool') return `Tool result (${m.toolCallId}): ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`;
        return '';
      })
      .filter(Boolean)
      .join('\n');

    if (!prompt) return;

    // Only pass system prompt on the first call
    const systemPrompt = this.sentCount <= messages.length ? options?.systemPrompt : undefined;
    yield* this.session.send(prompt, systemPrompt);
  }

  /** Reset for a new task (new conversation context) */
  resetForNewTask(): void {
    this.sentCount = 0;
  }
}

// Test-only export (tree-shaken in production bundles)
export { CliSessionProvider };

// Re-use StepLogEntry shape from the bot types
type LocalStepLogEntry = { step: string; status: string; detail: string };

/**
 * Tool-use agent execution. Claude drives the entire task via tool calls
 * (validate, read-file, patch-file, run-shell, etc.) in a single continuous
 * conversation. No separate plan or retry loop needed.
 *
 * @flowWeaver nodeType
 * @label Agent Execute
 * @input ctx [order:0] - Weaver context (JSON)
 * @output ctx [order:0] - Weaver context with results (JSON)
 * @output onSuccess [order:-2] - On Success
 * @output onFailure [order:-1] [hidden] - On Failure
 */
export async function weaverAgentExecute(
  execute: boolean,
  ctx: string,
): Promise<{
  onSuccess: boolean; onFailure: boolean;
  ctx: string;
}> {
  const context = JSON.parse(ctx) as WeaverContext;
  const { env } = context;

  if (!execute) {
    context.resultJson = JSON.stringify({ success: true, toolCallCount: 0 });
    context.validationResultJson = '[]';
    context.filesModified = '[]';
    context.stepLogJson = '[]';
    context.allValid = true;
    return { onSuccess: true, onFailure: false, ctx: JSON.stringify(context) };
  }

  const { providerInfo: pInfo, projectDir } = env;
  const task = JSON.parse(context.taskJson!);

  // Build system prompt
  let systemPrompt: string;
  try {
    const mod = await import('../bot/system-prompt.js');
    const basePrompt = await mod.buildSystemPrompt();
    let cliCommands: { name: string; description: string; botCompatible?: boolean; options?: { flags: string; arg?: string; description: string }[] }[] = [];
    try {
      const docMeta = await import('@synergenius/flow-weaver/doc-metadata');
      cliCommands = docMeta.CLI_COMMANDS ?? [];
    } catch (err) { if (process.env.WEAVER_VERBOSE) console.error('[agent-execute] doc-metadata unavailable (older fw):', err); }
    const botPrompt = mod.buildBotSystemPrompt(context.contextBundle, cliCommands, projectDir);
    systemPrompt = basePrompt + '\n\n' + botPrompt;
  } catch (err) {
    if (process.env.WEAVER_VERBOSE) console.error('[agent-execute] system prompt build failed, using fallback:', err);
    systemPrompt = 'You are Weaver, an AI workflow bot. Use the provided tools to complete tasks.';
  }

  const taskPrompt = `Task: ${task.instruction}\nProject directory: ${projectDir}\n${task.targets ? 'Target files: ' + task.targets.join(', ') : ''}`;

  // Create renderer — single source of all terminal output
  const { TerminalRenderer } = await import('../bot/terminal-renderer.js');
  const renderer = new TerminalRenderer({ verbose: !!process.env.WEAVER_VERBOSE });

  auditEmit('run-start', { task: task.instruction });

  try {
    const provider = createProvider(pInfo, projectDir);
    const executor = createWeaverExecutor(projectDir);

    const filesModified: string[] = [];
    const stepLog: LocalStepLogEntry[] = [];
    const taskStart = Date.now();

    // Route tool events through renderer + track state
    const onToolEvent = (event: ToolEvent) => {
      renderer.onToolEvent(event);

      if (event.type === 'tool_call_result') {
        stepLog.push({
          step: event.name,
          status: event.isError ? 'error' : 'ok',
          detail: event.isError ? (event.result ?? '').slice(0, 200) : event.name,
        });
        if ((event.name === 'patch_file' || event.name === 'write_file') && !event.isError && event.args?.file) {
          filesModified.push(event.args.file as string);
        }
      }
    };

    const onStreamEvent = (event: StreamEvent) => renderer.onStreamEvent(event);

    const result = await withRetry(
      () => runAgentLoop(
        provider,
        WEAVER_TOOLS,
        executor,
        [{ role: 'user', content: taskPrompt }],
        { systemPrompt, maxIterations: 15, onToolEvent, onStreamEvent },
      ),
      {
        maxRetries: 3,
        baseDelayMs: 5_000,
        onRetry: (attempt, delay, err) => {
          renderer.warn(`Transient error, retrying in ${delay / 1000}s (attempt ${attempt}/3): ${err.message.slice(0, 80)}`);
        },
      },
    );

    const usage = result.usage;
    const model = pInfo.model ?? 'claude-sonnet-4-6';
    const estimatedCost = CostTracker.estimateCost(model, {
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
    });

    // Post-agent validation gate: don't trust the AI's self-assessment
    const uniqueFiles = [...new Set(filesModified)];
    let validationPassed = result.success;
    if (uniqueFiles.length > 0) {
      try {
        const { weaverValidateGate } = await import('./validate-gate.js');
        const gateCtx: WeaverContext = { ...context, filesModified: JSON.stringify(uniqueFiles) };
        const gateResult = weaverValidateGate(JSON.stringify(gateCtx));
        const gateData = JSON.parse(gateResult.ctx) as WeaverContext;
        if (!gateData.allValid) {
          validationPassed = false;
          renderer.warn('Post-agent validation found errors — task marked as failed');
        }
        context.validationResultJson = gateData.validationResultJson;
      } catch (err) { if (process.env.WEAVER_VERBOSE) console.error('[agent-execute] validate-gate unavailable, skipping:', err); }
    }

    context.resultJson = JSON.stringify({
      success: validationPassed,
      summary: result.summary,
      toolCallCount: result.toolCallCount,
      usage: { inputTokens: usage.promptTokens, outputTokens: usage.completionTokens, estimatedCost },
    });
    context.filesModified = JSON.stringify(uniqueFiles);
    context.stepLogJson = JSON.stringify(stepLog);
    context.allValid = validationPassed;

    auditEmit('run-complete', {
      success: validationPassed,
      toolCalls: result.toolCallCount,
      filesModified: uniqueFiles.length,
      tokens: { in: usage.promptTokens, out: usage.completionTokens },
      estimatedCost,
    });

    renderer.taskEnd(validationPassed, {
      toolCalls: result.toolCallCount,
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
      estimatedCost,
      filesModified: uniqueFiles.length,
      elapsed: Date.now() - taskStart,
    });

    return { onSuccess: validationPassed, onFailure: !validationPassed, ctx: JSON.stringify(context) };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    renderer.error('Agent error', msg);

    context.resultJson = JSON.stringify({ success: false, error: msg });
    context.filesModified = '[]';
    context.stepLogJson = '[]';
    context.allValid = false;

    return { onSuccess: false, onFailure: true, ctx: JSON.stringify(context) };
  }
}

/**
 * Create an AgentProvider from pack-weaver's ProviderInfo.
 */
function createProvider(
  pInfo: { type: string; apiKey?: string; model?: string; maxTokens?: number },
  projectDir?: string,
): AgentProvider {
  const type = pInfo.type ?? 'auto';

  // Explicit Anthropic API
  if (type === 'anthropic' && pInfo.apiKey) {
    return createAnthropicProvider({
      apiKey: pInfo.apiKey,
      model: pInfo.model,
      maxTokens: pInfo.maxTokens,
    });
  }

  // Claude CLI — use persistent session for warm start
  if (type === 'claude-cli') {
    return createSessionProvider(pInfo.model, projectDir);
  }

  // Auto mode: try Anthropic API key from env, then fall back to Claude CLI
  if (type === 'auto') {
    if (process.env.ANTHROPIC_API_KEY) {
      return createAnthropicProvider({
        apiKey: process.env.ANTHROPIC_API_KEY,
        model: pInfo.model,
        maxTokens: pInfo.maxTokens,
      });
    }
    // No API key — use Claude CLI with persistent session
    return createSessionProvider(pInfo.model, projectDir);
  }

  throw new Error(
    `Unsupported provider type: ${type}. Use 'anthropic', 'claude-cli', or 'auto'.`,
  );
}

function createSessionProvider(model?: string, projectDir?: string): CliSessionProvider {
  registerCleanup();
  const key = projectDir ?? process.cwd();
  const session = getOrCreateCliSession(key, {
    binPath: 'claude',
    cwd: key,
    model: model ?? 'claude-sonnet-4-6',
  });
  return new CliSessionProvider(session);
}
