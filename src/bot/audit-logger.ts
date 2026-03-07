import type { AuditEventType, AuditEventCallback } from './types.js';
import { AuditStore } from './audit-store.js';

let store: AuditStore | null = null;
let currentRunId: string | null = null;
let onEvent: AuditEventCallback | undefined;

export function initAuditLogger(runId: string, callback?: AuditEventCallback): void {
  try {
    store = new AuditStore();
  } catch {
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
  } catch {
    // non-fatal
  }

  try {
    onEvent?.(event);
  } catch {
    // non-fatal
  }
}

export function teardownAuditLogger(): void {
  store = null;
  currentRunId = null;
  onEvent = undefined;
}
