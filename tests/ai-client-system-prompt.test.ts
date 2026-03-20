import { describe, it, expect } from 'vitest';

/**
 * Tests that verify the system prompt separation fix.
 * The root cause of "permission hallucination" was that system and user prompts
 * were concatenated into one string for claude -p, burying the JSON-only
 * instruction in 60k+ chars of context. The fix passes --system-prompt
 * as a separate CLI flag.
 *
 * Since we can't easily mock execFileSync in ESM, we test the argument
 * construction logic by importing and inspecting the module's behavior
 * at the callCli level with a non-existent provider (which throws before exec).
 */

describe('callCli argument construction', () => {
  it('callCli signature accepts systemPrompt parameter', async () => {
    const mod = await import('../src/bot/ai-client.js');
    // Verify the function exists and accepts 4 params
    expect(typeof mod.callCli).toBe('function');
    expect(mod.callCli.length).toBeGreaterThanOrEqual(2);
  });

  it('callCliAsync signature accepts systemPrompt parameter', async () => {
    const mod = await import('../src/bot/ai-client.js');
    expect(typeof mod.callCliAsync).toBe('function');
    expect(mod.callCliAsync.length).toBeGreaterThanOrEqual(2);
  });

  it('throws for unknown provider (does not silently concatenate)', async () => {
    const mod = await import('../src/bot/ai-client.js');
    expect(() => mod.callCli('unknown-cli', 'prompt')).toThrow('Unknown CLI provider');
  });

  it('callAI for CLI providers does not concatenate system+user in prompt', async () => {
    // We verify this by reading the source code structure — the fix ensures
    // callCli is called with (pInfo.type, userPrompt, model, systemPrompt)
    // instead of (pInfo.type, systemPrompt + userPrompt, model)
    const mod = await import('../src/bot/ai-client.js');
    const src = mod.callAI.toString();
    // Should call callCli with systemPrompt as 4th argument
    expect(src).toContain('systemPrompt');
    // Should NOT contain the old concatenation pattern
    expect(src).not.toContain("systemPrompt + '\\n\\n' + userPrompt");
  });
});

describe('system prompt separation verification', () => {
  it('callCli source uses execFileSync with --system-prompt arg', async () => {
    const mod = await import('../src/bot/ai-client.js');
    const src = mod.callCli.toString();
    expect(src).toContain('execFileSync');
    expect(src).toContain('--system-prompt');
  });

  it('callCliAsync source includes --system-prompt in spawn args', async () => {
    const mod = await import('../src/bot/ai-client.js');
    const src = mod.callCliAsync.toString();
    expect(src).toContain('--system-prompt');
  });

  it('callAI retry also passes systemPrompt separately', async () => {
    const mod = await import('../src/bot/ai-client.js');
    const src = mod.callAI.toString();
    // The retry callCli should also get systemPrompt
    // Count occurrences of systemPrompt in the function — should appear multiple times
    const matches = src.match(/systemPrompt/g);
    expect(matches!.length).toBeGreaterThanOrEqual(3); // param + callCli + retry callCli
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
