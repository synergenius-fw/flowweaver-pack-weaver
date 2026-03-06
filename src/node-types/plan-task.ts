import type { WeaverEnv } from '../bot/types.js';
import { callCli, callApi, parseJsonResponse } from '../bot/ai-client.js';

/**
 * Sends task + context to the AI provider and gets back a structured
 * execution plan. The core AI planning node.
 *
 * @flowWeaver nodeType
 * @label Plan Task
 * @input env [order:0] - Weaver environment bundle
 * @input taskJson [order:1] - Task (JSON)
 * @input contextBundle [order:2] - Knowledge bundle
 * @output env [order:0] - Weaver environment bundle (pass-through)
 * @output taskJson [order:1] - Task (pass-through)
 * @output planJson [order:2] - Execution plan (JSON)
 * @output onSuccess [order:-2] - On Success
 * @output onFailure [order:-1] - On Failure
 */
export async function weaverPlanTask(
  execute: boolean,
  env: WeaverEnv,
  taskJson: string,
  contextBundle: string,
): Promise<{
  onSuccess: boolean; onFailure: boolean;
  env: WeaverEnv;
  taskJson: string; planJson: string;
}> {
  if (!execute) {
    return { onSuccess: true, onFailure: false, env, taskJson, planJson: '{"steps":[],"summary":"dry run"}' };
  }

  const { providerInfo: pInfo } = env;
  const task = JSON.parse(taskJson);

  let systemPrompt: string;
  try {
    const mod = await import('../bot/system-prompt.js');
    const basePrompt = await mod.buildSystemPrompt();
    const botPrompt = mod.buildBotSystemPrompt(contextBundle);
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

    return {
      onSuccess: true, onFailure: false,
      env, taskJson,
      planJson: JSON.stringify(plan),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m→ Planning failed: ${msg}\x1b[0m`);
    return {
      onSuccess: false, onFailure: true,
      env, taskJson,
      planJson: JSON.stringify({ steps: [], summary: `Planning failed: ${msg}` }),
    };
  }
}
