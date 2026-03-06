export type ProviderName = 'anthropic' | 'claude-cli' | 'copilot-cli';

export interface BotProviderConfig {
  name: ProviderName;
  model?: string;
  maxTokens?: number;
}

export type ApprovalMode = 'auto' | 'prompt' | 'webhook' | 'timeout-auto';

export interface BotApprovalConfig {
  mode: ApprovalMode;
  timeoutSeconds?: number;
  webhookUrl?: string;
}

export interface BotNotifyConfig {
  channel: 'discord' | 'slack' | 'webhook';
  url: string;
  events?: NotificationEventType[];
  headers?: Record<string, string>;
}

export type NotificationEventType =
  | 'workflow-start'
  | 'workflow-complete'
  | 'cycle-start'
  | 'cycle-complete'
  | 'approval-needed'
  | 'error';

export interface NotificationEvent {
  type: NotificationEventType;
  workflowFile?: string;
  cycle?: number;
  projectDir: string;
  summary?: string;
  proposal?: Record<string, unknown>;
  diff?: Record<string, unknown>;
  outcome?: string;
  error?: string;
}

export type ExecutionEventType = 'node-start' | 'node-complete' | 'node-error';

export interface ExecutionEvent {
  type: ExecutionEventType;
  nodeId: string;
  nodeType?: string;
  timestamp: number;
  durationMs?: number;
  error?: string;
}

export interface BotConfig {
  provider: 'auto' | ProviderName | BotProviderConfig;
  approval?: 'auto' | 'prompt' | 'webhook' | 'timeout-auto' | BotApprovalConfig;
  notify?: BotNotifyConfig | BotNotifyConfig[];
  target?: string;
}

/** Standalone Weaver config (same schema as BotConfig, used in .weaver.json) */
export type WeaverConfig = BotConfig;

export interface WorkflowResult {
  success: boolean;
  summary: string;
  outcome: string;
  functionName?: string;
  executionTime?: number;
}
