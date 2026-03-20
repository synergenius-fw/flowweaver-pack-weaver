import { describe, it, expect } from 'vitest';
import { normalizePlan, parseJsonResponse } from '../src/bot/ai-client.js';

// ---------------------------------------------------------------------------
// normalizePlan
// ---------------------------------------------------------------------------

describe('normalizePlan', () => {
  it('accepts a well-formed plan with steps array', () => {
    const plan = normalizePlan({
      steps: [
        { id: 's1', operation: 'write-file', description: 'Create file', args: { file: 'a.ts', content: 'x' } },
      ],
      summary: 'One step',
    });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].id).toBe('s1');
    expect(plan.summary).toBe('One step');
  });

  it('unwraps plan.steps (nested wrapper)', () => {
    const plan = normalizePlan({
      plan: {
        steps: [{ id: 'a', operation: 'read-file', description: 'Read', args: { file: 'x' } }],
      },
    });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].operation).toBe('read-file');
  });

  it('wraps a bare array as steps', () => {
    const plan = normalizePlan([
      { operation: 'patch-file', args: { file: 'b.ts', find: 'a', replace: 'b' } },
      { operation: 'run-shell', args: { command: 'echo hi' } },
    ]);
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].id).toBe('step-1');
    expect(plan.steps[1].id).toBe('step-2');
    expect(plan.summary).toBe('2 steps');
  });

  it('defaults missing id to step-N', () => {
    const plan = normalizePlan({
      steps: [{ operation: 'write-file', args: { file: 'a.ts', content: 'x' } }],
    });
    expect(plan.steps[0].id).toBe('step-1');
  });

  it('defaults missing args to empty object', () => {
    const plan = normalizePlan({
      steps: [{ id: 'x', operation: 'run-shell' }],
    });
    expect(plan.steps[0].args).toEqual({});
  });

  it('defaults missing description to operation name', () => {
    const plan = normalizePlan({
      steps: [{ id: 'x', operation: 'list-files' }],
    });
    expect(plan.steps[0].description).toBe('list-files');
  });

  it('drops steps without operation', () => {
    const plan = normalizePlan({
      steps: [
        { id: 'a', operation: 'write-file', args: {} },
        { id: 'b', description: 'no op field' },
        { id: 'c', operation: 'read-file', args: {} },
      ],
    });
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps.map(s => s.id)).toEqual(['a', 'c']);
  });

  it('filters out null, non-object, and array entries in steps', () => {
    const plan = normalizePlan({
      steps: [
        null,
        'string-step',
        42,
        [1, 2],
        { operation: 'write-file', args: {} },
      ],
    });
    expect(plan.steps).toHaveLength(1);
  });

  it('returns empty steps and default summary for flat object without steps', () => {
    const plan = normalizePlan({ foo: 'bar' });
    expect(plan.steps).toHaveLength(0);
    expect(plan.summary).toBe('No valid steps in AI response');
  });

  it('returns empty steps with provided summary for flat object', () => {
    const plan = normalizePlan({ summary: 'Nothing to do' });
    expect(plan.steps).toHaveLength(0);
    expect(plan.summary).toBe('Nothing to do');
  });

  it('handles null/undefined input gracefully', () => {
    const plan = normalizePlan(null);
    expect(plan.steps).toHaveLength(0);
  });

  it('preserves summary from top-level object', () => {
    const plan = normalizePlan({
      steps: [{ operation: 'read-file', args: { file: 'x' } }],
      summary: 'Custom summary',
    });
    expect(plan.summary).toBe('Custom summary');
  });
});

// ---------------------------------------------------------------------------
// parseJsonResponse
// ---------------------------------------------------------------------------

describe('parseJsonResponse', () => {
  it('parses clean JSON', () => {
    const result = parseJsonResponse('{"key": "value"}');
    expect(result).toEqual({ key: 'value' });
  });

  it('strips markdown code fences', () => {
    const result = parseJsonResponse('```json\n{"key": "value"}\n```');
    expect(result).toEqual({ key: 'value' });
  });

  it('strips plain code fences', () => {
    const result = parseJsonResponse('```\n{"key": 1}\n```');
    expect(result).toEqual({ key: 1 });
  });

  it('extracts JSON from surrounding text', () => {
    const result = parseJsonResponse('Here is the plan:\n{"steps": []}\nDone.');
    expect(result).toEqual({ steps: [] });
  });

  it('throws on non-JSON text', () => {
    expect(() => parseJsonResponse('I need permission to continue')).toThrow(
      /Failed to parse AI response as JSON/,
    );
  });

  it('handles whitespace-padded JSON', () => {
    const result = parseJsonResponse('  \n  {"a": 1}  \n  ');
    expect(result).toEqual({ a: 1 });
  });
});
