import { execSync } from 'node:child_process';

interface ProviderInfo {
  type: 'anthropic' | 'claude-cli' | 'copilot-cli';
  model?: string;
  maxTokens?: number;
  apiKey?: string;
}

function callCli(provider: string, prompt: string): string {
  if (provider === 'claude-cli') {
    return execSync('claude -p --output-format text', {
      input: prompt,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120_000,
    }).trim();
  }
  if (provider === 'copilot-cli') {
    return execSync('copilot -p --silent --allow-all-tools', {
      input: prompt,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120_000,
    }).trim();
  }
  throw new Error(`Unknown CLI provider: ${provider}`);
}

async function callApi(
  apiKey: string, model: string, maxTokens: number,
  systemPrompt: string, userPrompt: string,
): Promise<string> {
  const body = JSON.stringify({
    model, max_tokens: maxTokens, system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${text.slice(0, 200)}`);
  }
  const json = await response.json() as { content: Array<{ type: string; text: string }> };
  return json.content[0]?.text ?? '';
}

function parseJsonResponse(text: string): Record<string, unknown> {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  try { return JSON.parse(cleaned); } catch { /* fallthrough */ }
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);
  throw new Error(`Failed to parse AI response as JSON: ${text.slice(0, 200)}`);
}

/**
 * Sends task + context to the AI provider and gets back a structured
 * execution plan. The core AI planning node.
 *
 * @flowWeaver nodeType
 * @label Plan Task
 * @input projectDir [order:0] - Project root directory (pass-through)
 * @input config [order:1] - Config (JSON, pass-through)
 * @input providerType [order:2] - Provider type
 * @input providerInfo [order:3] - Provider info (JSON)
 * @input taskJson [order:4] - Task (JSON)
 * @input contextBundle [order:5] - Knowledge bundle
 * @output projectDir [order:0] - Project root directory (pass-through)
 * @output config [order:1] - Config (pass-through)
 * @output providerType [order:2] - Provider type (pass-through)
 * @output providerInfo [order:3] - Provider info (pass-through)
 * @output taskJson [order:4] - Task (pass-through)
 * @output planJson [order:5] - Execution plan (JSON)
 * @output onSuccess [order:-2] - On Success
 * @output onFailure [order:-1] - On Failure
 */
export async function weaverPlanTask(
  execute: boolean,
  projectDir: string,
  config: string,
  providerType: string,
  providerInfo: string,
  taskJson: string,
  contextBundle: string,
): Promise<{
  onSuccess: boolean; onFailure: boolean;
  projectDir: string; config: string; providerType: string; providerInfo: string;
  taskJson: string; planJson: string;
}> {
  const passthrough = { projectDir, config, providerType, providerInfo, taskJson };

  if (!execute) {
    return { onSuccess: true, onFailure: false, ...passthrough, planJson: '{"steps":[],"summary":"dry run"}' };
  }

  const pInfo: ProviderInfo = JSON.parse(providerInfo);
  const task = JSON.parse(taskJson);

  // Build the system prompt with bot instructions
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
      ...passthrough,
      planJson: JSON.stringify(plan),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m→ Planning failed: ${msg}\x1b[0m`);
    return {
      onSuccess: false, onFailure: true,
      ...passthrough,
      planJson: JSON.stringify({ steps: [], summary: `Planning failed: ${msg}` }),
    };
  }
}
