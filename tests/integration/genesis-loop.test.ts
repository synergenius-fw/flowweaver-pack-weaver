/**
 * Genesis Loop Integration Test
 *
 * Proves the core product thesis: the insight engine detects failure patterns
 * in bot execution data, and genesis proposes targeted fixes.
 *
 * Flow:
 * 1. Build a project model with simulated run history (mostly failures)
 * 2. Run the insight engine — should detect recurring failure patterns
 * 3. Build genesis insight context — should include the failure data
 * 4. Verify the proposal prompt would contain actionable intelligence
 *
 * This test exercises the full data pipeline without requiring an AI provider.
 */

import { describe, it, expect } from 'vitest';
import { ProjectModelStore } from '../../src/bot/project-model.js';
import { InsightEngine } from '../../src/bot/insight-engine.js';
import { computeTrustLevel } from '../../src/bot/trust-calculator.js';
import { getGenesisInsightContext } from '../../src/bot/genesis-prompt-context.js';
import type { ProjectModel, Insight, GenesisCycleRecord } from '../../src/bot/types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

function createTestModel(overrides: Partial<ProjectModel> = {}): ProjectModel {
  const base: ProjectModel = {
    projectDir: '/tmp/genesis-test',
    builtAt: Date.now(),
    health: { overall: 25, workflows: [] },
    bots: [],
    failurePatterns: [],
    userPreferences: { approvalHistory: [], autoApprovePatterns: [], neverApprovePatterns: [] },
    evolution: { totalCycles: 0, successRate: 0, byOperationType: {}, recentCycles: [] },
    cost: { totalSpent: 0, last7Days: 0, last30Days: 0, trend: 'stable', costPerSuccessfulRun: 0, highCostWorkflows: [] },
    trust: { score: 0, phase: 1, factors: { conversationCount: 0, approvalConsistency: 0, genesisSuccessRate: 0, daysSinceFirstUse: 0 } },
  };
  return { ...base, ...overrides };
}

