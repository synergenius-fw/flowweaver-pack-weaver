import type { AuditEventType, AuditEventCallback } from './types.js';
import { AuditStore } from './audit-store.js';

let store: AuditStore | null = null;
let currentRunId: string | null = null;
let onEvent: AuditEventCallback | undefined;

export function initAuditLogger(runId: string, callback?: AuditEventCallback): void {
  try {
    store = new AuditStore();
  } catch (err) {
    if (process.env.WEAVER_VERBOSE) process.stderr.write(`[weaver] audit store init failed: ${err}\n`);
    store = null;
  }
  currentRunId = runId;
  onEvent = callback;
}

export function auditEmit(type: AuditEventType, data?: Record<string, unknown>): void {
  if (!currentRunId) return;

  const event = {
    type,
    timestamp: new Date().toISOString(),
    runId: currentRunId,
    data,
  };

  try {
    store?.emit(event);
  } catch (err) {
    if (process.env.WEAVER_VERBOSE) process.stderr.write(`[weaver] audit emit failed: ${err}\n`);
  }

  try {
    onEvent?.(event);
  } catch (err) {
    if (process.env.WEAVER_VERBOSE) process.stderr.write(`[weaver] audit callback failed: ${err}\n`);
  }
}

export function teardownAuditLogger(): void {
  store = null;
  currentRunId = null;
  onEvent = undefined;
}
