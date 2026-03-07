export type ProviderName = 'anthropic' | 'claude-cli' | 'copilot-cli' | (string & {});

export interface ProviderInfo {
  type: 'anthropic' | 'claude-cli' | 'copilot-cli';
  model?: string;
  maxTokens?: number;
  apiKey?: string;
}

export interface WeaverEnv {
  projectDir: string;
  config: WeaverConfig;
  providerType: string;
  providerInfo: ProviderInfo;
}

export interface BotProviderConfig {
  name: ProviderName;
  model?: string;
  maxTokens?: number;
  module?: string;
  options?: Record<string, unknown>;
}

// --- Provider Registry (F5) ---

export interface ProviderMetadata {
  displayName: string;
  description?: string;
  source: 'built-in' | 'npm' | 'local';
  requiredEnvVars?: string[];
  detectCliCommand?: string;
}

export interface ProviderFactoryConfig {
  model?: string;
  maxTokens?: number;
  options?: Record<string, unknown>;
}

export type ProviderFactory = (config: ProviderFactoryConfig) => BotAgentProvider | Promise<BotAgentProvider>;

export interface ProviderModule {
  createProvider: ProviderFactory;
  metadata?: ProviderMetadata;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolUseResult {
  toolName: string;
  toolInput: Record<string, unknown>;
}

export interface StreamChunk {
  type: 'text' | 'tool_use' | 'usage' | 'done';
  text?: string;
  toolUse?: ToolUseResult;
  usage?: TokenUsage;
}

export interface BotAgentProvider {
  decide(request: {
    agentId: string;
    context: Record<string, unknown>;
    prompt: string;
  }): Promise<Record<string, unknown>>;
  stream?(request: {
    agentId: string;
    context: Record<string, unknown>;
    prompt: string;
  }): AsyncIterable<StreamChunk>;
  decideWithTools?(request: {
    agentId: string;
    context: Record<string, unknown>;
    prompt: string;
    tools: ToolDefinition[];
  }): Promise<{ result: Record<string, unknown>; toolCalls?: ToolUseResult[] }>;
  onUsage?: OnUsageCallback;
}

export type ApprovalMode = 'auto' | 'prompt' | 'webhook' | 'timeout-auto' | 'web';

export interface BotApprovalConfig {
  mode: ApprovalMode;
  timeoutSeconds?: number;
  webhookUrl?: string;
  webPort?: number;
  webOpen?: boolean;
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
  | 'error'
  | 'pipeline-start'
  | 'pipeline-complete'
  | 'stage-start'
  | 'stage-complete'
  | 'bot-task-start'
  | 'bot-task-complete'
  | 'bot-plan-ready'
  | 'bot-step-complete'
  | 'bot-validation-failed'
  | 'bot-fix-attempt'
  | 'bot-session-start'
  | 'bot-session-end'
  | 'bot-steering-received';

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
  pipelineName?: string;
  stageId?: string;
  completedStages?: number;
  totalStages?: number;
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
  approval?: 'auto' | 'prompt' | 'webhook' | 'timeout-auto' | 'web' | BotApprovalConfig;
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
  cost?: RunCostSummary;
}

// --- History (F2) ---

export type RunOutcome = 'completed' | 'failed' | 'error' | 'skipped';

export interface RunRecord {
  id: string;
  workflowFile: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  success: boolean;
  outcome: RunOutcome;
  summary: string;
  functionName?: string;
  executionTime?: number;
  params?: Record<string, unknown>;
  dryRun: boolean;
  provider?: string;
  pipelineName?: string;
  stageName?: string;
}

export interface RunFilter {
  workflowFile?: string;
  outcome?: RunOutcome;
  success?: boolean;
  since?: string;
  before?: string;
  limit?: number;
}

export interface RetentionPolicy {
  maxRecords?: number;
  maxAgeDays?: number;
}

// --- Cost Tracking (F7) ---

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export type OnUsageCallback = (step: string, model: string, usage: TokenUsage) => void;

export interface RunCostEntry {
  step: string;
  model: string;
  usage: TokenUsage;
  estimatedCost: number;
  timestamp: number;
}

export interface RunCostSummary {
  entries: RunCostEntry[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  model: string;
  provider: string;
}

export interface CostRecord {
  timestamp: number;
  workflowFile: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  steps: number;
}

export interface CostSummary {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRuns: number;
  byModel: Record<string, { runs: number; inputTokens: number; outputTokens: number; cost: number }>;
}

// --- Watch/Cron (F4) ---

export type CronExpression = string;

export interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
  source: string;
}

export interface CronField {
  type: 'wildcard' | 'list';
  values: number[];
}

export type TriggerSource = 'file-change' | 'cron';

export interface WatchDaemonOptions {
  filePath: string;
  watchFile: boolean;
  cron?: CronExpression;
  debounceMs: number;
  logFile?: string;
  verbose: boolean;
  params?: Record<string, unknown>;
  config?: WeaverConfig;
  quiet: boolean;
}

export interface WatchDaemonState {
  running: boolean;
  lastRun: Date | null;
  lastTrigger: TriggerSource | null;
  lastResult: WorkflowResult | null;
  runCount: number;
  errorCount: number;
  startedAt: Date;
  queued: boolean;
}

// --- Pipelines (F1) ---

export type StageCondition = 'on-success' | 'on-failure' | 'always';
export type StageStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled';

export interface PipelineStage {
  id: string;
  workflow: string;
  label?: string;
  dependsOn?: string[];
  condition?: StageCondition;
  params?: Record<string, unknown>;
  timeoutSeconds?: number;
}

export interface PipelineConfig {
  version: 1;
  name: string;
  description?: string;
  stages: PipelineStage[];
  failFast?: boolean;
  defaultTimeoutSeconds?: number;
  config?: WeaverConfig;
}

export interface StageResult {
  id: string;
  status: StageStatus;
  workflowResult: WorkflowResult | null;
  durationMs: number;
  error?: string;
  wave: number;
}

export interface PipelineResult {
  success: boolean;
  outcome: string;
  durationMs: number;
  stages: Record<string, StageResult>;
  stageOrder: string[];
}

// --- Dashboard (F3) ---

export type DashboardEventType = ExecutionEventType | 'workflow-start' | 'workflow-complete' | 'workflow-error' | 'approval-pending' | 'approval-resolved';
export type DashboardNodeStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface DashboardEvent {
  type: DashboardEventType;
  timestamp: number;
  nodeId?: string;
  nodeType?: string;
  durationMs?: number;
  error?: string;
  summary?: string;
  approval?: { id: string; prompt: string; context: Record<string, unknown> };
}

export interface DashboardNodeState {
  nodeId: string;
  nodeType?: string;
  status: DashboardNodeStatus;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  error?: string;
}

export interface DashboardServerOptions {
  port: number;
  open: boolean;
  keepAlive: boolean;
  keepAliveSeconds: number;
}

// --- Bot Task Types ---

export type BotNotificationEventType =
  | 'bot-task-start'
  | 'bot-task-complete'
  | 'bot-plan-ready'
  | 'bot-step-complete'
  | 'bot-validation-failed'
  | 'bot-fix-attempt'
  | 'bot-session-start'
  | 'bot-session-end'
  | 'bot-steering-received';

export interface BotTask {
  instruction: string;
  mode: 'create' | 'modify' | 'read' | 'batch';
  targets?: string[];
  options?: { template?: string; batchCount?: number; dryRun?: boolean };
}

export interface BotPlanStep {
  id: string;
  operation: 'create-workflow' | 'implement-node' | 'add-node' | 'remove-node' |
             'add-connection' | 'remove-connection' | 'compile' | 'validate' |
             'modify-source' | 'scaffold' | 'read-file' | 'write-file' | 'run-cli';
  description: string;
  args: Record<string, unknown>;
}

export interface BotPlan {
  steps: BotPlanStep[];
  summary: string;
}

export interface BotValidationResult {
  file: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface BotExecutionResult {
  success: boolean;
  filesModified: string[];
  filesCreated: string[];
  stepsCompleted: number;
  stepsTotal: number;
  errors: string[];
  output: string;
}

// --- Genesis Self-Evolution ---

export type GenesisImpactLevel = 'COSMETIC' | 'MINOR' | 'BREAKING' | 'CRITICAL';
export type GenesisOperationType = 'addNode' | 'removeNode' | 'addConnection' | 'removeConnection' | 'implementNode';

export interface GenesisConfig {
  intent: string;
  focus: string[];
  constraints: string[];
  approvalThreshold: GenesisImpactLevel;
  budgetPerCycle: number;
  stabilize: boolean;
  targetWorkflow: string;
  maxCyclesPerRun: number;
}

export interface GenesisOperation {
  type: GenesisOperationType;
  args: { file?: string; nodeId?: string; nodeType?: string; from?: string; to?: string; content?: string };
  costUnits: number;
  rationale: string;
}

export interface GenesisProposal {
  operations: GenesisOperation[];
  totalCost: number;
  impactLevel: GenesisImpactLevel;
  summary: string;
  rationale: string;
}

export interface GenesisFingerprint {
  timestamp: string;
  files: Record<string, string>;
  packageJson: Record<string, unknown> | null;
  gitBranch: string | null;
  gitCommit: string | null;
  workflowHash: string;
  existingWorkflows: string[];
}

export interface GenesisCycleRecord {
  id: string;
  timestamp: string;
  durationMs: number;
  fingerprint: GenesisFingerprint;
  proposal: GenesisProposal | null;
  outcome: 'applied' | 'rolled-back' | 'rejected' | 'stabilized' | 'no-change' | 'error';
  diffSummary: string | null;
  approvalRequired: boolean;
  approved: boolean | null;
  error: string | null;
  snapshotFile: string | null;
}

export interface GenesisHistory {
  configHash: string;
  cycles: GenesisCycleRecord[];
}

export interface WeaverContext {
  env: WeaverEnv;
  targetPath?: string;
  taskJson?: string;
  hasTask?: boolean;
  contextBundle?: string;
  planJson?: string;
  rejectionReason?: string;
  resultJson?: string;
  validationResultJson?: string;
  filesModified?: string;
  allValid?: boolean;
  gitResultJson?: string;
}

export interface GenesisContext {
  env: WeaverEnv;
  genesisConfigJson: string;
  cycleId: string;
  fingerprintJson?: string;
  diffJson?: string;
  stabilized?: boolean;
  proposalJson?: string;
  snapshotPath?: string;
  applyResultJson?: string;
  workflowDiffJson?: string;
  approvalRequired?: boolean;
  approved?: boolean;
  commitResultJson?: string;
  cycleRecordJson?: string;
  workflowDescription?: string;
  startTimeMs?: number;
  error?: string;
}