describe('Genesis Loop: Insight → Proposal Pipeline', () => {
  it('detects recurring validation failures and marks them as genesis candidates', () => {
    const model = createTestModel({
      health: {
        overall: 25,
        workflows: [
          { file: 'src/workflows/data-pipeline.ts', score: 25, totalRuns: 8, successRate: 0.25, avgDurationMs: 500, lastRun: new Date().toISOString(), trend: 'stable' },
        ],
      },
      failurePatterns: [
        { pattern: 'Network error: ECONNREFUSED in fetchData', category: 'network', occurrences: 6, lastSeen: new Date().toISOString(), workflows: ['data-pipeline.ts'], transient: false },
      ],
    });

    const engine = new InsightEngine();
    const insights = engine.analyze(model);

    // Should detect the recurring failure
    const failureInsight = insights.find(i => i.type === 'failure-pattern');
    expect(failureInsight).toBeDefined();
    expect(failureInsight!.severity).toBe('critical'); // 6 occurrences, non-transient
    expect(failureInsight!.genesisCandidate).toBe(true);
    expect(failureInsight!.confidence).toBeGreaterThan(0.5);
  });

  it('detects underperforming bot and flags for evolution', () => {
    const model = createTestModel({
      bots: [
        { name: 'data-bot', workflowFile: 'src/workflows/data-pipeline.ts', ejected: true, totalTasksRun: 12, successRate: 0.25, avgTaskDurationMs: 3000, topFailurePatterns: [] },
      ],
    });

    const engine = new InsightEngine();
    const insights = engine.analyze(model);

    const botInsight = insights.find(i => i.type === 'bot-performance');
    expect(botInsight).toBeDefined();
    expect(botInsight!.severity).toBe('critical'); // < 0.3 success rate
    expect(botInsight!.genesisCandidate).toBe(true);
    expect(botInsight!.targetBot).toBe('data-bot');
  });

  it('suggests first genesis run when data exists but no cycles have run', () => {
    const model = createTestModel({
      health: {
        overall: 50,
        workflows: [
          { file: 'src/workflows/data-pipeline.ts', score: 50, totalRuns: 5, successRate: 0.5, avgDurationMs: 500, lastRun: new Date().toISOString(), trend: 'degrading' },
        ],
      },
      failurePatterns: [
        { pattern: 'Validation failed: missing error handler', category: 'parse', occurrences: 3, lastSeen: new Date().toISOString(), workflows: ['data-pipeline.ts'], transient: false },
      ],
      evolution: { totalCycles: 0, successRate: 0, byOperationType: {}, recentCycles: [] },
    });

    const engine = new InsightEngine();
    const insights = engine.analyze(model);

    const evoInsight = insights.find(i => i.type === 'evolution-opportunity');
    expect(evoInsight).toBeDefined();
    expect(evoInsight!.genesisCandidate).toBe(true);
    expect(evoInsight!.suggestion).toBeDefined();
  });

  it('builds genesis insight context with failure data for AI prompt', async () => {
    // Write a fake project model to disk so getGenesisInsightContext can read it
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-ctx-'));
    const hash8 = crypto.createHash('sha256').update(tmpDir).digest('hex').slice(0, 8);
    const modelDir = path.join(os.homedir(), '.weaver', 'projects', hash8);
    fs.mkdirSync(modelDir, { recursive: true });

    const model = createTestModel({
      projectDir: tmpDir,
      health: {
        overall: 25,
        workflows: [
          { file: 'data-pipeline.ts', score: 25, totalRuns: 8, successRate: 0.25, avgDurationMs: 500, lastRun: new Date().toISOString(), trend: 'stable' },
        ],
      },
      bots: [
        { name: 'data-bot', workflowFile: 'data-pipeline.ts', ejected: true, totalTasksRun: 12, successRate: 0.25, avgTaskDurationMs: 3000, topFailurePatterns: [] },
      ],
      failurePatterns: [
        { pattern: 'Network error: ECONNREFUSED in fetchData', category: 'network', occurrences: 6, lastSeen: new Date().toISOString(), workflows: ['data-pipeline.ts'], transient: false },
      ],
      trust: { score: 25, phase: 1, factors: { conversationCount: 3, approvalConsistency: 0, genesisSuccessRate: 0, daysSinceFirstUse: 2 } },
    });

    fs.writeFileSync(path.join(modelDir, 'model.json'), JSON.stringify(model, null, 2), 'utf-8');

    try {
      const context = await getGenesisInsightContext(tmpDir);

      // Context should contain intelligence for the AI
      expect(context).toContain('Health: 25/100');
      expect(context).toContain('Trust Phase: 1');
      expect(context).toContain('ECONNREFUSED');
      expect(context).toContain('network');
      expect(context).toContain('data-bot');
      expect(context).toContain('25%');
    } finally {
      fs.rmSync(path.join(modelDir, 'model.json'), { force: true });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('trust level advances as genesis cycles succeed', () => {
    // Simulate progression from Phase 1 to Phase 2
    const appliedCycles: GenesisCycleRecord[] = Array.from({ length: 3 }, (_, i) => ({
      id: `cycle-${i}`,
      timestamp: new Date().toISOString(),
      durationMs: 1000,
      fingerprint: { timestamp: '', files: {}, gitBranch: null, gitCommit: null, packageJson: null, workflowHash: '', existingWorkflows: [] },
      proposal: { operations: [{ type: 'addConnection' as const, args: {}, costUnits: 1, rationale: 'test' }], totalCost: 1, impactLevel: 'MINOR' as const, summary: 'test', rationale: 'test' },
      outcome: 'applied' as const,
      diffSummary: 'test',
      approvalRequired: true,
      approved: true,
      error: null,
      snapshotFile: null,
    }));

    const modelP1 = createTestModel({
      evolution: { totalCycles: 0, successRate: 0, byOperationType: {}, recentCycles: [] },
      userPreferences: { approvalHistory: [], autoApprovePatterns: [], neverApprovePatterns: [] },
    });
    const trustP1 = computeTrustLevel({ ...modelP1, _conversationCount: 2 });
    expect(trustP1.phase).toBe(1);

    const modelP2 = createTestModel({
      evolution: { totalCycles: 3, successRate: 1.0, byOperationType: { addConnection: { proposed: 3, applied: 3, rolledBack: 0, effectiveness: 1.0 } }, recentCycles: appliedCycles },
      userPreferences: {
        approvalHistory: [
          { timestamp: '', proposalSummary: '', impactLevel: 'MINOR', approved: true },
          { timestamp: '', proposalSummary: '', impactLevel: 'MINOR', approved: true },
          { timestamp: '', proposalSummary: '', impactLevel: 'MINOR', approved: true },
        ],
        autoApprovePatterns: [],
        neverApprovePatterns: [],
      },
    });
    const trustP2 = computeTrustLevel({ ...modelP2, _conversationCount: 8 });
    expect(trustP2.phase).toBe(2);
    expect(trustP2.score).toBeGreaterThan(trustP1.score);
  });

  it('full pipeline: failures → insights → genesis context → trust progression', async () => {
    // This test simulates the entire lifecycle:
    // 1. A project with poor health and recurring failures
    // 2. Insight engine detects actionable patterns
    // 3. Genesis insight context is built for the AI
    // 4. After applying fixes, trust advances

    const engine = new InsightEngine();

    // Phase 1: Failing project
    const failingModel = createTestModel({
      health: {
        overall: 20,
        workflows: [
          { file: 'bot.ts', score: 20, totalRuns: 10, successRate: 0.2, avgDurationMs: 2000, lastRun: new Date().toISOString(), trend: 'degrading' },
        ],
      },
      bots: [
        { name: 'main-bot', workflowFile: 'bot.ts', ejected: true, totalTasksRun: 10, successRate: 0.2, avgTaskDurationMs: 2000, topFailurePatterns: [] },
      ],
      failurePatterns: [
        { pattern: 'Validation failed: unhandled error path', category: 'parse', occurrences: 8, lastSeen: new Date().toISOString(), workflows: ['bot.ts'], transient: false },
      ],
    });

    const initialInsights = engine.analyze(failingModel);
    expect(initialInsights.length).toBeGreaterThanOrEqual(2); // failure + bot performance
    expect(initialInsights.some(i => i.genesisCandidate)).toBe(true);
    expect(initialInsights.some(i => i.type === 'evolution-opportunity')).toBe(true);

    // Phase 2: After genesis applies fixes — health improves
    const fixedModel = createTestModel({
      health: {
        overall: 80,
        workflows: [
          { file: 'bot.ts', score: 80, totalRuns: 20, successRate: 0.8, avgDurationMs: 1500, lastRun: new Date().toISOString(), trend: 'improving' },
        ],
      },
      bots: [
        { name: 'main-bot', workflowFile: 'bot.ts', ejected: true, totalTasksRun: 20, successRate: 0.8, avgTaskDurationMs: 1500, topFailurePatterns: [] },
      ],
      failurePatterns: [], // failures resolved
      evolution: {
        totalCycles: 1,
        successRate: 1.0,
        byOperationType: { addNode: { proposed: 1, applied: 1, rolledBack: 0, effectiveness: 1.0 } },
        recentCycles: [],
      },
      userPreferences: {
        approvalHistory: [{ timestamp: '', proposalSummary: 'Add error handler', impactLevel: 'MINOR', approved: true }],
        autoApprovePatterns: [],
        neverApprovePatterns: [],
      },
    });

    const fixedInsights = engine.analyze(fixedModel);
    // Fewer critical insights after fix
    const criticalBefore = initialInsights.filter(i => i.severity === 'critical').length;
    const criticalAfter = fixedInsights.filter(i => i.severity === 'critical').length;
    expect(criticalAfter).toBeLessThan(criticalBefore);

    // Trust should be higher
    const trustBefore = computeTrustLevel({ ...failingModel, _conversationCount: 3 });
    const trustAfter = computeTrustLevel({ ...fixedModel, _conversationCount: 8 });
    expect(trustAfter.score).toBeGreaterThan(trustBefore.score);
  });
});
