import { describe, it, expect } from 'vitest';
import { TerminalRenderer, formatTokens, formatElapsed } from '../src/bot/terminal-renderer.js';

describe('formatTokens', () => {
  it('formats small numbers as-is', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
  });

  it('formats thousands with k suffix', () => {
    expect(formatTokens(1000)).toBe('1k');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(15432)).toBe('15.4k');
    expect(formatTokens(999999)).toBe('1000k');
  });

  it('formats millions with M suffix', () => {
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(1_234_567)).toBe('1.2M');
  });
});

describe('formatElapsed', () => {
  it('formats milliseconds', () => {
    expect(formatElapsed(500)).toBe('500ms');
    expect(formatElapsed(50)).toBe('50ms');
  });

  it('formats seconds', () => {
    expect(formatElapsed(1000)).toBe('1.0s');
    expect(formatElapsed(3200)).toBe('3.2s');
    expect(formatElapsed(59999)).toBe('60.0s');
  });

  it('formats minutes', () => {
    expect(formatElapsed(60_000)).toBe('1m');
    expect(formatElapsed(65_000)).toBe('1m 5s');
    expect(formatElapsed(125_000)).toBe('2m 5s');
  });
});

describe('TerminalRenderer', () => {
  function createRenderer(opts?: { verbose?: boolean; quiet?: boolean }) {
    const output: string[] = [];
    const renderer = new TerminalRenderer({
      ...opts,
      noColor: true,
      write: (s: string) => output.push(s),
    });
    return { renderer, output };
  }

  it('renders session start', () => {
    const { renderer, output } = createRenderer();
    renderer.sessionStart({ provider: 'claude-cli' });
    expect(output.join('')).toContain('Session started');
    expect(output.join('')).toContain('claude-cli');
  });

  it('renders session start with parallel and deadline', () => {
    const { renderer, output } = createRenderer();
    renderer.sessionStart({ provider: 'anthropic', parallel: 3, deadline: '18:00' });
    const text = output.join('');
    expect(text).toContain('Parallel: 3');
    expect(text).toContain('Deadline: 18:00');
  });

  it('renders session end with stats', () => {
    const { renderer, output } = createRenderer();
    renderer.sessionEnd({
      tasks: 5, completed: 3, failed: 1,
      totalInputTokens: 10000, totalOutputTokens: 5000,
      totalCost: 0.045, elapsed: 42100,
    });
    const text = output.join('');
    expect(text).toContain('5 tasks');
    expect(text).toContain('3 completed');
    expect(text).toContain('1 failed');
    expect(text).toContain('1 skipped');
    expect(text).toContain('15k tokens');
  });

  it('renders task start with icon', () => {
    const { renderer, output } = createRenderer();
    renderer.taskStart(1, 'Fix validation errors');
    const text = output.join('');
    expect(text).toContain('◆');
    expect(text).toContain('Task 1:');
    expect(text).toContain('Fix validation errors');
  });

  it('truncates long task instructions', () => {
    const { renderer, output } = createRenderer();
    renderer.taskStart(1, 'A'.repeat(100));
    const text = output.join('');
    expect(text).toContain('...');
    expect(text.length).toBeLessThan(200);
  });

  it('renders task end success', () => {
    const { renderer, output } = createRenderer();
    renderer.taskEnd(true, {
      toolCalls: 5, inputTokens: 3000, outputTokens: 1200,
      estimatedCost: 0.012, filesModified: 2, elapsed: 6200,
    });
    const text = output.join('');
    expect(text).toContain('✓');
    expect(text).toContain('completed');
    expect(text).toContain('5 tool calls');
    expect(text).toContain('4.2k tokens');
    expect(text).toContain('$0.012');
    expect(text).toContain('2 files modified');
  });

  it('renders task end failure', () => {
    const { renderer, output } = createRenderer();
    renderer.taskEnd(false, {
      toolCalls: 3, inputTokens: 2000, outputTokens: 500,
      estimatedCost: 0.008, filesModified: 0, elapsed: 8100,
    });
    const text = output.join('');
    expect(text).toContain('✗');
    expect(text).toContain('failed');
  });

  it('renders tool events', () => {
    const { renderer, output } = createRenderer();
    renderer.onToolEvent({ type: 'tool_call_start', name: 'validate', args: { file: 'src/test.ts' } });
    renderer.onToolEvent({ type: 'tool_call_result', name: 'validate', result: '0 errors', isError: false });
    const text = output.join('');
    expect(text).toContain('◆');
    expect(text).toContain('validate');
    expect(text).toContain('test.ts');
    expect(text).toContain('0 errors');
  });

  it('renders tool errors with ✗ icon', () => {
    const { renderer, output } = createRenderer();
    renderer.onToolEvent({ type: 'tool_call_start', name: 'patch_file', args: { file: 'bad.ts' } });
    renderer.onToolEvent({ type: 'tool_call_result', name: 'patch_file', result: 'Find string not found', isError: true });
    const text = output.join('');
    expect(text).toContain('✗');
    expect(text).toContain('Find string not found');
  });

  it('hides thinking in default mode', () => {
    const { renderer, output } = createRenderer();
    renderer.onStreamEvent({ type: 'thinking_delta', text: 'I need to analyze this...' });
    expect(output.join('')).toBe('');
  });

  it('shows thinking in verbose mode', () => {
    const { renderer, output } = createRenderer({ verbose: true });
    renderer.onStreamEvent({ type: 'thinking_delta', text: 'I need to analyze this...\n' });
    expect(output.join('')).toContain('I need to analyze this');
  });

  it('hides text deltas in default mode', () => {
    const { renderer, output } = createRenderer();
    renderer.onStreamEvent({ type: 'text_delta', text: 'Some AI response' });
    expect(output.join('')).toBe('');
  });

  it('shows text deltas in verbose mode', () => {
    const { renderer, output } = createRenderer({ verbose: true });
    renderer.onStreamEvent({ type: 'text_delta', text: 'Some AI response' });
    expect(output.join('')).toContain('Some AI response');
  });

  it('quiet mode suppresses all output', () => {
    const { renderer, output } = createRenderer({ quiet: true });
    renderer.sessionStart({ provider: 'test' });
    renderer.taskStart(1, 'test');
    renderer.onToolEvent({ type: 'tool_call_start', name: 'validate', args: {} });
    renderer.onToolEvent({ type: 'tool_call_result', name: 'validate', result: 'ok' });
    renderer.taskEnd(true, { toolCalls: 1, inputTokens: 100, outputTokens: 50, estimatedCost: 0, filesModified: 0, elapsed: 1000 });
    renderer.sessionEnd({ tasks: 1, completed: 1, failed: 0, totalInputTokens: 100, totalOutputTokens: 50, totalCost: 0, elapsed: 1000 });
    expect(output.join('')).toBe('');
  });

  it('errors always show even in quiet mode', () => {
    const { renderer, output } = createRenderer({ quiet: true });
    renderer.error('Fatal', 'Something broke');
    const text = output.join('');
    expect(text).toContain('✗');
    expect(text).toContain('Fatal');
    expect(text).toContain('Something broke');
  });

  it('info and warn messages render correctly', () => {
    const { renderer, output } = createRenderer();
    renderer.info('Recovered 2 orphaned tasks');
    renderer.warn('Retrying in 5s');
    const text = output.join('');
    expect(text).toContain('[weaver]');
    expect(text).toContain('Recovered 2 orphaned tasks');
    expect(text).toContain('⚠');
    expect(text).toContain('Retrying in 5s');
  });

  it('includes git message in task end', () => {
    const { renderer, output } = createRenderer();
    renderer.taskEnd(true, {
      toolCalls: 2, inputTokens: 1000, outputTokens: 500,
      estimatedCost: 0.005, filesModified: 1, elapsed: 3000,
      gitMessage: 'weaver: fix validation (1 file)',
    });
    expect(output.join('')).toContain('Git: weaver: fix validation (1 file)');
  });
});
