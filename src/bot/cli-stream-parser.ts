import type { StreamChunk } from './types.js';

/**
 * Parse one NDJSON line from `claude --output-format stream-json`.
 * Returns null for unrecognized event types.
 */
export function parseStreamLine(line: string): StreamChunk | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const type = parsed.type as string | undefined;

  if (type === 'content_block_delta') {
    const delta = parsed.delta as { type?: string; text?: string } | undefined;
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      return { type: 'text', text: delta.text };
    }
    return null;
  }

  if (type === 'message_delta') {
    const usage = parsed.usage as Record<string, number> | undefined;
    if (usage) {
      return {
        type: 'usage',
        usage: {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cacheCreationInputTokens: usage.cache_creation_input_tokens,
          cacheReadInputTokens: usage.cache_read_input_tokens,
        },
      };
    }
    return null;
  }

  if (type === 'message_stop') {
    return { type: 'done' };
  }

  return null;
}

/**
 * Concatenate text from collected StreamChunks into a single string.
 */
export function extractTextFromChunks(chunks: StreamChunk[]): string {
  return chunks
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text!)
    .join('');
}
