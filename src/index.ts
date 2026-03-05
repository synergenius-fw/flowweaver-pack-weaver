// Types
export type {
  BotConfig,
  BotProviderConfig,
  BotApprovalConfig,
  BotNotifyConfig,
  NotificationEvent,
  NotificationEventType,
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
export type { NotificationChannel } from './bot/index.js';

// System prompt
export { buildSystemPrompt } from './bot/index.js';

// Runner
export { runWorkflow } from './bot/index.js';
