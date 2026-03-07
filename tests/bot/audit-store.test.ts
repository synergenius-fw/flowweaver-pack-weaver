import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AuditStore } from '../../src/bot/audit-store.js';
import { initAuditLogger, auditEmit, teardownAuditLogger } from '../../src/bot/audit-logger.js';
import type { AuditEvent } from '../../src/bot/types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
});

afterEach(() => {
  teardownAuditLogger();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('AuditStore', () => {
  it('emits and queries events by runId', () => {
    const store = new AuditStore(tmpDir);
    const event: AuditEvent = {
      type: 'run-start',
      timestamp: new Date().toISOString(),
      runId: 'test-run-1',
      data: { workflowFile: 'test.ts' },
    };

    store.emit(event);
    store.emit({ ...event, type: 'run-complete', data: { success: true } });

    const results = store.queryByRun('test-run-1');
    expect(results).toHaveLength(2);
    expect(results[0]!.type).toBe('run-start');
    expect(results[1]!.type).toBe('run-complete');
  });

  it('queries recent events with limit', () => {
    const store = new AuditStore(tmpDir);
    for (let i = 0; i < 10; i++) {
      store.emit({
        type: 'run-start',
        timestamp: new Date().toISOString(),
        runId: `run-${i}`,
      });
    }

    const recent = store.queryRecent(5);
    expect(recent).toHaveLength(5);
    expect(recent[0]!.runId).toBe('run-5');
  });

  it('prunes old events', () => {
    const store = new AuditStore(tmpDir);
    const oldDate = new Date(Date.now() - 100 * 86_400_000).toISOString();
    const newDate = new Date().toISOString();

    store.emit({ type: 'run-start', timestamp: oldDate, runId: 'old' });
    store.emit({ type: 'run-start', timestamp: newDate, runId: 'new' });

    const pruned = store.prune(30);
    expect(pruned).toBe(1);

    const remaining = store.queryRecent(100);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.runId).toBe('new');
  });

  it('clears all events', () => {
    const store = new AuditStore(tmpDir);
    store.emit({ type: 'run-start', timestamp: new Date().toISOString(), runId: 'test' });

    expect(store.clear()).toBe(true);
    expect(store.queryRecent(100)).toHaveLength(0);
    expect(store.clear()).toBe(false);
  });
});

describe('auditLogger singleton', () => {
  it('emits events to store when initialized', () => {
    initAuditLogger('singleton-run', undefined);
    // Point the store at tmpDir by setting env
    // The singleton uses its own store, so we check via callback
    const events: AuditEvent[] = [];
    teardownAuditLogger();

    initAuditLogger('singleton-run', (e) => events.push(e));
    auditEmit('plan-created', { summary: 'test plan', stepCount: 3 });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('plan-created');
    expect(events[0]!.runId).toBe('singleton-run');
    expect(events[0]!.data).toEqual({ summary: 'test plan', stepCount: 3 });
  });

  it('is a no-op before initialization', () => {
    // Should not throw
    auditEmit('run-start', { test: true });
  });

  it('is a no-op after teardown', () => {
    const events: AuditEvent[] = [];
    initAuditLogger('teardown-test', (e) => events.push(e));
    teardownAuditLogger();
    auditEmit('run-start', { test: true });
    expect(events).toHaveLength(0);
  });

  it('fires callback for each event', () => {
    const events: AuditEvent[] = [];
    initAuditLogger('callback-test', (e) => events.push(e));

    auditEmit('run-start', { provider: 'claude-cli' });
    auditEmit('plan-created', { stepCount: 2 });
    auditEmit('run-complete', { success: true });

    expect(events).toHaveLength(3);
    expect(events.map((e) => e.type)).toEqual(['run-start', 'plan-created', 'run-complete']);
  });
});
