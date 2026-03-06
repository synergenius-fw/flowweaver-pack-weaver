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
      input: prompt, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000,
    }).trim();
  }
  if (provider === 'copilot-cli') {
    return execSync('copilot -p --silent --allow-all-tools', {
      input: prompt, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000,
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
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
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
 * When validation fails, sends errors + context to the AI and
 * asks it to produce a repair plan.
 *
 * @flowWeaver nodeType
 * @label Fix Errors
 * @input projectDir [order:0] - Project root directory (pass-through)
 * @input config [order:1] - Config (JSON, pass-through)
 * @input providerType [order:2] - Provider type
 * @input providerInfo [order:3] - Provider info (JSON)
 * @input validationResultJson [order:4] - Validation results (JSON)
 * @input taskJson [order:5] - Task (JSON, pass-through)
 * @output projectDir [order:0] - Project root directory (pass-through)
 * @output config [order:1] - Config (pass-through)
 * @output providerType [order:2] - Provider type (pass-through)
 * @output providerInfo [order:3] - Provider info (pass-through)
 * @output fixPlanJson [order:4] - Fix plan (JSON, same schema as planJson)
 * @output taskJson [order:5] - Task (pass-through)
 * @output onSuccess [order:-2] - On Success
 * @output onFailure [order:-1] - On Failure
 */
export async function weaverFixErrors(
  execute: boolean,
  projectDir: string,
  config: string,
  providerType: string,
  providerInfo: string,
  validationResultJson: string,
  taskJson: string,
): Promise<{
  onSuccess: boolean; onFailure: boolean;
  projectDir: string; config: string; providerType: string; providerInfo: string;
  fixPlanJson: string; taskJson: string;
}> {
  const passthrough = { projectDir, config, providerType, providerInfo, taskJson };

  if (!execute) {
    return { onSuccess: true, onFailure: false, ...passthrough, fixPlanJson: '{"steps":[],"summary":"dry run"}' };
  }

  const pInfo: ProviderInfo = JSON.parse(providerInfo);
  const validation = JSON.parse(validationResultJson) as Array<{ file: string; valid: boolean; errors: string[] }>;
  const errors = validation.filter(v => !v.valid);

  if (errors.length === 0) {
    return { onSuccess: true, onFailure: false, ...passthrough, fixPlanJson: '{"steps":[],"summary":"no errors to fix"}' };
  }

  let systemPrompt: string;
  try {
    const mod = await import('../bot/system-prompt.js');
    systemPrompt = await mod.buildSystemPrompt();
  } catch {
    systemPrompt = 'You are Weaver. Return ONLY valid JSON.';
  }

  const errorSummary = errors.map(e => `${e.file}: ${e.errors.join(', ')}`).join('\n');
  const userPrompt = `The following validation errors occurred:\n${errorSummary}\n\nProvide a fix plan as JSON with "steps" and "summary". Each step needs "id", "operation", "description", and "args".`;

  try {
    let text: string;
    if (pInfo.type === 'anthropic') {
      text = await callApi(pInfo.apiKey!, pInfo.model ?? 'claude-sonnet-4-6', pInfo.maxTokens ?? 8192, systemPrompt, userPrompt);
    } else {
      text = callCli(pInfo.type, systemPrompt + '\n\n' + userPrompt);
    }

    const plan = parseJsonResponse(text);
    console.log(`\x1b[36m→ Fix plan: ${(plan as { summary?: string }).summary ?? 'generated'}\x1b[0m`);
    return { onSuccess: true, onFailure: false, ...passthrough, fixPlanJson: JSON.stringify(plan) };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m→ Fix planning failed: ${msg}\x1b[0m`);
    return { onSuccess: false, onFailure: true, ...passthrough, fixPlanJson: JSON.stringify({ steps: [], summary: `Fix failed: ${msg}` }) };
  }
}
