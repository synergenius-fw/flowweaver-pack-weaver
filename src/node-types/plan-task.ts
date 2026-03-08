import type { WeaverContext } from '../bot/types.js';
import { callCli, callApi, parseJsonResponse } from '../bot/ai-client.js';
import { auditEmit } from '../bot/audit-logger.js';

/**
 * Sends task + context to the AI provider and gets back a structured
 * execution plan. The core AI planning node.
 *
 * @flowWeaver nodeType
 * @label Plan Task
 * @input ctx [order:0] - Weaver context (JSON)
 * @output ctx [order:0] - Weaver context with planJson (JSON)
 * @output onSuccess [order:-2] - On Success
 * @output onFailure [order:-1] [hidden] - On Failure
 */
export async function weaverPlanTask(
  execute: boolean,
  ctx: string,
): Promise<{
  onSuccess: boolean; onFailure: boolean;
  ctx: string;
}> {
  const context = JSON.parse(ctx) as WeaverContext;
  const { env } = context;

  if (!execute) {
    context.planJson = '{"steps":[],"summary":"dry run"}';
    return { onSuccess: true, onFailure: false, ctx: JSON.stringify(context) };
  }

  const { providerInfo: pInfo } = env;
  const task = JSON.parse(context.taskJson!);

  let systemPrompt: string;
  try {
    const mod = await import('../bot/system-prompt.js');
    const basePrompt = await mod.buildSystemPrompt();
    let cliCommands: { name: string; description: string; group?: string; botCompatible?: boolean; options?: { flags: string; arg?: string; description: string }[] }[] = [];
    try {
      const docMeta = await import('@synergenius/flow-weaver/doc-metadata');
      cliCommands = docMeta.CLI_COMMANDS ?? [];
    } catch { /* older flow-weaver version */ }
    const botPrompt = mod.buildBotSystemPrompt(context.contextBundle!, cliCommands);
    systemPrompt = basePrompt + '\n\n' + botPrompt;
  } catch {
    systemPrompt = 'You are Weaver, an AI workflow bot. Return ONLY valid JSON with a plan.';
  }

  const userPrompt = `Task: ${task.instruction}\nMode: ${task.mode ?? 'create'}\n${task.targets ? 'Targets: ' + task.targets.join(', ') : ''}\n\nPlan this task. Return a JSON plan with steps and summary.`;

  try {
    let text: string;
    if (pInfo.type === 'anthropic') {
      text = await callApi(
        pInfo.apiKey!,
        pInfo.model ?? 'claude-sonnet-4-6',
        pInfo.maxTokens ?? 8192,
        systemPrompt,
        userPrompt,
      );
    } else {
      text = callCli(pInfo.type, systemPrompt + '\n\n' + userPrompt);
    }

    const plan = parseJsonResponse(text);
    console.log(`\x1b[36m→ Plan: ${(plan as { summary?: string }).summary ?? 'generated'}\x1b[0m`);
    auditEmit('plan-created', { summary: (plan as { summary?: string }).summary, stepCount: (plan as { steps?: unknown[] }).steps?.length ?? 0 });

    context.planJson = JSON.stringify(plan);
    return { onSuccess: true, onFailure: false, ctx: JSON.stringify(context) };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m→ Planning failed: ${msg}\x1b[0m`);
    context.planJson = JSON.stringify({ steps: [], summary: `Planning failed: ${msg}` });
    return { onSuccess: false, onFailure: true, ctx: JSON.stringify(context) };
  }
}
