import { describe, it, expect } from 'vitest';
import { parseStreamLine, extractTextFromChunks } from '../../src/bot/cli-stream-parser.js';
import type { StreamChunk } from '../../src/bot/types.js';

describe('parseStreamLine', () => {
  it('parses content_block_delta text', () => {
    const line = JSON.stringify({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'hello' },
    });
    expect(parseStreamLine(line)).toEqual({ type: 'text', text: 'hello' });
  });

  it('parses message_delta with usage', () => {
    const line = JSON.stringify({
      type: 'message_delta',
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const result = parseStreamLine(line);
    expect(result).toEqual({
      type: 'usage',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: undefined,
        cacheReadInputTokens: undefined,
      },
    });
  });

  it('parses message_delta with cache tokens', () => {
    const line = JSON.stringify({
      type: 'message_delta',
      usage: {
        input_tokens: 200,
        output_tokens: 75,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 30,
      },
    });
    const result = parseStreamLine(line);
    expect(result?.usage?.cacheCreationInputTokens).toBe(50);
    expect(result?.usage?.cacheReadInputTokens).toBe(30);
  });

  it('parses message_stop as done', () => {
    const line = JSON.stringify({ type: 'message_stop' });
    expect(parseStreamLine(line)).toEqual({ type: 'done' });
  });

  it('returns null for unknown types', () => {
    const line = JSON.stringify({ type: 'ping' });
    expect(parseStreamLine(line)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseStreamLine('')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseStreamLine('not json')).toBeNull();
  });

  it('returns null for content_block_delta without text_delta', () => {
    const line = JSON.stringify({
      type: 'content_block_delta',
      delta: { type: 'input_json_delta', partial_json: '{}' },
    });
    expect(parseStreamLine(line)).toBeNull();
  });

  it('returns null for message_delta without usage', () => {
    const line = JSON.stringify({ type: 'message_delta' });
    expect(parseStreamLine(line)).toBeNull();
  });
});

describe('extractTextFromChunks', () => {
  it('concatenates text chunks', () => {
    const chunks: StreamChunk[] = [
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' world' },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'done' },
    ];
    expect(extractTextFromChunks(chunks)).toBe('Hello world');
  });

  it('returns empty string for no text chunks', () => {
    const chunks: StreamChunk[] = [
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'done' },
    ];
    expect(extractTextFromChunks(chunks)).toBe('');
  });

  it('handles empty array', () => {
    expect(extractTextFromChunks([])).toBe('');
  });
});
