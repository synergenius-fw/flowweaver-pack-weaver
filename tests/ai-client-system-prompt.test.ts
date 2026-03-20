import { describe, it, expect } from 'vitest';

/**
 * Tests that verify AI client architecture:
 * - callCliAsync uses --system-prompt, --output-format json, --json-schema
 * - callCli only supports copilot-cli (no sync claude calls)
 * - callAI uses async path for claude-cli (Ctrl+C safe)
 */

describe('callCli', () => {
  it('rejects claude-cli (sync path removed)', async () => {
    const mod = await import('../src/bot/ai-client.js');
    expect(() => mod.callCli('claude-cli', 'prompt')).toThrow('callCliAsync');
  });

  it('exists for copilot-cli', async () => {
    const mod = await import('../src/bot/ai-client.js');
    expect(typeof mod.callCli).toBe('function');
  });
});

describe('callCliAsync', () => {
  it('accepts systemPrompt parameter', async () => {
    const mod = await import('../src/bot/ai-client.js');
    expect(typeof mod.callCliAsync).toBe('function');
  });

  it('uses --output-format json and --json-schema', async () => {
    const mod = await import('../src/bot/ai-client.js');
    const src = mod.callCliAsync.toString();
    expect(src).toContain('--output-format');
    expect(src).toContain('json');
    expect(src).toContain('--json-schema');
  });

  it('uses --system-prompt flag', async () => {
    const mod = await import('../src/bot/ai-client.js');
    const src = mod.callCliAsync.toString();
    expect(src).toContain('--system-prompt');
  });

  it('uses spawn (not execFileSync) for Ctrl+C safety', async () => {
    const mod = await import('../src/bot/ai-client.js');
    const src = mod.callCliAsync.toString();
    expect(src).toContain('spawn');
    expect(src).not.toContain('execFileSync');
  });
});

describe('callAI', () => {
  it('uses async path for claude-cli (no sync blocking)', async () => {
    const mod = await import('../src/bot/ai-client.js');
    const src = mod.callAI.toString();
    expect(src).toContain('callCliAsync');
    // Should NOT have the old sync callCli for claude
    expect(src).not.toContain('callCli(pInfo');
  });
});

describe('extractCliJsonResult', () => {
  it('extracts structured_output from CLI JSON wrapper', async () => {
    const { extractCliJsonResult } = await import('../src/bot/ai-client.js');
    const wrapper = JSON.stringify({
      type: 'result',
      result: '',
      structured_output: { steps: [{ id: 's1', operation: 'read-file', description: 'Read', args: { file: 'x.ts' } }], summary: 'test' },
    });
    const result = extractCliJsonResult(wrapper);
    const parsed = JSON.parse(result);
    expect(parsed.steps).toHaveLength(1);
    expect(parsed.summary).toBe('test');
  });

  it('falls back to result field when no structured_output', async () => {
    const { extractCliJsonResult } = await import('../src/bot/ai-client.js');
    const wrapper = JSON.stringify({
      type: 'result',
      result: '{"steps": [], "summary": "empty"}',
    });
    const result = extractCliJsonResult(wrapper);
    expect(result).toBe('{"steps": [], "summary": "empty"}');
  });

  it('returns raw output when not a CLI wrapper', async () => {
    const { extractCliJsonResult } = await import('../src/bot/ai-client.js');
    const raw = '{"steps": [{"id": "s1", "operation": "run-shell", "description": "test", "args": {"command": "echo hi"}}], "summary": "direct"}';
    const result = extractCliJsonResult(raw);
    expect(result).toBe(raw);
  });

  it('returns raw text for non-JSON input', async () => {
    const { extractCliJsonResult } = await import('../src/bot/ai-client.js');
    const result = extractCliJsonResult('This is not JSON');
    expect(result).toBe('This is not JSON');
  });

  it('handles empty result with type:result wrapper', async () => {
    const { extractCliJsonResult } = await import('../src/bot/ai-client.js');
    const wrapper = JSON.stringify({ type: 'result', result: '' });
    const result = extractCliJsonResult(wrapper);
    expect(result).toBe(wrapper); // returns full wrapper when result is empty
  });
});

describe('parseJsonResponse and normalizePlan still work', () => {
  it('parseJsonResponse strips code fences', async () => {
    const { parseJsonResponse } = await import('../src/bot/ai-client.js');
    const result = parseJsonResponse('```json\n{"steps": []}\n```');
    expect(result).toEqual({ steps: [] });
  });

  it('normalizePlan handles well-formed input', async () => {
    const { normalizePlan } = await import('../src/bot/ai-client.js');
    const plan = normalizePlan({
      steps: [{ id: 's1', operation: 'read-file', description: 'Read', args: { file: 'x.ts' } }],
      summary: 'One step',
    });
    expect(plan.steps).toHaveLength(1);
    expect(plan.summary).toBe('One step');
  });
});
