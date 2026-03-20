/**
 * Tool-use agent loop — Claude drives the entire task via tool calls.
 *
 * Instead of plan → execute → retry, the AI calls tools directly:
 * validate → sees errors → read_file → sees code → patch_file → validate → done
 *
 * Supports two providers:
 * - Anthropic API: direct streaming with tool_use blocks
 * - Claude CLI: fallback via callCliAsync (no tool loop, uses --json-schema)
 */

import { executeStep } from './step-executor.js';
import type { ProviderInfo, StepLogEntry } from './types.js';

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'validate',
    description: 'Run flow-weaver validate on a workflow file. Returns JSON with errors and warnings. Use this FIRST to discover issues, and AFTER patching to confirm fixes.',
    input_schema: { type: 'object' as const, properties: { file: { type: 'string', description: 'Path to the workflow file to validate' } }, required: ['file'] },
  },
  {
    name: 'read_file',
    description: 'Read a file and return its full contents. Use this to understand file structure before patching.',
    input_schema: { type: 'object' as const, properties: { file: { type: 'string', description: 'Path to the file to read' } }, required: ['file'] },
  },
  {
    name: 'patch_file',
    description: 'Apply surgical find-and-replace patches to a file. Each patch must have exact "find" and "replace" strings. Preferred over write_file for modifications.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file: { type: 'string', description: 'Path to the file to patch' },
        patches: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              find: { type: 'string', description: 'Exact string to find' },
              replace: { type: 'string', description: 'String to replace with' },
            },
            required: ['find', 'replace'],
          },
          description: 'Array of find/replace patches',
        },
      },
      required: ['file', 'patches'],
    },
  },
  {
    name: 'run_shell',
    description: 'Execute a shell command and return output. Use for: npx flow-weaver validate, git status, etc. Blocked: rm -rf, git push, sudo.',
    input_schema: { type: 'object' as const, properties: { command: { type: 'string', description: 'Shell command to execute' } }, required: ['command'] },
  },
  {
    name: 'list_files',
    description: 'List files in a directory, optionally filtered by regex pattern.',
    input_schema: {
      type: 'object' as const,
      properties: {
        directory: { type: 'string', description: 'Directory to list' },
        pattern: { type: 'string', description: 'Optional regex filter pattern' },
      },
      required: ['directory'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file (creates or overwrites). Use patch_file instead for modifications to existing files.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file: { type: 'string', description: 'Path to the file to write' },
        content: { type: 'string', description: 'Complete file content' },
      },
      required: ['file', 'content'],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool execution — delegates to step-executor with all safety guards
// ---------------------------------------------------------------------------

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  projectDir: string,
): Promise<{ result: string; isError: boolean }> {
  // Map tool names to step-executor operations
  const operationMap: Record<string, string> = {
    validate: 'run-shell',
    read_file: 'read-file',
    patch_file: 'patch-file',
    run_shell: 'run-shell',
    list_files: 'list-files',
    write_file: 'write-file',
  };

  const operation = operationMap[name];
  if (!operation) {
    return { result: `Unknown tool: ${name}`, isError: true };
  }

  // Transform validate tool to run-shell with flow-weaver validate command
  let stepArgs = { ...args };
  if (name === 'validate') {
    stepArgs = { command: `npx flow-weaver validate ${args.file} --json` };
  }

  try {
    const result = await executeStep({ operation, args: stepArgs }, projectDir);
    if (result.blocked) {
      return { result: result.blockReason ?? 'Blocked by safety guard', isError: true };
    }
    return { result: result.output ?? 'Done', isError: false };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: msg, isError: true };
  }
}

// ---------------------------------------------------------------------------
// Agent loop result
// ---------------------------------------------------------------------------

export interface AgentLoopResult {
  success: boolean;
  summary: string;
  filesModified: string[];
  stepLog: StepLogEntry[];
  toolCallCount: number;
}

// ---------------------------------------------------------------------------
// Anthropic SSE streaming agent loop
// ---------------------------------------------------------------------------

interface Message {
  role: 'user' | 'assistant' | 'tool';
  content: string | Array<Record<string, unknown>>;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  toolCallId?: string;
}

