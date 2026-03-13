import { describe, it, expect, vi, beforeEach } from 'vitest';
import { onExecutionFailure } from '../src/handlers/on-execution-failure.js';
import { onScheduledRun } from '../src/handlers/scheduled-run.js';
import { onBotCompleted } from '../src/handlers/on-bot-completed.js';

describe('onExecutionFailure handler', () => {
  it('returns notified: true with full payload', async () => {
    const result = await onExecutionFailure(true, {
      userId: 'user-1',
      workflowId: 'wf-1',
      executionId: 'exec-1',
      deploymentSlug: 'my-flow',
      error: 'Timeout exceeded',
      executionTimeMs: 120000,
    });
    expect(result.notified).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('handles minimal payload', async () => {
    const result = await onExecutionFailure(true, {});
    expect(result.notified).toBe(true);
  });
});

describe('onScheduledRun handler', () => {
  beforeEach(() => {
    // Clean up any global event bus mock
    delete (globalThis as any).__fw_event_bus__;
  });

  it('returns skipped when no tasks are pending', async () => {
    const result = await onScheduledRun(true, {
      scheduleId: 'sched-1',
      cronExpression: '*/30 * * * *',
      timestamp: Date.now(),
    });
    expect(result.processed).toBe(false);
    expect(result.skipped).toBeDefined();
  });

  it('emits heartbeat event when event bus is available', async () => {
    const mockEmit = vi.fn();
    (globalThis as any).__fw_event_bus__ = { emit: mockEmit };

    await onScheduledRun(true, {
      cronExpression: '*/30 * * * *',
    });

    expect(mockEmit).toHaveBeenCalledWith(
      'pack.weaver.scheduler-heartbeat',
      expect.objectContaining({
        cronExpression: '*/30 * * * *',
        timestamp: expect.any(Number),
      }),
    );
  });

  it('does not throw when event bus is unavailable', async () => {
    delete (globalThis as any).__fw_event_bus__;
    const result = await onScheduledRun(true, {});
    expect(result.processed).toBe(false);
  });
});

describe('onBotCompleted handler', () => {
  beforeEach(() => {
    delete (globalThis as any).__fw_event_bus__;
  });

  it('acknowledges weaver-bot completions', async () => {
    const mockEmit = vi.fn();
    (globalThis as any).__fw_event_bus__ = { emit: mockEmit };

    const result = await onBotCompleted(true, {
      botId: 'weaver-bot',
      executionId: 'exec-42',
      status: 'success',
      executionTimeMs: 5000,
    });

    expect(result.acknowledged).toBe(true);
    expect(mockEmit).toHaveBeenCalledWith(
      'pack.weaver.run-completed',
      expect.objectContaining({
        botId: 'weaver-bot',
        executionId: 'exec-42',
        status: 'success',
      }),
    );
  });

  it('acknowledges weaver-genesis completions', async () => {
    const mockEmit = vi.fn();
    (globalThis as any).__fw_event_bus__ = { emit: mockEmit };

    const result = await onBotCompleted(true, {
      botId: 'weaver-genesis',
      executionId: 'exec-99',
      status: 'completed',
    });

    expect(result.acknowledged).toBe(true);
    expect(mockEmit).toHaveBeenCalledWith(
      'pack.weaver.run-completed',
      expect.objectContaining({ botId: 'weaver-genesis' }),
    );
  });

  it('ignores non-weaver bot completions', async () => {
    const result = await onBotCompleted(true, {
      botId: 'some-other-bot',
      executionId: 'exec-1',
    });

    expect(result.acknowledged).toBe(false);
  });

  it('handles missing event bus gracefully', async () => {
    delete (globalThis as any).__fw_event_bus__;

    const result = await onBotCompleted(true, {
      botId: 'weaver-bot',
      executionId: 'exec-1',
    });

    // Still acknowledges — event bus emission is best-effort
    expect(result.acknowledged).toBe(true);
  });
});
