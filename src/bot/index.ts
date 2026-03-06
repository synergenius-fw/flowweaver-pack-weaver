export type {
  BotConfig,
  BotProviderConfig,
  BotApprovalConfig,
  BotNotifyConfig,
  NotificationEvent,
  NotificationEventType,
  ExecutionEvent,
  ExecutionEventType,
  ApprovalMode,
  WeaverConfig,
  WorkflowResult,
  ProviderName,
} from './types.js';

export type { BotAgentProvider } from './agent-provider.js';
export {
  AnthropicAgentProvider,
  resolveProviderConfig,
  createProvider,
  detectProvider,
} from './agent-provider.js';
export { CliAgentProvider } from './cli-provider.js';
export { BotAgentChannel } from './bot-agent-channel.js';
export type { BotChannelContext } from './bot-agent-channel.js';
export {
  WebhookNotificationChannel,
  createNotifier,
} from './notifications.js';
export type { NotificationChannel, NotificationErrorHandler } from './notifications.js';
export { buildSystemPrompt } from './system-prompt.js';
export { runWorkflow } from './runner.js';
export { createApprovalHandler } from './approvals.js';
export type { ApprovalHandler, ApprovalResult } from './approvals.js';
