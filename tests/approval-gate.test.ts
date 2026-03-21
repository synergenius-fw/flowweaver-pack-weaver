import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WeaverContext } from '../src/bot/types.js';

vi.mock('../src/bot/audit-logger.js', () => ({
  auditEmit: vi.fn(),
}));

vi.mock('node:readline', () => ({
  createInterface: vi.fn(),
}));

import { weaverApprovalGate } from '../src/node-types/approval-gate.js';
import { auditEmit } from '../src/bot/audit-logger.js';
import * as readline from 'node:readline';

const mockAuditEmit = vi.mocked(auditEmit);
const mockCreateInterface = vi.mocked(readline.createInterface);

function makeCtx(opts: {
  approval?: string | { mode: string };
  autoApprove?: boolean;
} = {}): string {
  const context: WeaverContext = {
    env: {
      projectDir: '/proj',
      config: {
        provider: 'auto',
        ...(opts.approval !== undefined ? { approval: opts.approval as never } : {}),
      } as WeaverContext['env']['config'],
      providerType: 'anthropic',
      providerInfo: { type: 'anthropic' },
    },
    planJson: JSON.stringify({
      steps: [{ id: 'step1', operation: 'run-shell', description: 'do thing' }],
      summary: 'Test plan',
    }),
    taskJson: JSON.stringify({
      instruction: 'test',
      ...(opts.autoApprove !== undefined ? { options: { autoApprove: opts.autoApprove } } : {}),
    }),
  };
  return JSON.stringify(context);
}

