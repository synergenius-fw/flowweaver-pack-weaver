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
  WeaverEnv,
  ProviderInfo,
  WorkflowResult,
  ProviderName,
  RunRecord,
  RunFilter,
  RetentionPolicy,
  RunOutcome,
  TokenUsage,
  OnUsageCallback,
  RunCostEntry,
  RunCostSummary,
  CostRecord,
  CostSummary,
  BotAgentProvider,
  ProviderMetadata,
  ProviderFactory,
  ProviderFactoryConfig,
  ProviderModule,
  CronExpression,
  ParsedCron,
  CronField,
  TriggerSource,
  WatchDaemonOptions,
  WatchDaemonState,
  StageCondition,
  StageStatus,
  PipelineStage,
  PipelineConfig,
  StageResult,
  PipelineResult,
  DashboardEventType,
  DashboardNodeStatus,
  DashboardEvent,
  DashboardNodeState,
  DashboardServerOptions,
} from './bot/types.js';

// Providers
export type { BotChannelContext } from './bot/index.js';
export {
  AnthropicAgentProvider,
  CliAgentProvider,
  resolveProviderConfig,
  createProvider,
  detectProvider,
} from './bot/index.js';

// Provider registry
export { ProviderRegistry, defaultRegistry, loadExternalProvider, discoverProviders } from './bot/index.js';

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

// History & Cost
export { RunStore } from './bot/index.js';
export { CostTracker, MODEL_PRICING } from './bot/index.js';
export { CostStore } from './bot/index.js';

// Watch/Cron
export { parseCron, cronMatches, cronNextMatch } from './bot/index.js';
export { FileWatcher } from './bot/index.js';
export { CronScheduler } from './bot/index.js';
export { WatchDaemon } from './bot/index.js';

// Pipelines
export { PipelineRunner } from './bot/index.js';
export type { PipelineRunOptions } from './bot/index.js';

// Dashboard
export { DashboardServer } from './bot/index.js';
export { openBrowser } from './bot/index.js';

// Web Approval
export { WebApprovalHandler } from './bot/index.js';

// Bot infrastructure
export {
  SteeringController,
  TaskQueue,
  SessionStore,
  buildBotSystemPrompt,
} from './bot/index.js';
export type {
  SteeringCommand,
  QueuedTask,
  SessionState,
  BotTask,
  BotPlan,
  BotPlanStep,
  BotValidationResult,
  BotExecutionResult,
  BotNotificationEventType,
  ToolDefinition,
  ToolUseResult,
  StreamChunk,
  GenesisImpactLevel,
  GenesisOperationType,
  GenesisConfig,
  GenesisOperation,
  GenesisProposal,
  GenesisFingerprint,
  GenesisCycleRecord,
  GenesisHistory,
} from './bot/index.js';

// Genesis store
export { GenesisStore } from './bot/index.js';

// Node types (for use in flow-weaver workflows)
export {
  weaverLoadConfig,
  weaverDetectProvider,
  weaverResolveTarget,
  weaverExecuteTarget,
  weaverSendNotify,
  weaverReport,
  weaverReceiveTask,
  weaverRouteTask,
  weaverReadWorkflow,
  weaverBuildContext,
  weaverPlanTask,
  weaverApprovalGate,
  weaverAbortTask,
  weaverExecValidateRetry,
  weaverExecutePlan,
  weaverValidateResult,
  weaverFixErrors,
  weaverGitOps,
  weaverBotReport,
  genesisLoadConfig,
  genesisObserve,
  genesisDiffFingerprint,
  genesisCheckStabilize,
  genesisPropose,
  genesisValidateProposal,
  genesisSnapshot,
  genesisApply,
  genesisCompileValidate,
  genesisDiffWorkflow,
  genesisCheckThreshold,
  genesisApprove,
  genesisCommit,
  genesisUpdateHistory,
  genesisReport,
} from './node-types/index.js';

// Eject API (for platform/studio server-side use)
export { ejectWorkflows } from './cli-handlers.js';
export type { EjectResult } from './cli-handlers.js';
