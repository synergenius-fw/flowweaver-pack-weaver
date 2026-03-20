import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StepLogEntry, RunRecord } from '../src/bot/types.js';

describe('StepLogEntry type', () => {
  it('supports ok status', () => {
    const entry: StepLogEntry = { step: 's1', status: 'ok', detail: 'Done' };
    expect(entry.status).toBe('ok');
    expect(entry.detail).toBe('Done');
  });

  it('supports blocked status', () => {
    const entry: StepLogEntry = { step: 's2', status: 'blocked', detail: 'Path traversal blocked' };
    expect(entry.status).toBe('blocked');
  });

  it('supports error status', () => {
    const entry: StepLogEntry = { step: 's3', status: 'error', detail: 'Timeout' };
    expect(entry.status).toBe('error');
  });

  it('detail is optional', () => {
    const entry: StepLogEntry = { step: 's4', status: 'ok' };
    expect(entry.detail).toBeUndefined();
  });
});

describe('RunRecord with stepLog', () => {
  it('accepts stepLog field', () => {
    const record: RunRecord = {
      id: 'test-id',
      workflowFile: '/test.ts',
      startedAt: '2026-03-20T00:00:00Z',
      finishedAt: '2026-03-20T00:01:00Z',
      durationMs: 60000,
      success: true,
      outcome: 'completed',
      summary: 'Test run',
      dryRun: false,
      stepLog: [
        { step: 's1', status: 'ok', detail: 'Created file' },
        { step: 's2', status: 'blocked', detail: 'Empty content' },
        { step: 's3', status: 'error', detail: 'File not found' },
      ],
    };
    expect(record.stepLog).toHaveLength(3);
    expect(record.stepLog![0].status).toBe('ok');
    expect(record.stepLog![1].status).toBe('blocked');
    expect(record.stepLog![2].status).toBe('error');
  });

  it('stepLog is optional', () => {
    const record: RunRecord = {
      id: 'test-id',
      workflowFile: '/test.ts',
      startedAt: '2026-03-20T00:00:00Z',
      finishedAt: '2026-03-20T00:01:00Z',
      durationMs: 60000,
      success: true,
      outcome: 'completed',
      summary: 'No steps',
      dryRun: false,
    };
    expect(record.stepLog).toBeUndefined();
  });

  it('serializes and deserializes through JSON', () => {
    const log: StepLogEntry[] = [
      { step: 'fix-1', status: 'ok', detail: 'Patched file' },
      { step: 'fix-2', status: 'error', detail: 'Search string not found' },
    ];
    const json = JSON.stringify(log);
    const parsed: StepLogEntry[] = JSON.parse(json);
    expect(parsed).toEqual(log);
  });
});

describe('RunStore with stepLog', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-store-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists and retrieves stepLog in run records', async () => {
    const { RunStore } = await import('../src/bot/run-store.js');
    const store = new RunStore(tmpDir);

    const record: RunRecord = {
      id: 'log-test-id',
      workflowFile: '/test.ts',
      startedAt: '2026-03-20T10:00:00Z',
      finishedAt: '2026-03-20T10:01:00Z',
      durationMs: 60000,
      success: true,
      outcome: 'completed',
      summary: 'With step log',
      dryRun: false,
      stepLog: [
        { step: 'step-1', status: 'ok', detail: 'Write file' },
        { step: 'step-2', status: 'blocked', detail: 'Shrink guard' },
      ],
    };

    store.append(record);

    const retrieved = store.get('log-test-id');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.stepLog).toHaveLength(2);
    expect(retrieved!.stepLog![0].step).toBe('step-1');
    expect(retrieved!.stepLog![0].status).toBe('ok');
    expect(retrieved!.stepLog![1].status).toBe('blocked');
  });

  it('handles records without stepLog (backwards compatible)', async () => {
    const { RunStore } = await import('../src/bot/run-store.js');
    const store = new RunStore(tmpDir);

    const record: RunRecord = {
      id: 'no-log-id',
      workflowFile: '/test.ts',
      startedAt: '2026-03-20T10:00:00Z',
      finishedAt: '2026-03-20T10:01:00Z',
      durationMs: 60000,
      success: false,
      outcome: 'failed',
      summary: 'No step log',
      dryRun: false,
    };

    store.append(record);

    const retrieved = store.get('no-log-id');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.stepLog).toBeUndefined();
  });
});
