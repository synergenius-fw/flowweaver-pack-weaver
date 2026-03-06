import type { BotAgentProvider } from './agent-provider.js';
import type { ApprovalMode, NotificationEvent, StreamChunk, ToolDefinition, ToolUseResult } from './types.js';
import { createApprovalHandler } from './approvals.js';
import type { DashboardServer } from './dashboard.js';

export interface BotChannelContext {
  projectDir: string;
  workflowFile?: string;
  cycle?: number;
}

export class BotAgentChannel {
  private provider: BotAgentProvider;
  private approvalHandler: ReturnType<typeof createApprovalHandler>;
  private notifier: (event: NotificationEvent) => Promise<void>;
  private context: BotChannelContext;

  constructor(
    provider: BotAgentProvider,
    options: {
      approvalMode: ApprovalMode;
      approvalTimeoutSeconds: number;
      approvalWebhookUrl?: string;
      approvalWebOpen?: boolean;
      dashboardServer?: DashboardServer;
      notifier: (event: NotificationEvent) => Promise<void>;
      context: BotChannelContext;
    },
  ) {
    this.provider = provider;
    this.notifier = options.notifier;
    this.context = options.context;
    this.approvalHandler = createApprovalHandler(options.approvalMode, {
      timeoutSeconds: options.approvalTimeoutSeconds,
      webhookUrl: options.approvalWebhookUrl,
      notifier: options.notifier,
      webOpen: options.approvalWebOpen,
      dashboardServer: options.dashboardServer,
    });
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

    return this.approvalHandler.handle(request, event);
  }

  async requestWithTools(
    agentRequest: { agentId: string; context: Record<string, unknown>; prompt: string },
    tools: ToolDefinition[],
  ): Promise<{ result: Record<string, unknown>; toolCalls?: ToolUseResult[] }> {
    if (this.provider.decideWithTools) {
      return this.provider.decideWithTools({ ...agentRequest, tools });
    }
    const result = await this.provider.decide(agentRequest);
    return { result };
  }

  async *streamRequest(agentRequest: {
    agentId: string;
    context: Record<string, unknown>;
    prompt: string;
  }): AsyncIterable<StreamChunk> {
    if (this.provider.stream) {
      yield* this.provider.stream(agentRequest);
      return;
    }
    const result = await this.provider.decide(agentRequest);
    yield { type: 'text', text: JSON.stringify(result) };
    yield { type: 'done' };
  }

  // Compat stubs for AgentChannel interface (used by executor, not by nodes)
  onPause(): Promise<object> {
    return new Promise(() => {});
  }
  resume(_result: object): void {}
  fail(_reason: string): void {}
}
