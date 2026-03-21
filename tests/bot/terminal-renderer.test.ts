/**
 * Tests for src/bot/terminal-renderer.ts
 *
 * Uses noColor:true + custom write interceptor throughout so assertions
 * work on plain text rather than ANSI-escaped strings.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  TerminalRenderer,
  formatTokens,
  formatElapsed,
  type RendererOptions,
  type TaskEndStats,
  type SessionEndStats,
} from '../../src/bot/terminal-renderer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRenderer(opts: RendererOptions = {}): { renderer: TerminalRenderer; output: () => string } {
  const lines: string[] = [];
  const renderer = new TerminalRenderer({ noColor: true, write: (s) => lines.push(s), ...opts });
  return { renderer, output: () => lines.join('') };
}

const baseTaskStats: TaskEndStats = {
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  estimatedCost: 0,
  filesModified: 0,
  elapsed: 500,
};

const baseSessionStats: SessionEndStats = {
  tasks: 3,
  completed: 2,
  failed: 1,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCost: 0,
  elapsed: 60_000,
};

// ---------------------------------------------------------------------------
// formatTokens
// ---------------------------------------------------------------------------

describe('formatTokens', () => {
  it('returns raw number for < 1000', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(1)).toBe('1');
    expect(formatTokens(999)).toBe('999');
  });

  it('returns k-suffix for 1000–999999', () => {
    expect(formatTokens(1000)).toBe('1k');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(10_000)).toBe('10k');
    expect(formatTokens(999_999)).toBe('1000k');
  });

  it('strips trailing .0 in k-format', () => {
    expect(formatTokens(5000)).toBe('5k');
    expect(formatTokens(50_000)).toBe('50k');
  });

  it('returns M-suffix for >= 1_000_000', () => {
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(1_500_000)).toBe('1.5M');
    expect(formatTokens(2_000_000)).toBe('2M');
  });

  it('strips trailing .0 in M-format', () => {
    expect(formatTokens(3_000_000)).toBe('3M');
  });
});

// ---------------------------------------------------------------------------
// formatElapsed
// ---------------------------------------------------------------------------

describe('formatElapsed', () => {
  it('returns ms for < 1000', () => {
    expect(formatElapsed(0)).toBe('0ms');
    expect(formatElapsed(500)).toBe('500ms');
    expect(formatElapsed(999)).toBe('999ms');
  });

  it('returns seconds for 1000–59999', () => {
    expect(formatElapsed(1000)).toBe('1.0s');
    expect(formatElapsed(1500)).toBe('1.5s');
    expect(formatElapsed(59_999)).toBe('60.0s');
  });

  it('returns minutes+seconds for >= 60000', () => {
    expect(formatElapsed(60_000)).toBe('1m');
    expect(formatElapsed(90_000)).toBe('1m 30s');
    expect(formatElapsed(120_000)).toBe('2m');
    expect(formatElapsed(125_000)).toBe('2m 5s');
  });

  it('omits seconds when remainder is 0', () => {
    expect(formatElapsed(180_000)).toBe('3m');
    expect(formatElapsed(3_600_000)).toBe('60m');
  });
});

// ---------------------------------------------------------------------------
// sessionStart
// ---------------------------------------------------------------------------

describe('TerminalRenderer.sessionStart', () => {
  it('prints session started with provider', () => {
    const { renderer, output } = makeRenderer();
    renderer.sessionStart({ provider: 'claude' });
    expect(output()).toContain('Session started');
    expect(output()).toContain('Provider: claude');
  });

  it('includes parallel count when > 1', () => {
    const { renderer, output } = makeRenderer();
    renderer.sessionStart({ provider: 'claude', parallel: 3 });
    expect(output()).toContain('Parallel: 3');
  });

  it('omits parallel when 1', () => {
    const { renderer, output } = makeRenderer();
    renderer.sessionStart({ provider: 'claude', parallel: 1 });
    expect(output()).not.toContain('Parallel:');
  });

  it('includes deadline when provided', () => {
    const { renderer, output } = makeRenderer();
    renderer.sessionStart({ provider: 'claude', deadline: '06:00' });
    expect(output()).toContain('Deadline: 06:00');
  });

  it('suppresses all output in quiet mode', () => {
    const { renderer, output } = makeRenderer({ quiet: true });
    renderer.sessionStart({ provider: 'claude', parallel: 2, deadline: '06:00' });
    expect(output()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// sessionEnd
// ---------------------------------------------------------------------------

describe('TerminalRenderer.sessionEnd', () => {
  it('shows task count and completed/failed', () => {
    const { renderer, output } = makeRenderer();
    renderer.sessionEnd(baseSessionStats);
    expect(output()).toContain('3 tasks');
    expect(output()).toContain('2 completed');
    expect(output()).toContain('1 failed');
  });

  it('uses singular "task" when tasks === 1', () => {
    const { renderer, output } = makeRenderer();
    renderer.sessionEnd({ ...baseSessionStats, tasks: 1, completed: 1, failed: 0 });
    expect(output()).toContain('1 task');
    expect(output()).not.toContain('1 tasks');
  });

  it('shows skipped count when tasks > completed + failed', () => {
    const { renderer, output } = makeRenderer();
    renderer.sessionEnd({ ...baseSessionStats, tasks: 5, completed: 2, failed: 1 });
    expect(output()).toContain('2 skipped');
  });

  it('shows token and cost line when totalTokens > 0', () => {
    const { renderer, output } = makeRenderer();
    renderer.sessionEnd({ ...baseSessionStats, totalInputTokens: 1000, totalOutputTokens: 500, totalCost: 0.042 });
    expect(output()).toContain('1.5k tokens');
    expect(output()).toContain('$0.042');
  });

  it('omits token line when totalTokens == 0', () => {
    const { renderer, output } = makeRenderer();
    renderer.sessionEnd({ ...baseSessionStats, totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 });
    expect(output()).not.toContain('tokens');
  });

  it('suppresses all output in quiet mode', () => {
    const { renderer, output } = makeRenderer({ quiet: true });
    renderer.sessionEnd(baseSessionStats);
    expect(output()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// taskStart
// ---------------------------------------------------------------------------

describe('TerminalRenderer.taskStart', () => {
  it('prints task index and instruction', () => {
    const { renderer, output } = makeRenderer();
    renderer.taskStart(1, 'Fix authentication bug');
    expect(output()).toContain('Task 1:');
    expect(output()).toContain('Fix authentication bug');
  });

  it('truncates long instructions to 70 chars with ellipsis', () => {
    const { renderer, output } = makeRenderer();
    const long = 'A'.repeat(80);
    renderer.taskStart(2, long);
    const out = output();
    expect(out).not.toContain(long);
    expect(out).toContain('...');
    // Label should be exactly 70 chars (67 + '...')
    const labelMatch = out.match(/Task 2: (.+)\n/);
    expect(labelMatch![1].length).toBe(70);
  });

  it('does not truncate instructions exactly 70 chars', () => {
    const { renderer, output } = makeRenderer();
    const exact = 'B'.repeat(70);
    renderer.taskStart(3, exact);
    expect(output()).toContain(exact);
    expect(output()).not.toContain('...');
  });

  it('suppresses output in quiet mode', () => {
    const { renderer, output } = makeRenderer({ quiet: true });
    renderer.taskStart(1, 'Some task');
    expect(output()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// taskEnd
// ---------------------------------------------------------------------------

describe('TerminalRenderer.taskEnd', () => {
  it('shows success icon and "completed" on success', () => {
    const { renderer, output } = makeRenderer();
    renderer.taskEnd(true, { ...baseTaskStats });
    expect(output()).toContain('✓');
    expect(output()).toContain('completed');
    expect(output()).not.toContain('failed');
  });

  it('shows failure icon and "failed" on failure', () => {
    const { renderer, output } = makeRenderer();
    renderer.taskEnd(false, { ...baseTaskStats });
    expect(output()).toContain('✗');
    expect(output()).toContain('failed');
  });

  it('shows tool call count in summary line', () => {
    const { renderer, output } = makeRenderer();
    renderer.taskEnd(true, { ...baseTaskStats, toolCalls: 5 });
    expect(output()).toContain('5 tool calls');
  });

  it('shows token count in summary line', () => {
    const { renderer, output } = makeRenderer();
    renderer.taskEnd(true, { ...baseTaskStats, inputTokens: 1000, outputTokens: 200 });
    expect(output()).toContain('1.2k tokens');
  });

  it('shows estimated cost when > 0', () => {
    const { renderer, output } = makeRenderer();
    renderer.taskEnd(true, { ...baseTaskStats, estimatedCost: 0.015 });
    expect(output()).toContain('$0.015');
  });

  it('shows files modified count', () => {
    const { renderer, output } = makeRenderer();
    renderer.taskEnd(true, { ...baseTaskStats, filesModified: 3 });
    expect(output()).toContain('3 files modified');
  });

  it('uses singular "file" when filesModified === 1', () => {
    const { renderer, output } = makeRenderer();
    renderer.taskEnd(true, { ...baseTaskStats, filesModified: 1 });
    expect(output()).toContain('1 file modified');
    expect(output()).not.toContain('1 files');
  });

  it('shows gitMessage when provided', () => {
    const { renderer, output } = makeRenderer();
    renderer.taskEnd(true, { ...baseTaskStats, gitMessage: 'fix: auth bug resolved' });
    expect(output()).toContain('Git: fix: auth bug resolved');
  });

  it('omits summary line when all stats are zero', () => {
    const { renderer, output } = makeRenderer();
    renderer.taskEnd(true, { ...baseTaskStats, toolCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0, filesModified: 0 });
    const out = output();
    expect(out).not.toContain('tool calls');
    expect(out).not.toContain('tokens');
    expect(out).not.toContain('$');
  });

  it('suppresses output in quiet mode', () => {
    const { renderer, output } = makeRenderer({ quiet: true });
    renderer.taskEnd(true, baseTaskStats);
    expect(output()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// onStreamEvent — thinking
// ---------------------------------------------------------------------------

describe('TerminalRenderer.onStreamEvent — thinking_delta', () => {
  it('hides thinking in normal mode', () => {
    const { renderer, output } = makeRenderer();
    renderer.onStreamEvent({ type: 'thinking_delta', text: 'I am thinking...' });
    expect(output()).toBe('');
  });

  it('shows thinking in verbose mode', () => {
    const { renderer, output } = makeRenderer({ verbose: true });
    renderer.onStreamEvent({ type: 'thinking_delta', text: 'I am thinking...' });
    expect(output()).toContain('I am thinking...');
  });

  it('indents multi-line thinking in verbose mode', () => {
    const { renderer, output } = makeRenderer({ verbose: true });
    renderer.onStreamEvent({ type: 'thinking_delta', text: 'line1\nline2' });
    expect(output()).toContain('line1\n  line2');
  });

  it('suppresses thinking in quiet mode even with verbose', () => {
    const { renderer, output } = makeRenderer({ quiet: true, verbose: true });
    renderer.onStreamEvent({ type: 'thinking_delta', text: 'hidden' });
    expect(output()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// onStreamEvent — text_delta
// ---------------------------------------------------------------------------

describe('TerminalRenderer.onStreamEvent — text_delta', () => {
  it('hides AI text in normal mode', () => {
    const { renderer, output } = makeRenderer();
    renderer.onStreamEvent({ type: 'text_delta', text: 'The answer is 42.' });
    expect(output()).toBe('');
  });

  it('shows AI text in verbose mode', () => {
    const { renderer, output } = makeRenderer({ verbose: true });
    renderer.onStreamEvent({ type: 'text_delta', text: 'The answer is 42.' });
    expect(output()).toContain('The answer is 42.');
  });

  it('suppresses text in quiet mode even with verbose', () => {
    const { renderer, output } = makeRenderer({ quiet: true, verbose: true });
    renderer.onStreamEvent({ type: 'text_delta', text: 'visible?' });
    expect(output()).toBe('');
  });

  it('flushes with newline between text and next tool call in verbose mode', () => {
    const { renderer, output } = makeRenderer({ verbose: true });
    renderer.onStreamEvent({ type: 'text_delta', text: 'some text' });
    renderer.onToolEvent({ type: 'tool_call_start', name: 'read_file', args: { file: '/a/b.ts' } });
    // A newline should appear between text and the tool line
    expect(output()).toContain('some text\n');
  });
});

// ---------------------------------------------------------------------------
// onToolEvent
// ---------------------------------------------------------------------------

describe('TerminalRenderer.onToolEvent', () => {
  it('prints tool name on tool_call_start', () => {
    const { renderer, output } = makeRenderer();
    renderer.onToolEvent({ type: 'tool_call_start', name: 'read_file', args: {} });
    expect(output()).toContain('read_file');
  });

  it('shows file preview when args.file is set', () => {
    const { renderer, output } = makeRenderer();
    renderer.onToolEvent({ type: 'tool_call_start', name: 'read_file', args: { file: '/some/path/foo.ts' } });
    expect(output()).toContain('foo.ts');
  });

  it('shows command preview when args.command is set', () => {
    const { renderer, output } = makeRenderer();
    renderer.onToolEvent({ type: 'tool_call_start', name: 'run_shell', args: { command: 'ls -la' } });
    expect(output()).toContain('ls -la');
  });

  it('shows directory basename preview when args.directory is set', () => {
    const { renderer, output } = makeRenderer();
    renderer.onToolEvent({ type: 'tool_call_start', name: 'list_files', args: { directory: '/some/dir/src' } });
    expect(output()).toContain('src');
  });

  it('shows success icon on tool_call_result without error', () => {
    const { renderer, output } = makeRenderer();
    renderer.onToolEvent({ type: 'tool_call_start', name: 'foo', args: {} });
    renderer.onToolEvent({ type: 'tool_call_result', name: 'foo', result: 'ok', isError: false });
    expect(output()).toContain('→');
    expect(output()).toContain('ok');
  });

  it('shows error icon on tool_call_result with isError', () => {
    const { renderer, output } = makeRenderer();
    renderer.onToolEvent({ type: 'tool_call_start', name: 'foo', args: {} });
    renderer.onToolEvent({ type: 'tool_call_result', name: 'foo', result: 'something went wrong', isError: true });
    expect(output()).toContain('✗');
    expect(output()).toContain('something went wrong');
  });

  it('truncates long results to 200 chars', () => {
    const { renderer, output } = makeRenderer();
    renderer.onToolEvent({ type: 'tool_call_start', name: 'foo', args: {} });
    const longResult = 'X'.repeat(300);
    renderer.onToolEvent({ type: 'tool_call_result', name: 'foo', result: longResult, isError: false });
    const out = output();
    // The result portion should not contain the full 300-char string
    expect(out).not.toContain(longResult);
    expect(out).toContain('X'.repeat(200));
  });

  it('collapses newlines in result to spaces', () => {
    const { renderer, output } = makeRenderer();
    renderer.onToolEvent({ type: 'tool_call_start', name: 'foo', args: {} });
    renderer.onToolEvent({ type: 'tool_call_result', name: 'foo', result: 'line1\nline2', isError: false });
    expect(output()).toContain('line1 line2');
  });

  it('suppresses all tool events in quiet mode', () => {
    const { renderer, output } = makeRenderer({ quiet: true });
    renderer.onToolEvent({ type: 'tool_call_start', name: 'read_file', args: { file: 'foo.ts' } });
    renderer.onToolEvent({ type: 'tool_call_result', name: 'read_file', result: 'content', isError: false });
    expect(output()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// info / warn / error
// ---------------------------------------------------------------------------

describe('TerminalRenderer.info', () => {
  it('prints message with [weaver] prefix', () => {
    const { renderer, output } = makeRenderer();
    renderer.info('hello world');
    expect(output()).toContain('[weaver]');
    expect(output()).toContain('hello world');
  });

  it('suppresses in quiet mode', () => {
    const { renderer, output } = makeRenderer({ quiet: true });
    renderer.info('should be hidden');
    expect(output()).toBe('');
  });
});

describe('TerminalRenderer.warn', () => {
  it('prints warning with ⚠ icon', () => {
    const { renderer, output } = makeRenderer();
    renderer.warn('disk almost full');
    expect(output()).toContain('⚠');
    expect(output()).toContain('disk almost full');
  });

  it('suppresses in quiet mode', () => {
    const { renderer, output } = makeRenderer({ quiet: true });
    renderer.warn('nope');
    expect(output()).toBe('');
  });
});

describe('TerminalRenderer.error', () => {
  it('prints error title with ✗ icon', () => {
    const { renderer, output } = makeRenderer();
    renderer.error('Connection failed');
    expect(output()).toContain('✗');
    expect(output()).toContain('Connection failed');
  });

  it('prints optional detail on second line', () => {
    const { renderer, output } = makeRenderer();
    renderer.error('Connection failed', 'ECONNREFUSED 127.0.0.1:5432');
    expect(output()).toContain('Connection failed');
    expect(output()).toContain('ECONNREFUSED 127.0.0.1:5432');
  });

  it('always prints even in quiet mode', () => {
    const { renderer, output } = makeRenderer({ quiet: true });
    renderer.error('Critical error');
    expect(output()).toContain('Critical error');
  });
});

// ---------------------------------------------------------------------------
// Verbose mode — overall behavior
// ---------------------------------------------------------------------------

describe('verbose mode', () => {
  it('shows both thinking and text events', () => {
    const { renderer, output } = makeRenderer({ verbose: true });
    renderer.onStreamEvent({ type: 'thinking_delta', text: 'thinking...' });
    renderer.onStreamEvent({ type: 'text_delta', text: 'answer.' });
    const out = output();
    expect(out).toContain('thinking...');
    expect(out).toContain('answer.');
  });
});

// ---------------------------------------------------------------------------
// Quiet mode — overall behavior
// ---------------------------------------------------------------------------

describe('quiet mode', () => {
  it('suppresses sessionStart, taskStart, taskEnd, onStreamEvent, onToolEvent', () => {
    const { renderer, output } = makeRenderer({ quiet: true });
    renderer.sessionStart({ provider: 'claude' });
    renderer.taskStart(1, 'Do something');
    renderer.onStreamEvent({ type: 'text_delta', text: 'Some AI response' });
    renderer.onToolEvent({ type: 'tool_call_start', name: 'read_file', args: {} });
    renderer.taskEnd(true, baseTaskStats);
    renderer.sessionEnd(baseSessionStats);
    expect(output()).toBe('');
  });

  it('still shows error() in quiet mode', () => {
    const { renderer, output } = makeRenderer({ quiet: true });
    renderer.error('Unrecoverable failure');
    expect(output()).toContain('Unrecoverable failure');
  });
});
