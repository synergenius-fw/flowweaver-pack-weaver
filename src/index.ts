// Types
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
} from './bot/types.js';

// Providers
export type { BotAgentProvider, BotChannelContext } from './bot/index.js';
export {
  AnthropicAgentProvider,
  CliAgentProvider,
  resolveProviderConfig,
  createProvider,
  detectProvider,
} from './bot/index.js';

// Agent channel & notifications
export { BotAgentChannel } from './bot/index.js';
export {
  WebhookNotificationChannel,
  createNotifier,
} from './bot/index.js';
export type { NotificationChannel, NotificationErrorHandler } from './bot/index.js';

// Approvals
export { createApprovalHandler } from './bot/index.js';
export type { ApprovalHandler, ApprovalResult } from './bot/index.js';

// System prompt
export { buildSystemPrompt } from './bot/index.js';

// Runner
export { runWorkflow } from './bot/index.js';
