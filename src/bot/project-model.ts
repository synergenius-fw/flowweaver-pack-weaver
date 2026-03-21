/**
 * Project Model Store — aggregation layer that pulls from all existing data stores
 * and computes a unified project model ("the brain").
 *
 * Storage: ~/.weaver/projects/{hash8}/model.json (cached with 5-minute TTL)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type {
  ProjectModel, WorkflowHealth, FailurePattern, BotProfile,
  ApprovalDecision, OperationEffectiveness,
  GenesisCycleRecord,
} from './types.js';
import { computeTrustLevel } from './trust-calculator.js';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const BOTS_DIR = path.join(os.homedir(), '.weaver', 'bots');

export class ProjectModelStore {
  private readonly hash8: string;
  private readonly modelPath: string;

  constructor(private readonly projectDir: string) {
    this.hash8 = crypto.createHash('sha256').update(projectDir).digest('hex').slice(0, 8);
    const modelDir = path.join(os.homedir(), '.weaver', 'projects', this.hash8);
    fs.mkdirSync(modelDir, { recursive: true });
    this.modelPath = path.join(modelDir, 'model.json');
  }

  async getOrBuild(): Promise<ProjectModel> {
    try {
      if (fs.existsSync(this.modelPath)) {
        const raw = fs.readFileSync(this.modelPath, 'utf-8');
        const cached = JSON.parse(raw) as ProjectModel;
        if (Date.now() - cached.builtAt < CACHE_TTL_MS) {
          return cached;
        }
      }
    } catch { /* cache corrupt — rebuild */ }

    return this.build();
  }

  async build(): Promise<ProjectModel> {
    // 1. Load stores with dynamic imports (avoid circular deps)
    let runs: Array<{ workflowFile: string; startedAt: string; finishedAt: string; durationMs: number; success: boolean; outcome: string; summary: string }> = [];
    try {
      const { RunStore } = await import('./run-store.js');
      runs = new RunStore().list({ limit: 10_000 });
    } catch { /* unavailable */ }

    let auditEvents: Array<{ type: string; timestamp: string; runId: string; data?: Record<string, unknown> }> = [];
    try {
      const { AuditStore } = await import('./audit-store.js');
      auditEvents = new AuditStore().queryRecent(500);
    } catch { /* unavailable */ }

    let costRecords: Array<{ runId?: string; model?: string; promptTokens?: number; completionTokens?: number; estimatedCost?: number; cost?: number; timestamp: number }> = [];
    try {
      const { CostStore } = await import('./cost-store.js');
      costRecords = new CostStore().query();
    } catch { /* unavailable */ }

    let genesisCycles: GenesisCycleRecord[] = [];
    try {
      if (fs.existsSync(path.join(this.projectDir, '.genesis'))) {
        const { GenesisStore } = await import('./genesis-store.js');
        genesisCycles = new GenesisStore(this.projectDir).loadHistory().cycles;
      }
    } catch { /* unavailable */ }

    let conversationCount = 0;
    try {
      const { ConversationStore } = await import('./conversation-store.js');
      conversationCount = new ConversationStore().list().length;
    } catch { /* unavailable */ }

    // 2. Build sections
    const workflows = this.buildWorkflowHealth(runs);
    const overall = workflows.length > 0
      ? Math.round(workflows.reduce((s, w) => s + w.score * w.totalRuns, 0) / Math.max(1, workflows.reduce((s, w) => s + w.totalRuns, 0)))
      : 0;

    const bots = this.buildBotProfiles(runs);

    let classifyError: ((msg: string) => { isTransient: boolean; category: string }) | null = null;
    try {
      const mod = await import('./error-classifier.js');
      classifyError = (msg: string) => mod.classifyError(msg);
    } catch { /* unavailable */ }

    const failurePatterns = this.buildFailurePatterns(auditEvents, classifyError);
    const userPreferences = this.buildUserPreferences(genesisCycles);
    const evolution = this.buildEvolution(genesisCycles);
    const cost = this.buildCost(costRecords, runs);

    // 3. Assemble partial model, compute trust
    const partial = {
      projectDir: this.projectDir,
      builtAt: Date.now(),
      health: { overall, workflows },
      bots,
      failurePatterns,
      userPreferences,
      evolution,
      cost,
      _conversationCount: conversationCount,
    };

    const trust = computeTrustLevel(partial);
    const model: ProjectModel = {
      projectDir: partial.projectDir,
      builtAt: partial.builtAt,
      health: partial.health,
      bots: partial.bots,
      failurePatterns: partial.failurePatterns,
      userPreferences: partial.userPreferences,
      evolution: partial.evolution,
      cost: partial.cost,
      trust,
    };

    // 4. Cache
    try {
      fs.writeFileSync(this.modelPath, JSON.stringify(model, null, 2), 'utf-8');
    } catch { /* non-fatal */ }

    return model;
  }

  invalidate(): void {
    try {
      if (fs.existsSync(this.modelPath)) fs.unlinkSync(this.modelPath);
    } catch { /* non-fatal */ }
  }

  formatSummary(model: ProjectModel): string {
    const { health, bots, failurePatterns, cost, trust, evolution } = model;
    const healthyCount = health.workflows.filter(w => w.trend !== 'degrading').length;
    const degradingCount = health.workflows.filter(w => w.trend === 'degrading').length;
    const ejectedCount = bots.filter(b => b.ejected).length;
    const criticalPatterns = failurePatterns.filter(f => f.occurrences >= 5 && !f.transient).length;

    const phaseNames: Record<number, string> = {
      1: 'insights + suggestions',
      2: 'proposals with explanation',
      3: 'proposals with visual diff',
      4: 'auto-apply COSMETIC',
    };

    return [
      `Health: ${health.overall}/100 (${health.workflows.length} workflows, ${healthyCount} healthy, ${degradingCount} degrading)`,
      `Bots: ${bots.length} registered (${ejectedCount} ejected)`,
      `Failures: ${failurePatterns.length} recurring patterns (${criticalPatterns} critical)`,
      `Cost: $${cost.last7Days.toFixed(2)} last 7 days (${cost.trend})`,
      `Trust: Phase ${trust.phase} (${phaseNames[trust.phase]})`,
      `Evolution: ${evolution.totalCycles} cycles (${evolution.totalCycles > 0 ? Math.round(evolution.successRate * 100) : 0}% success)`,
    ].join('\n');
  }

  formatSessionGreeting(model: ProjectModel): string {
    const insightCount = model.failurePatterns.filter(f => f.occurrences >= 3).length
      + model.health.workflows.filter(w => w.trend === 'degrading').length;
    return `Health ${model.health.overall}/100 \u00b7 ${model.bots.length} bots \u00b7 ${insightCount} insights \u00b7 $${model.cost.last7Days.toFixed(2)}/7d`;
  }

  // ---- Private builders ----

  private buildWorkflowHealth(runs: typeof ProjectModelStore.prototype.build extends (...args: any[]) => any ? any : never): WorkflowHealth[] {
    const byWorkflow = new Map<string, Array<{ startedAt: string; durationMs: number; success: boolean }>>();
    for (const run of runs) {
      if (!byWorkflow.has(run.workflowFile)) byWorkflow.set(run.workflowFile, []);
      byWorkflow.get(run.workflowFile)!.push(run);
    }

    const now = Date.now();
    const d7 = now - 7 * 86_400_000;
    const d14 = now - 14 * 86_400_000;
    const result: WorkflowHealth[] = [];

    for (const [file, wfRuns] of byWorkflow) {
      const totalRuns = wfRuns.length;
      const successRate = totalRuns > 0 ? wfRuns.filter(r => r.success).length / totalRuns : 0;
      const avgDurationMs = totalRuns > 0 ? Math.round(wfRuns.reduce((s, r) => s + (r.durationMs ?? 0), 0) / totalRuns) : 0;
      const sorted = [...wfRuns].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      const lastRun = sorted[0]?.startedAt ?? null;

      const recent = wfRuns.filter(r => new Date(r.startedAt).getTime() >= d7);
      const prev = wfRuns.filter(r => { const t = new Date(r.startedAt).getTime(); return t >= d14 && t < d7; });
      const recentRate = recent.length > 0 ? recent.filter(r => r.success).length / recent.length : successRate;
      const prevRate = prev.length > 0 ? prev.filter(r => r.success).length / prev.length : successRate;
      const diff = recentRate - prevRate;
      const trend: WorkflowHealth['trend'] = diff > 0.05 ? 'improving' : diff < -0.05 ? 'degrading' : 'stable';

      result.push({ file, score: Math.round(successRate * 100), totalRuns, successRate, avgDurationMs, lastRun, trend });
    }

    return result;
  }

  private buildBotProfiles(runs: Array<{ workflowFile: string; success: boolean; durationMs: number }>): BotProfile[] {
    const profiles: BotProfile[] = [];
    try {
      if (!fs.existsSync(BOTS_DIR)) return profiles;
      for (const name of fs.readdirSync(BOTS_DIR)) {
        const metaPath = path.join(BOTS_DIR, name, 'meta.json');
        if (!fs.existsSync(metaPath)) continue;
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          if (meta.projectDir !== this.projectDir) continue;

          const ejectedPath = path.join(this.projectDir, '.fw', 'bots', name);
          const ejected = fs.existsSync(ejectedPath);

          // Compute bot task stats from runs associated with this bot
          const botRuns = runs.filter(r => r.workflowFile.includes(name) || r.workflowFile.includes('weaver-bot'));
          const totalTasksRun = botRuns.length;
          const successRate = totalTasksRun > 0 ? botRuns.filter(r => r.success).length / totalTasksRun : 0;
          const avgTaskDurationMs = totalTasksRun > 0 ? Math.round(botRuns.reduce((s, r) => s + (r.durationMs ?? 0), 0) / totalTasksRun) : 0;

          profiles.push({
            name: meta.name ?? name,
            workflowFile: ejected ? path.join(ejectedPath, 'weaver-bot.ts') : 'node_modules/@synergenius/flow-weaver-pack-weaver/src/workflows/weaver-bot.ts',
            ejected,
            totalTasksRun,
            successRate,
            avgTaskDurationMs,
            topFailurePatterns: [],
          });
        } catch { /* corrupt meta */ }
      }
    } catch { /* bots dir read failed */ }
    return profiles;
  }

  private buildFailurePatterns(
    auditEvents: Array<{ type: string; timestamp: string; data?: Record<string, unknown> }>,
    classifyError: ((msg: string) => { isTransient: boolean; category: string }) | null,
  ): FailurePattern[] {
    const errorEvents = auditEvents.filter(e =>
      e.type.includes('error') || e.type.includes('fail') || e.data?.error !== undefined
    );

    const groups = new Map<string, { message: string; count: number; lastSeen: string; workflows: Set<string> }>();
    for (const event of errorEvents) {
      const rawMsg = String(event.data?.error ?? event.data?.message ?? event.type);
      const key = rawMsg.slice(0, 50);
      const existing = groups.get(key);
      const wf = String(event.data?.workflowFile ?? event.data?.file ?? '');
      if (existing) {
        existing.count++;
        if (event.timestamp > existing.lastSeen) existing.lastSeen = event.timestamp;
        if (wf) existing.workflows.add(wf);
      } else {
        const wfSet = new Set<string>();
        if (wf) wfSet.add(wf);
        groups.set(key, { message: rawMsg, count: 1, lastSeen: event.timestamp, workflows: wfSet });
      }
    }

    const patterns: FailurePattern[] = [];
    for (const [, g] of groups) {
      let transient = false;
      let category = 'unknown';
      if (classifyError) {
        try {
          const c = classifyError(g.message);
          transient = c.isTransient;
          category = c.category;
        } catch { /* classification failed */ }
      }
      patterns.push({
        pattern: g.message.slice(0, 120),
        category,
        occurrences: g.count,
        lastSeen: g.lastSeen,
        workflows: [...g.workflows],
        transient,
      });
    }

    return patterns.sort((a, b) => b.occurrences - a.occurrences);
  }

  private buildUserPreferences(genesisCycles: GenesisCycleRecord[]): ProjectModel['userPreferences'] {
    const approvalHistory: ApprovalDecision[] = [];

    for (const cycle of genesisCycles) {
      if (cycle.approved === null) continue;
      approvalHistory.push({
        timestamp: cycle.timestamp,
        proposalSummary: cycle.proposal?.summary ?? '',
        impactLevel: cycle.proposal?.impactLevel ?? 'MINOR',
        approved: cycle.approved,
        reason: cycle.rejectionReason,
      });
    }

    // Auto-approve: 5+ consecutive approvals for a given impact level
    const autoApprovePatterns: string[] = [];
    const neverApprovePatterns: string[] = [];
    const byImpact = new Map<string, boolean[]>();
    for (const d of approvalHistory) {
      if (!byImpact.has(d.impactLevel)) byImpact.set(d.impactLevel, []);
      byImpact.get(d.impactLevel)!.push(d.approved);
    }
    for (const [level, decisions] of byImpact) {
      let consec = 0;
      for (let i = decisions.length - 1; i >= 0; i--) {
        if (decisions[i]) consec++;
        else break;
      }
      if (consec >= 5) autoApprovePatterns.push(level);

      let consecRejects = 0;
      for (let i = decisions.length - 1; i >= 0; i--) {
        if (!decisions[i]) consecRejects++;
        else break;
      }
      if (consecRejects >= 3) neverApprovePatterns.push(level);
    }

    return { approvalHistory, autoApprovePatterns, neverApprovePatterns };
  }

  private buildEvolution(genesisCycles: GenesisCycleRecord[]): ProjectModel['evolution'] {
    const totalCycles = genesisCycles.length;
    const applied = genesisCycles.filter(c => c.outcome === 'applied').length;
    const successRate = totalCycles > 0 ? applied / totalCycles : 0;

    const byOp = new Map<string, { proposed: number; applied: number; rolledBack: number }>();
    for (const cycle of genesisCycles) {
      if (!cycle.proposal) continue;
      for (const op of cycle.proposal.operations) {
        if (!byOp.has(op.type)) byOp.set(op.type, { proposed: 0, applied: 0, rolledBack: 0 });
        const e = byOp.get(op.type)!;
        e.proposed++;
        if (cycle.outcome === 'applied') e.applied++;
        else if (cycle.outcome === 'rolled-back') e.rolledBack++;
      }
    }

    const byOperationType: Record<string, OperationEffectiveness> = {};
    for (const [type, stats] of byOp) {
      byOperationType[type] = {
        proposed: stats.proposed,
        applied: stats.applied,
        rolledBack: stats.rolledBack,
        effectiveness: stats.proposed > 0 ? stats.applied / stats.proposed : 0,
      };
    }

    return {
      totalCycles,
      successRate,
      byOperationType,
      recentCycles: genesisCycles.slice(-10),
    };
  }

  private buildCost(
    costRecords: Array<{ estimatedCost?: number; cost?: number; timestamp: number; model?: string }>,
    runs: Array<{ success: boolean }>,
  ): ProjectModel['cost'] {
    const now = Date.now();
    const d7 = now - 7 * 86_400_000;
    const d14 = now - 14 * 86_400_000;
    const d30 = now - 30 * 86_400_000;

    const getCost = (r: { estimatedCost?: number; cost?: number }) => r.estimatedCost ?? r.cost ?? 0;
    const totalSpent = costRecords.reduce((s, r) => s + getCost(r), 0);
    const last7Days = costRecords.filter(r => r.timestamp >= d7).reduce((s, r) => s + getCost(r), 0);
    const prev7Days = costRecords.filter(r => r.timestamp >= d14 && r.timestamp < d7).reduce((s, r) => s + getCost(r), 0);
    const last30Days = costRecords.filter(r => r.timestamp >= d30).reduce((s, r) => s + getCost(r), 0);

    let trend: ProjectModel['cost']['trend'] = 'stable';
    if (prev7Days > 0) {
      const ratio = last7Days / prev7Days;
      if (ratio > 1.15) trend = 'increasing';
      else if (ratio < 0.85) trend = 'decreasing';
    }

    const successfulRuns = runs.filter(r => r.success).length;
    const costPerSuccessfulRun = successfulRuns > 0 ? totalSpent / successfulRuns : 0;

    // High cost workflows — from cost records grouped by model (simplified)
    const highCostWorkflows: Array<{ workflow: string; avgCost: number }> = [];

    return { totalSpent, last7Days, last30Days, trend, costPerSuccessfulRun, highCostWorkflows };
  }
}
