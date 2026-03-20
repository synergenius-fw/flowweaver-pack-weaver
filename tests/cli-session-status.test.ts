import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/cli-handlers.js';

describe('parseArgs — session scheduling flags', () => {
  it('parses session command', () => {
    const opts = parseArgs(['node', 'weaver', 'session']);
    expect(opts.command).toBe('session');
    expect(opts.sessionContinuous).toBe(false);
    expect(opts.sessionUntil).toBeUndefined();
    expect(opts.sessionMaxTasks).toBeUndefined();
  });

  it('parses --continuous flag', () => {
    const opts = parseArgs(['node', 'weaver', 'session', '--continuous']);
    expect(opts.command).toBe('session');
    expect(opts.sessionContinuous).toBe(true);
  });

  it('parses --until HH:MM', () => {
    const opts = parseArgs(['node', 'weaver', 'session', '--until', '10:00']);
    expect(opts.sessionUntil).toBe('10:00');
  });

  it('parses --max-tasks N', () => {
    const opts = parseArgs(['node', 'weaver', 'session', '--max-tasks', '20']);
    expect(opts.sessionMaxTasks).toBe(20);
  });

  it('parses all session flags together', () => {
    const opts = parseArgs([
      'node', 'weaver', 'session',
      '--continuous', '--until', '14:30', '--max-tasks', '5',
    ]);
    expect(opts.sessionContinuous).toBe(true);
    expect(opts.sessionUntil).toBe('14:30');
    expect(opts.sessionMaxTasks).toBe(5);
  });

  it('invalid --max-tasks is undefined', () => {
    const opts = parseArgs(['node', 'weaver', 'session', '--max-tasks', 'abc']);
    expect(opts.sessionMaxTasks).toBeUndefined();
  });
});

describe('parseArgs — status command', () => {
  it('parses status command', () => {
    const opts = parseArgs(['node', 'weaver', 'status']);
    expect(opts.command).toBe('status');
  });

  it('parses status with --json', () => {
    const opts = parseArgs(['node', 'weaver', 'status', '--json']);
    expect(opts.command).toBe('status');
    expect(opts.historyJson).toBe(true);
  });
});

describe('parseArgs — --json flag on all commands', () => {
  it('queue list with --json', () => {
    const opts = parseArgs(['node', 'weaver', 'queue', 'list', '--json']);
    expect(opts.command).toBe('queue');
    expect(opts.historyJson).toBe(true);
  });

  it('costs with --json', () => {
    const opts = parseArgs(['node', 'weaver', 'costs', '--json']);
    expect(opts.command).toBe('costs');
    expect(opts.historyJson).toBe(true);
  });

  it('history with --json', () => {
    const opts = parseArgs(['node', 'weaver', 'history', '--json']);
    expect(opts.command).toBe('history');
    expect(opts.historyJson).toBe(true);
  });

  it('queue retry parses action and id', () => {
    const opts = parseArgs(['node', 'weaver', 'queue', 'retry', 'abc123']);
    expect(opts.command).toBe('queue');
    expect(opts.botTask).toBe('retry');
    expect(opts.botFile).toBe('abc123');
  });

  it('queue retry without id', () => {
    const opts = parseArgs(['node', 'weaver', 'queue', 'retry']);
    expect(opts.command).toBe('queue');
    expect(opts.botTask).toBe('retry');
    expect(opts.botFile).toBeUndefined();
  });
});
