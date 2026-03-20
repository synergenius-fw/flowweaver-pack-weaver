import type { WeaverContext } from '../bot/types.js';
import {
  runAgentLoop,
  createAnthropicProvider,
  createClaudeCliProvider,
  type AgentProvider,
  type ToolEvent,
} from '@synergenius/flow-weaver/agent';
import { WEAVER_TOOLS, createWeaverExecutor } from '../bot/weaver-tools.js';
import { auditEmit } from '../bot/audit-logger.js';

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
    } catch { /* older fw version */ }
    const botPrompt = mod.buildBotSystemPrompt(context.contextBundle, cliCommands);
    systemPrompt = basePrompt + '\n\n' + botPrompt;
  } catch {
    systemPrompt = 'You are Weaver, an AI workflow bot. Use the provided tools to complete tasks.';
  }

  const taskPrompt = `Task: ${task.instruction}\nProject directory: ${projectDir}\n${task.targets ? 'Target files: ' + task.targets.join(', ') : ''}`;

  console.log(`\x1b[36m→ Agent executing: ${task.instruction.slice(0, 80)}\x1b[0m`);
  auditEmit('run-start', { task: task.instruction });

  try {
    // Create provider based on config
    const provider = createProvider(pInfo);
    const executor = createWeaverExecutor(projectDir);

    // Track files modified and step log via callbacks
    const filesModified: string[] = [];
    const stepLog: LocalStepLogEntry[] = [];

    const onToolEvent = (event: ToolEvent) => {
      if (event.type === 'tool_call_start') {
        const args = event.args ?? {};
        const preview = args.file ? String(args.file).split('/').pop() : args.command ? String(args.command).slice(0, 60) : '';
        process.stderr.write(`\x1b[33m  ⚡ ${event.name}(${preview})\x1b[0m\n`);
      }
      if (event.type === 'tool_call_result') {
        const icon = event.isError ? '\x1b[31m  ✗' : '\x1b[32m  →';
        process.stderr.write(`${icon} ${(event.result ?? '').slice(0, 150).replace(/\n/g, ' ')}\x1b[0m\n`);

        stepLog.push({
          step: event.name,
          status: event.isError ? 'error' : 'ok',
          detail: event.isError ? (event.result ?? '').slice(0, 200) : event.name,
        });

        // Track file modifications
        if ((event.name === 'patch_file' || event.name === 'write_file') && !event.isError && event.args?.file) {
          filesModified.push(event.args.file as string);
        }
      }
    };

    const result = await runAgentLoop(
      provider,
      WEAVER_TOOLS,
      executor,
      [{ role: 'user', content: taskPrompt }],
      { systemPrompt, maxIterations: 15, onToolEvent },
    );

    context.resultJson = JSON.stringify({
      success: result.success,
      summary: result.summary,
      toolCallCount: result.toolCallCount,
    });
    context.filesModified = JSON.stringify([...new Set(filesModified)]);
    context.stepLogJson = JSON.stringify(stepLog);
    context.allValid = result.success;

    auditEmit('run-complete', {
      success: result.success,
      toolCalls: result.toolCallCount,
      filesModified: filesModified.length,
    });

    console.log(`\x1b[${result.success ? '32' : '31'}m→ Agent: ${result.summary.slice(0, 100)} (${result.toolCallCount} tool calls)\x1b[0m`);

    return { onSuccess: result.success, onFailure: !result.success, ctx: JSON.stringify(context) };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m→ Agent error: ${msg}\x1b[0m`);

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
function createProvider(pInfo: { type: string; apiKey?: string; model?: string; maxTokens?: number }): AgentProvider {
  if (pInfo.type === 'anthropic' && pInfo.apiKey) {
    return createAnthropicProvider({
      apiKey: pInfo.apiKey,
      model: pInfo.model,
      maxTokens: pInfo.maxTokens,
    });
  }

  if (pInfo.type === 'claude-cli') {
    return createClaudeCliProvider({
      model: pInfo.model,
    });
  }

  // Fallback: try Anthropic with env var
  if (process.env.ANTHROPIC_API_KEY) {
    return createAnthropicProvider({
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: pInfo.model,
      maxTokens: pInfo.maxTokens,
    });
  }

  throw new Error(
    `Unsupported provider type: ${pInfo.type}. Use 'anthropic' with API key or 'claude-cli'.`,
  );
}
