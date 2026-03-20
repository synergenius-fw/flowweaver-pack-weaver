import { execSync, spawn } from 'node:child_process';
import { parseStreamLine, extractTextFromChunks } from './cli-stream-parser.js';
import type { ProviderInfo, StreamChunk } from './types.js';

// Strip CLAUDECODE from child env so nested claude CLI invocations work.
const childEnv = { ...process.env };
delete childEnv.CLAUDECODE;

export function callCli(provider: string, prompt: string, model?: string): string {
  if (provider === 'claude-cli') {
    const modelFlag = model ? ` --model ${model}` : '';
    return execSync(`claude -p --output-format text --permission-mode plan${modelFlag}`, {
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

export async function callCliAsync(provider: string, prompt: string, model?: string): Promise<string> {
  if (provider === 'copilot-cli') {
    return callCli(provider, prompt, model);
  }
  if (provider !== 'claude-cli') {
    throw new Error(`Unknown CLI provider: ${provider}`);
  }

  const args = ['-p', '--output-format', 'stream-json', '--permission-mode', 'plan'];
  if (model) args.push('--model', model);

  const child = spawn('claude', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv,
  });

  child.stdin.write(prompt);
  child.stdin.end();

  const timeout = setTimeout(() => child.kill('SIGTERM'), 300_000);

  const chunks: StreamChunk[] = [];
  let buffer = '';

  try {
    for await (const data of child.stdout) {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop()!;

      for (const line of lines) {
        const chunk = parseStreamLine(line);
        if (chunk) chunks.push(chunk);
      }
    }

    if (buffer.trim()) {
      const chunk = parseStreamLine(buffer);
      if (chunk) chunks.push(chunk);
    }
  } finally {
    clearTimeout(timeout);
  }

  await new Promise<void>((resolve, reject) => {
    child.on('close', (code) => {
      if (code && code !== 0) reject(new Error(`claude CLI exited with code ${code}`));
      else resolve();
    });
    child.on('error', reject);
  });

  return extractTextFromChunks(chunks);
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

/**
 * Call the platform-injected AI proxy (routes through IPC to the host process).
 * Available when running inside the Studio sandbox.
 */
export async function callPlatform(
  systemPrompt: string,
  userPrompt: string,
  model?: string,
  maxTokens?: number,
): Promise<string> {
  const provider = (globalThis as any).__fw_llm_provider__;
  if (!provider) throw new Error('Platform AI provider not available');
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
  const response = await provider.chat(messages, { model, maxTokens });
  return response.content ?? '';
}

/**
 * Unified AI call that dispatches to the right backend based on provider type.
 */
export async function callAI(
  pInfo: Pick<ProviderInfo, 'type' | 'apiKey' | 'model' | 'maxTokens'>,
  systemPrompt: string,
  userPrompt: string,
  defaultMaxTokens = 4096,
): Promise<string> {
  if (pInfo.type === 'platform') {
    return callPlatform(systemPrompt, userPrompt, pInfo.model, pInfo.maxTokens ?? defaultMaxTokens);
  }
  if (pInfo.type === 'anthropic') {
    return callApi(
      pInfo.apiKey!,
      pInfo.model ?? 'claude-sonnet-4-6',
      pInfo.maxTokens ?? defaultMaxTokens,
      systemPrompt,
      userPrompt,
    );
  }
  const fullPrompt = systemPrompt + '\n\n' + userPrompt;
  let result: string;
  try {
    result = callCli(pInfo.type, fullPrompt, pInfo.model);
  } catch (err: unknown) {
    // CLI exit code 1 can happen with large prompts — try async as fallback
    try {
      result = await callCliAsync(pInfo.type, fullPrompt, pInfo.model);
    } catch {
      throw err; // re-throw original error
    }
  }

  // If CLI returned non-JSON (permission hallucination), retry once with reinforced prompt
  const trimmed = result.trim();
  if (trimmed && !trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    console.error('\x1b[33m→ AI returned non-JSON, retrying with reinforced prompt...\x1b[0m');
    const retryPrompt = fullPrompt +
      '\n\nIMPORTANT: Your previous response was NOT valid JSON. Return ONLY a JSON object. Do not ask for permission or explain — just output the JSON.';
    return callCli(pInfo.type, retryPrompt, pInfo.model);
  }

  return result;
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

// ---------------------------------------------------------------------------
// Plan normalization — ensures AI responses conform to expected schema
// ---------------------------------------------------------------------------

export interface NormalizedPlan {
  steps: Array<{ id: string; operation: string; description: string; args: Record<string, unknown> }>;
  summary: string;
}

/**
 * Normalize an AI-generated plan into a consistent { steps, summary } shape.
 * Handles: wrapped plans, bare arrays, flat objects, missing fields.
 */
export function normalizePlan(parsed: unknown): NormalizedPlan {
  const obj = parsed as Record<string, unknown>;

  // Case 1: already has steps array
  let steps: unknown[] | undefined;
  if (Array.isArray(obj?.steps)) {
    steps = obj.steps;
  }
  // Case 2: wrapped in plan.steps
  else if (obj?.plan && Array.isArray((obj.plan as Record<string, unknown>).steps)) {
    steps = (obj.plan as Record<string, unknown>).steps as unknown[];
  }
  // Case 3: parsed is itself an array
  else if (Array.isArray(parsed)) {
    steps = parsed;
  }

  if (!steps) {
    return { steps: [], summary: (obj?.summary as string) ?? 'No valid steps in AI response' };
  }

  // Normalize each step
  const normalized = steps
    .filter((s): s is Record<string, unknown> => s != null && typeof s === 'object' && !Array.isArray(s))
    .map((step, idx) => ({
      id: (step.id as string) ?? `step-${idx + 1}`,
      operation: (step.operation as string) ?? '',
      description: (step.description as string) ?? (step.operation as string) ?? `Step ${idx + 1}`,
      args: (step.args as Record<string, unknown>) ?? {},
    }))
    .filter(s => s.operation !== ''); // Drop steps with no operation

  return {
    steps: normalized,
    summary: (obj?.summary as string) ?? `${normalized.length} steps`,
  };
}
