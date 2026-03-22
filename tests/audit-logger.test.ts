import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  initAuditLogger,
  auditEmit,
  teardownAuditLogger,
} from '../src/bot/audit-logger.js';
import { AuditStore } from '../src/bot/audit-store.js';
import type { AuditEvent } from '../src/bot/types.js';

// ---------------------------------------------------------------------------
// audit-logger module (singleton wrapper)
// ---------------------------------------------------------------------------

describe('audit-logger', () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-logger-'));
    // Point audit logger to our temp dir
    process.env.WEAVER_HISTORY_DIR = tmpDir;
    teardownAuditLogger();
  });

  afterEach(() => {
    teardownAuditLogger();
    process.env = { ...originalEnv };
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- initAuditLogger ---

  it('initializes without errors', () => {
    expect(() => initAuditLogger('run-1')).not.toThrow();
  });

  it('sets up store that persists events', () => {
    initAuditLogger('run-1');
    auditEmit('run-start');

    // Read directly from store to verify persistence
    const store = new AuditStore(tmpDir);
    const events = store.queryRecent();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('run-start');
    expect(events[0]!.runId).toBe('run-1');
  });

  // --- auditEmit ---

  it('does nothing when logger is not initialized', () => {
    // Should not throw even without init
    expect(() => auditEmit('run-start')).not.toThrow();

    // No file should be created
    const filePath = path.join(tmpDir, 'audit.ndjson');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('emits events with correct type, runId, and timestamp', () => {
    initAuditLogger('run-42');
    const before = new Date().toISOString();
    auditEmit('step-complete', { tool: 'read_file' });
    const after = new Date().toISOString();

    const store = new AuditStore(tmpDir);
    const events = store.queryRecent();
    expect(events).toHaveLength(1);

    const event = events[0]!;
    expect(event.type).toBe('step-complete');
    expect(event.runId).toBe('run-42');
    expect(event.timestamp >= before).toBe(true);
    expect(event.timestamp <= after).toBe(true);
    expect(event.data).toEqual({ tool: 'read_file' });
  });

  it('emits multiple events in sequence', () => {
    initAuditLogger('run-1');
    auditEmit('run-start');
    auditEmit('step-start');
    auditEmit('step-complete');
    auditEmit('run-complete');

    const store = new AuditStore(tmpDir);
    const events = store.queryRecent();
    expect(events).toHaveLength(4);
  });

  // --- Callback ---

  it('calls the callback for each emitted event', () => {
    const received: AuditEvent[] = [];
    initAuditLogger('run-1', (event) => received.push(event));

    auditEmit('run-start');
    auditEmit('step-complete');

    expect(received).toHaveLength(2);
    expect(received[0]!.type).toBe('run-start');
    expect(received[1]!.type).toBe('step-complete');
  });

  it('still persists event if callback throws', () => {
    const badCallback = () => {
      throw new Error('callback exploded');
    };

    initAuditLogger('run-1', badCallback);
    // Should not throw
    expect(() => auditEmit('run-start')).not.toThrow();

    // Event should still be persisted
    const store = new AuditStore(tmpDir);
    const events = store.queryRecent();
    expect(events).toHaveLength(1);
  });

  // --- teardownAuditLogger ---

  it('teardown stops emitting events', () => {
    initAuditLogger('run-1');
    auditEmit('run-start');
    teardownAuditLogger();
    auditEmit('step-start'); // Should be ignored

    const store = new AuditStore(tmpDir);
    const events = store.queryRecent();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('run-start');
  });

  it('teardown is safe to call multiple times', () => {
    expect(() => {
      teardownAuditLogger();
      teardownAuditLogger();
      teardownAuditLogger();
    }).not.toThrow();
  });

  // --- Resilience: init failure ---

  it('handles store creation failure gracefully', () => {
    // Use a path that can not be created (file exists where dir should be)
    const blockingFile = path.join(tmpDir, 'blocked');
    fs.writeFileSync(blockingFile, 'not-a-dir');
    process.env.WEAVER_HISTORY_DIR = path.join(blockingFile, 'nested');

    // Should not throw — silently degrades
    expect(() => initAuditLogger('run-1')).not.toThrow();

    // Emit should also not throw (store is null)
    expect(() => auditEmit('run-start')).not.toThrow();
  });
});
