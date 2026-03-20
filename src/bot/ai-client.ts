import { execSync, spawn } from 'node:child_process';
import { trackChild } from './child-process-tracker.js';
import type { ProviderInfo } from './types.js';

// Strip CLAUDECODE from child env so nested claude CLI invocations work.
const childEnv = { ...process.env };
delete childEnv.CLAUDECODE;

/** JSON schema for Weaver plan responses — enforced via --json-schema. */
const PLAN_JSON_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          operation: { type: 'string' },
          description: { type: 'string' },
          args: { type: 'object' },
        },
        required: ['id', 'operation', 'description', 'args'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['steps', 'summary'],
});

export function callCli(provider: string, prompt: string, model?: string, systemPrompt?: string): string {
  if (provider === 'copilot-cli') {
    return execSync('copilot -p --silent --allow-all-tools', {
      input: prompt, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 300_000, env: childEnv,
    }).trim();
  }
  throw new Error(`callCli only supports copilot-cli. Use callCliAsync for claude-cli.`);
}

/**
 * Extract the model's response from the claude CLI --output-format json wrapper.
 * With --json-schema: structured_output contains the validated JSON.
 * Without: result contains the raw text.
 */
export function extractCliJsonResult(raw: string): string {
  const trimmed = raw.trim();
  try {
    const wrapper = JSON.parse(trimmed);
    // Prefer structured_output (schema-validated JSON)
    if (wrapper?.structured_output) {
      return JSON.stringify(wrapper.structured_output);
    }
    // Fall back to result field (raw text)
    if (typeof wrapper?.result === 'string' && wrapper.result.trim()) {
      return wrapper.result;
    }
    // If wrapper has type: "result" but empty result, return the whole thing
    if (wrapper?.type === 'result') {
      return trimmed;
    }
  } catch {
    // Not valid JSON wrapper — return raw output
  }
  return trimmed;
}

export async function callCliAsync(provider: string, prompt: string, model?: string, systemPrompt?: string): Promise<string> {
  if (provider === 'copilot-cli') {
    return callCli(provider, prompt, model);
  }
  if (provider !== 'claude-cli') {
    throw new Error(`Unknown CLI provider: ${provider}`);
  }

  // Use --output-format stream-json for real-time feedback + --json-schema for structured output.
  const args = ['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--json-schema', PLAN_JSON_SCHEMA];
  if (model) args.push('--model', model);
  if (systemPrompt) args.push('--system-prompt', systemPrompt);

  const child = spawn('claude', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv,
  });
  trackChild(child);

  // Stream stderr to console for real-time feedback (thinking, progress)
  child.stderr.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) process.stderr.write(`\x1b[90m  ${msg}\x1b[0m\n`);
  });

  child.stdin.write(prompt);
  child.stdin.end();

  const timeout = setTimeout(() => child.kill('SIGTERM'), 300_000);

  // Collect stream-json lines, print partial text messages for feedback
  let resultJson = '';
  let buffer = '';

  try {
    for await (const data of child.stdout) {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop()!;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          // Print thinking/text content as it streams for user feedback
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'thinking' && block.thinking) {
                // Show truncated thinking
                const preview = block.thinking.slice(0, 120).replace(/\n/g, ' ');
                process.stderr.write(`\x1b[90m  💭 ${preview}${block.thinking.length > 120 ? '...' : ''}\x1b[0m\n`);
              } else if (block.type === 'text' && block.text) {
                process.stderr.write(`\x1b[36m  → ${block.text.slice(0, 200)}\x1b[0m\n`);
              }
            }
          }
          // Capture the final result event
          if (event.type === 'result') {
            resultJson = line;
          }
        } catch {
          // Not JSON — ignore partial lines
        }
      }
    }

    // Process remaining buffer
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer);
        if (event.type === 'result') resultJson = buffer;
      } catch { /* ignore */ }
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

  return extractCliJsonResult(resultJson || buffer);
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
  // Async-only path: uses spawn() so Ctrl+C can kill child processes.
  // Also uses --output-format json + --json-schema to enforce JSON output
  // (eliminates hallucination entirely — no retry needed).
  return callCliAsync(pInfo.type, userPrompt, pInfo.model, systemPrompt);
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
