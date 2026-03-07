import { execSync } from 'node:child_process';

// Strip CLAUDECODE from child env so nested claude CLI invocations work.
const childEnv = { ...process.env };
delete childEnv.CLAUDECODE;

export function callCli(provider: string, prompt: string, model?: string): string {
  if (provider === 'claude-cli') {
    const modelFlag = model ? ` --model ${model}` : '';
    return execSync(`claude -p --output-format text${modelFlag}`, {
      input: prompt, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 300_000, env: childEnv,
    }).trim();
  }
  if (provider === 'copilot-cli') {
    return execSync('copilot -p --silent --allow-all-tools', {
      input: prompt, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 300_000, env: childEnv,
    }).trim();
  }
  throw new Error(`Unknown CLI provider: ${provider}`);
}

export async function callApi(
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

export function parseJsonResponse(text: string): Record<string, unknown> {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  try { return JSON.parse(cleaned); } catch { /* fallthrough */ }
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);
  throw new Error(`Failed to parse AI response as JSON: ${text.slice(0, 200)}`);
}