export async function runAgentLoop(
  pInfo: Pick<ProviderInfo, 'type' | 'apiKey' | 'model' | 'maxTokens'>,
  systemPrompt: string,
  taskPrompt: string,
  projectDir: string,
  maxIterations = 15,
): Promise<AgentLoopResult> {
  if (pInfo.type !== 'anthropic' || !pInfo.apiKey) {
    throw new Error('Agent loop requires Anthropic API provider with API key');
  }

  const messages: Message[] = [{ role: 'user', content: taskPrompt }];
  const filesModified: string[] = [];
  const stepLog: StepLogEntry[] = [];
  let toolCallCount = 0;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Call Anthropic API with streaming
    const { text, toolCalls, finishReason } = await streamAnthropicWithTools(
      pInfo.apiKey,
      pInfo.model ?? 'claude-sonnet-4-20250514',
      systemPrompt,
      messages,
      pInfo.maxTokens ?? 8192,
    );

    // Add assistant response to history
    if (toolCalls.length > 0) {
      messages.push({ role: 'assistant', content: text || '', toolCalls });
    } else if (text) {
      messages.push({ role: 'assistant', content: text });
    }

    // If no tool calls, we're done
    if (finishReason !== 'tool_calls' || toolCalls.length === 0) {
      return {
        success: true,
        summary: text || 'Task completed',
        filesModified: [...new Set(filesModified)],
        stepLog,
        toolCallCount,
      };
    }

    // Execute tool calls and add results to history
    for (const tc of toolCalls) {
      toolCallCount++;
      process.stderr.write(`\x1b[33m  ⚡ ${tc.name}(${formatToolArgs(tc.arguments)})\x1b[0m\n`);

      const { result, isError } = await executeTool(tc.name, tc.arguments, projectDir);

      // Track files modified by patch_file and write_file
      if ((tc.name === 'patch_file' || tc.name === 'write_file') && !isError && tc.arguments.file) {
        filesModified.push(tc.arguments.file as string);
      }

      // Log step
      stepLog.push({
        step: `${tc.name}`,
        status: isError ? 'error' : 'ok',
        detail: isError ? result.slice(0, 200) : `${tc.name}(${formatToolArgs(tc.arguments)})`,
      });

      // Print result preview
      const preview = result.slice(0, 150).replace(/\n/g, ' ');
      const icon = isError ? '\x1b[31m  ✗' : '\x1b[32m  →';
      process.stderr.write(`${icon} ${preview}\x1b[0m\n`);

      // Add tool result to conversation
      messages.push({
        role: 'tool',
        content: result.slice(0, 10000), // Cap tool result to prevent context overflow
        toolCallId: tc.id,
      });
    }
  }

  return {
    success: false,
    summary: `Reached max iterations (${maxIterations})`,
    filesModified: [...new Set(filesModified)],
    stepLog,
    toolCallCount,
  };
}

function formatToolArgs(args: Record<string, unknown>): string {
  if (args.file) return String(args.file).split('/').pop() ?? '';
  if (args.command) return String(args.command).slice(0, 60);
  if (args.directory) return String(args.directory);
  return '';
}

// ---------------------------------------------------------------------------
// Anthropic streaming with tool support
// ---------------------------------------------------------------------------

async function streamAnthropicWithTools(
  apiKey: string,
  model: string,
  systemPrompt: string,
  messages: Message[],
  maxTokens: number,
): Promise<{ text: string; toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; finishReason: string }> {
  // Build Anthropic API request body
  const apiMessages = messages.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }],
      };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const blocks: Array<Record<string, unknown>> = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
      }
      return { role: 'assistant', content: blocks };
    }
    return { role: m.role, content: m.content };
  });

  const body = JSON.stringify({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    stream: true,
    messages: apiMessages,
    tools: TOOLS,
  });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2025-04-15',
      'content-type': 'application/json',
    },
    body,
    signal: AbortSignal.timeout(300_000),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${err.slice(0, 200)}`);
  }

  if (!response.body) throw new Error('No response body');

  // Parse SSE stream
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let textContent = '';
  let finishReason = 'stop';
  const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
  const activeToolUses = new Map<number, { id: string; name: string; jsonChunks: string[] }>();
  let inThinking = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (jsonStr === '[DONE]') continue;

        let event: Record<string, unknown>;
        try { event = JSON.parse(jsonStr); } catch { continue; }

        const eventType = event.type as string;

        if (eventType === 'content_block_start') {
          const block = event.content_block as { type: string; id?: string; name?: string };
          const index = event.index as number;
          if (block.type === 'tool_use' && block.id && block.name) {
            activeToolUses.set(index, { id: block.id, name: block.name, jsonChunks: [] });
          }
          if (block.type === 'thinking') {
            inThinking = true;
            process.stderr.write('\x1b[90m  thinking...');
          }
        }

        if (eventType === 'content_block_delta') {
          const delta = event.delta as Record<string, unknown>;
          const index = event.index as number;

          if (delta.type === 'text_delta' && delta.text) {
            textContent += delta.text as string;
            process.stderr.write(`\x1b[36m${delta.text}\x1b[0m`);
          }
          if (delta.type === 'thinking_delta' && delta.thinking) {
            // Thinking — just show indicator, don't spam
          }
          if (delta.type === 'input_json_delta' && delta.partial_json !== undefined) {
            const active = activeToolUses.get(index);
            if (active) active.jsonChunks.push(delta.partial_json as string);
          }
        }

        if (eventType === 'content_block_stop') {
          const index = event.index as number;
          if (inThinking) {
            process.stderr.write('\x1b[0m\n');
            inThinking = false;
          }
          const active = activeToolUses.get(index);
          if (active) {
            activeToolUses.delete(index);
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(active.jsonChunks.join('')); } catch { /* malformed */ }
            toolCalls.push({ id: active.id, name: active.name, arguments: args });
          }
        }

        if (eventType === 'message_delta') {
          const delta = event.delta as { stop_reason?: string };
          if (delta.stop_reason === 'tool_use') finishReason = 'tool_calls';
          else if (delta.stop_reason === 'end_turn') finishReason = 'stop';
          else if (delta.stop_reason) finishReason = delta.stop_reason;
        }

        if (eventType === 'error') {
          const errObj = event.error as { message?: string };
          throw new Error(`Anthropic stream error: ${errObj?.message ?? 'unknown'}`);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Newline after streamed text
  if (textContent) process.stderr.write('\n');

  return { text: textContent, toolCalls, finishReason };
}
