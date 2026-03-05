import type { BotAgentProvider } from './agent-provider.js';
import type { NotificationEvent } from './types.js';

export interface BotChannelContext {
  projectDir: string;
  workflowFile?: string;
  cycle?: number;
}

export class BotAgentChannel {
  private provider: BotAgentProvider;
  private approvalMode: 'auto' | 'timeout-auto';
  private approvalTimeoutSeconds: number;
  private notifier: (event: NotificationEvent) => Promise<void>;
  private context: BotChannelContext;

  constructor(
    provider: BotAgentProvider,
    options: {
      approvalMode: 'auto' | 'timeout-auto';
      approvalTimeoutSeconds: number;
      notifier: (event: NotificationEvent) => Promise<void>;
      context: BotChannelContext;
    },
  ) {
    this.provider = provider;
    this.approvalMode = options.approvalMode;
    this.approvalTimeoutSeconds = options.approvalTimeoutSeconds;
    this.notifier = options.notifier;
    this.context = options.context;
  }

  async request(agentRequest: {
    agentId: string;
    context: Record<string, unknown>;
    prompt: string;
  }): Promise<object> {
    if (agentRequest.agentId.includes('approval')) {
      return this.handleApproval(agentRequest);
    }
    return this.provider.decide(agentRequest);
  }

  private async handleApproval(request: {
    context: Record<string, unknown>;
    prompt: string;
  }): Promise<object> {
    const event: NotificationEvent = {
      type: 'approval-needed',
      cycle: this.context.cycle,
      projectDir: this.context.projectDir,
      workflowFile: this.context.workflowFile,
      proposal: request.context,
    };

    if (this.approvalMode === 'auto') {
      await this.notifier(event);
      return { approved: true, reason: 'auto-approved by Weaver' };
    }

    // timeout-auto: notify, wait, then auto-approve
    await this.notifier(event);
    await new Promise((r) => setTimeout(r, this.approvalTimeoutSeconds * 1000));
    return { approved: true, reason: `auto-approved after ${this.approvalTimeoutSeconds}s timeout` };
  }

  // Compat stubs for AgentChannel interface (used by executor, not by nodes)
  onPause(): Promise<object> {
    return new Promise(() => {});
  }
  resume(_result: object): void {}
  fail(_reason: string): void {}
}