describe('weaverApprovalGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (globalThis as Record<string, unknown>).__fw_agent_channel__;
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__fw_agent_channel__;
  });

  it('execute=false returns onSuccess without prompting', async () => {
    const result = await weaverApprovalGate(false, makeCtx());

    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);
    expect(mockCreateInterface).not.toHaveBeenCalled();

    const ctx = JSON.parse(result.ctx) as WeaverContext;
    expect(ctx.rejectionReason).toBe('');
  });

  it('task.options.autoApprove=true skips prompt and returns onSuccess', async () => {
    const result = await weaverApprovalGate(true, makeCtx({ autoApprove: true }));

    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);
    expect(mockCreateInterface).not.toHaveBeenCalled();
    expect(mockAuditEmit).toHaveBeenCalledWith('approval-decision', { approved: true, mode: 'auto' });
  });

  it('config approval="auto" skips prompt and returns onSuccess', async () => {
    const result = await weaverApprovalGate(true, makeCtx({ approval: 'auto' }));

    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);
    expect(mockCreateInterface).not.toHaveBeenCalled();
    expect(mockAuditEmit).toHaveBeenCalledWith('approval-decision', { approved: true, mode: 'auto' });
  });

  it('config approval={mode:"auto"} skips prompt and returns onSuccess', async () => {
    const result = await weaverApprovalGate(true, makeCtx({ approval: { mode: 'auto' } }));

    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);
    expect(mockCreateInterface).not.toHaveBeenCalled();
  });

  it('agent channel approved=true returns onSuccess', async () => {
    (globalThis as Record<string, unknown>).__fw_agent_channel__ = {
      request: vi.fn().mockResolvedValue({ approved: true }),
    };

    const result = await weaverApprovalGate(true, makeCtx());

    expect(result.onSuccess).toBe(true);
    expect(result.onFailure).toBe(false);
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    expect(ctx.rejectionReason).toBe('');
  });

  it('agent channel approved=false returns onFailure with reason', async () => {
    (globalThis as Record<string, unknown>).__fw_agent_channel__ = {
      request: vi.fn().mockResolvedValue({ approved: false, reason: 'too risky' }),
    };

    const result = await weaverApprovalGate(true, makeCtx());

    expect(result.onSuccess).toBe(false);
    expect(result.onFailure).toBe(true);
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    expect(ctx.rejectionReason).toBe('too risky');
  });

  it('readline rejection returns onFailure with the answer as reason', async () => {
    mockCreateInterface.mockReturnValue({
      question: (_prompt: string, cb: (answer: string) => void) => cb('n - looks wrong'),
      close: vi.fn(),
    } as unknown as readline.Interface);

    const result = await weaverApprovalGate(true, makeCtx());

    expect(result.onSuccess).toBe(false);
    expect(result.onFailure).toBe(true);
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    expect(ctx.rejectionReason).toBe('n - looks wrong');
    expect(mockAuditEmit).toHaveBeenCalledWith('approval-decision', {
      approved: false,
      reason: 'n - looks wrong',
    });
  });

  // ── readline approval path ────────────────────────────────────────────────────

  describe('readline approval path', () => {
    function mockAnswer(answer: string): void {
      mockCreateInterface.mockReturnValue({
        question: (_prompt: string, cb: (answer: string) => void) => cb(answer),
        close: vi.fn(),
      } as unknown as readline.Interface);
    }

    it("answer 'y' returns onSuccess=true with empty rejectionReason", async () => {
      mockAnswer('y');
      const result = await weaverApprovalGate(true, makeCtx());
      expect(result.onSuccess).toBe(true);
      expect(result.onFailure).toBe(false);
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(ctx.rejectionReason).toBe('');
    });

    it("answer 'Y' (uppercase) returns onSuccess=true", async () => {
      mockAnswer('Y');
      const result = await weaverApprovalGate(true, makeCtx());
      expect(result.onSuccess).toBe(true);
      expect(result.onFailure).toBe(false);
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(ctx.rejectionReason).toBe('');
    });

    it('empty answer (user presses Enter) returns onSuccess=true', async () => {
      mockAnswer('');
      const result = await weaverApprovalGate(true, makeCtx());
      expect(result.onSuccess).toBe(true);
      expect(result.onFailure).toBe(false);
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(ctx.rejectionReason).toBe('');
    });

    it("answer 'n' returns onFailure=true with reason='n'", async () => {
      mockAnswer('n');
      const result = await weaverApprovalGate(true, makeCtx());
      expect(result.onSuccess).toBe(false);
      expect(result.onFailure).toBe(true);
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(ctx.rejectionReason).toBe('n');
      expect(mockAuditEmit).toHaveBeenCalledWith('approval-decision', { approved: false, reason: 'n' });
    });

    it("answer 'no' returns onFailure=true", async () => {
      mockAnswer('no');
      const result = await weaverApprovalGate(true, makeCtx());
      expect(result.onSuccess).toBe(false);
      expect(result.onFailure).toBe(true);
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(ctx.rejectionReason).toBe('no');
    });

    it('approved via readline: auditEmit called with mode=prompt', async () => {
      mockAnswer('y');
      await weaverApprovalGate(true, makeCtx());
      expect(mockAuditEmit).toHaveBeenCalledWith('approval-decision', { approved: true, mode: 'prompt' });
    });
  });

  describe('agent channel edge cases', () => {
    it('agent channel is called with plan step count in prompt', async () => {
      const requestMock = vi.fn().mockResolvedValue({ approved: true });
      (globalThis as Record<string, unknown>).__fw_agent_channel__ = { request: requestMock };

      await weaverApprovalGate(true, makeCtx());

      expect(requestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('1 steps'),
        }),
      );
    });

    it('agent channel: approved=true sets rejectionReason=""', async () => {
      (globalThis as Record<string, unknown>).__fw_agent_channel__ = {
        request: vi.fn().mockResolvedValue({ approved: true }),
      };

      const result = await weaverApprovalGate(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(ctx.rejectionReason).toBe('');
    });

    it('agent channel: no reason in reject response → default "rejected by agent"', async () => {
      (globalThis as Record<string, unknown>).__fw_agent_channel__ = {
        request: vi.fn().mockResolvedValue({ approved: false }),
      };

      const result = await weaverApprovalGate(true, makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(ctx.rejectionReason).toBe('rejected by agent');
    });

    it('agent channel bypasses execute=false check (runs even when execute=false)', async () => {
      const requestMock = vi.fn().mockResolvedValue({ approved: true });
      (globalThis as Record<string, unknown>).__fw_agent_channel__ = { request: requestMock };

      await weaverApprovalGate(false, makeCtx());

      // agent channel is checked before execute gate in source
      expect(requestMock).toHaveBeenCalled();
    });
  });

  describe('return shape and ctx pass-through', () => {
    it('return shape has onSuccess, onFailure, ctx on approved path', async () => {
      const result = await weaverApprovalGate(false, makeCtx());
      expect(Object.keys(result).sort()).toEqual(['ctx', 'onFailure', 'onSuccess']);
    });

    it('execute=false preserves planJson in returned ctx', async () => {
      const result = await weaverApprovalGate(false, makeCtx());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(ctx.planJson).toBeDefined();
      expect(() => JSON.parse(ctx.planJson!)).not.toThrow();
    });

    it('env.projectDir preserved in ctx on auto-approve path', async () => {
      const result = await weaverApprovalGate(true, makeCtx({ approval: 'auto' }));
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(ctx.env.projectDir).toBe('/proj');
    });

    it('rejectionReason is "" on auto-approve (not undefined)', async () => {
      const result = await weaverApprovalGate(true, makeCtx({ approval: 'auto' }));
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(ctx.rejectionReason).toBe('');
    });
  });
});
