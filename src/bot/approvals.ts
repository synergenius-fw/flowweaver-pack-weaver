import * as readline from 'node:readline';
import type { ApprovalMode, NotificationEvent } from './types.js';
import type { DashboardServer } from './dashboard.js'; // type-only, no circular runtime dep

export interface ApprovalRequest {
  context: Record<string, unknown>;
  prompt: string;
}

export interface ApprovalResult {
  approved: boolean;
  reason: string;
}

export interface ApprovalHandler {
  handle(
    request: ApprovalRequest,
    event: NotificationEvent,
  ): Promise<ApprovalResult>;
}

export interface ApprovalHandlerOptions {
  timeoutSeconds: number;
  webhookUrl?: string;
  notifier: (event: NotificationEvent) => Promise<void>;
  webOpen?: boolean;
  dashboardServer?: DashboardServer;
}

export function createApprovalHandler(
  mode: ApprovalMode,
  options: ApprovalHandlerOptions,
): ApprovalHandler {
  switch (mode) {
    case 'auto':
      return new AutoApproval(options.notifier);
    case 'prompt':
      return new PromptApproval(options.timeoutSeconds, options.notifier);
    case 'webhook':
      return new WebhookApproval(
        options.webhookUrl ?? '',
        options.timeoutSeconds,
        options.notifier,
      );
    case 'timeout-auto':
      return new TimeoutAutoApproval(options.timeoutSeconds, options.notifier);
    case 'web':
      return new LazyWebApproval(options);
  }
}

class AutoApproval implements ApprovalHandler {
  constructor(private notifier: (event: NotificationEvent) => Promise<void>) {}

  async handle(
    _request: ApprovalRequest,
    event: NotificationEvent,
  ): Promise<ApprovalResult> {
    await this.notifier(event);
    return { approved: true, reason: 'auto-approved by Weaver' };
  }
}

class PromptApproval implements ApprovalHandler {
  constructor(
    private timeoutSeconds: number,
    private notifier: (event: NotificationEvent) => Promise<void>,
  ) {}

  async handle(
    request: ApprovalRequest,
    event: NotificationEvent,
  ): Promise<ApprovalResult> {
    await this.notifier(event);

    // Non-TTY: fall back to timeout-auto
    if (!process.stdin.isTTY) {
      console.log(
        `[weaver] No TTY available, auto-approving after ${this.timeoutSeconds}s`,
      );
      await new Promise((r) => setTimeout(r, this.timeoutSeconds * 1000));
      return { approved: true, reason: 'auto-approved (no TTY)' };
    }

    const summary =
      typeof request.context === 'string'
        ? request.context
        : JSON.stringify(request.context, null, 2);

    console.log('\n[weaver] Approval required:');
    console.log(summary.slice(0, 500));
    if (summary.length > 500) console.log('  ... (truncated)');

    const answer = await this.askWithTimeout(
      `\n[weaver] Approve? (y/n, auto-approves in ${this.timeoutSeconds}s): `,
      this.timeoutSeconds,
    );

    if (answer === null) {
      return {
        approved: true,
        reason: `auto-approved after ${this.timeoutSeconds}s timeout`,
      };
    }

    const approved = answer.trim().toLowerCase().startsWith('y');
    return {
      approved,
      reason: approved ? 'approved by user' : 'rejected by user',
    };
  }

  private askWithTimeout(
    prompt: string,
    timeoutSeconds: number,
  ): Promise<string | null> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const timer = setTimeout(() => {
        console.log('\n[weaver] Timeout reached, auto-approving');
        rl.close();
        resolve(null);
      }, timeoutSeconds * 1000);

      rl.question(prompt, (answer) => {
        clearTimeout(timer);
        rl.close();
        resolve(answer);
      });
    });
  }
}

class WebhookApproval implements ApprovalHandler {
  constructor(
    private webhookUrl: string,
    private timeoutSeconds: number,
    private notifier: (event: NotificationEvent) => Promise<void>,
  ) {}

  async handle(
    request: ApprovalRequest,
    event: NotificationEvent,
  ): Promise<ApprovalResult> {
    await this.notifier(event);

    if (!this.webhookUrl) {
      console.error(
        '[weaver] Webhook approval requires webhookUrl in approval config, falling back to timeout-auto',
      );
      await new Promise((r) => setTimeout(r, this.timeoutSeconds * 1000));
      return { approved: true, reason: 'auto-approved (no webhookUrl)' };
    }

    // POST the proposal to the webhook
    try {
      const resp = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'approval-request',
          proposal: request.context,
          prompt: request.prompt,
          timeoutSeconds: this.timeoutSeconds,
        }),
      });

      if (!resp.ok) {
        console.error(
          `[weaver] Webhook POST failed: ${resp.status}, falling back to timeout-auto`,
        );
        await new Promise((r) => setTimeout(r, this.timeoutSeconds * 1000));
        return { approved: true, reason: 'auto-approved (webhook error)' };
      }

      // Poll for response
      const pollUrl =
        resp.headers.get('location') ?? this.webhookUrl + '/status';
      return await this.pollForDecision(pollUrl);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[weaver] Webhook error: ${msg}, falling back to timeout-auto`,
      );
      await new Promise((r) => setTimeout(r, this.timeoutSeconds * 1000));
      return { approved: true, reason: 'auto-approved (webhook error)' };
    }
  }

  private async pollForDecision(url: string): Promise<ApprovalResult> {
    const deadline = Date.now() + this.timeoutSeconds * 1000;
    const interval = 5000;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, interval));

      try {
        const resp = await fetch(url);
        if (!resp.ok) continue;

        const body = (await resp.json()) as {
          approved?: boolean;
          reason?: string;
          pending?: boolean;
        };
        if (body.pending) continue;

        return {
          approved: body.approved ?? true,
          reason: body.reason ?? (body.approved ? 'approved via webhook' : 'rejected via webhook'),
        };
      } catch {
        continue;
      }
    }

    return {
      approved: true,
      reason: `auto-approved after ${this.timeoutSeconds}s webhook timeout`,
    };
  }
}

class TimeoutAutoApproval implements ApprovalHandler {
  constructor(
    private timeoutSeconds: number,
    private notifier: (event: NotificationEvent) => Promise<void>,
  ) {}

  async handle(
    _request: ApprovalRequest,
    event: NotificationEvent,
  ): Promise<ApprovalResult> {
    await this.notifier(event);
    console.log(
      `[weaver] Waiting ${this.timeoutSeconds}s before auto-approving...`,
    );
    await new Promise((r) => setTimeout(r, this.timeoutSeconds * 1000));
    return {
      approved: true,
      reason: `auto-approved after ${this.timeoutSeconds}s timeout`,
    };
  }
}

class LazyWebApproval implements ApprovalHandler {
  private inner: ApprovalHandler | null = null;
  private options: ApprovalHandlerOptions;

  constructor(options: ApprovalHandlerOptions) {
    this.options = options;
  }

  async handle(
    request: ApprovalRequest,
    event: NotificationEvent,
  ): Promise<ApprovalResult> {
    if (!this.inner) {
      const { WebApprovalHandler } = await import('./web-approval.js');
      this.inner = new WebApprovalHandler({
        timeoutSeconds: this.options.timeoutSeconds,
        open: this.options.webOpen ?? true,
        notifier: this.options.notifier,
        dashboardServer: this.options.dashboardServer,
      });
    }
    return this.inner.handle(request, event);
  }
}
