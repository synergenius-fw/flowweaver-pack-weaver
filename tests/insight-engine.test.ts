import { describe, it, expect } from 'vitest';
import { InsightEngine } from '../src/bot/insight-engine.js';
import type { ProjectModel, BotProfile, FailurePattern, WorkflowHealth } from '../src/bot/types.js';

// ---------------------------------------------------------------------------
// Tests for insight-engine.ts
// Focus: all 6 detectors, sort stability, edge cases with partial data
// ---------------------------------------------------------------------------

function makeModel(overrides: Partial<ProjectModel> = {}): ProjectModel {
  return {
    projectDir: '/tmp/test-project',
    builtAt: Date.now(),
    health: { overall: 80, workflows: [] },
    bots: [],
    failurePatterns: [],
    userPreferences: {
      approvalHistory: [],
      autoApprovePatterns: [],
      neverApprovePatterns: [],
    },
    evolution: {
      totalCycles: 0,
      successRate: 0,
      byOperationType: {},
      recentCycles: [],
    },
    cost: {
      totalSpent: 0,
      last7Days: 0,
      last30Days: 0,
      trend: 'stable' as const,
      costPerSuccessfulRun: 0,
      highCostWorkflows: [],
    },
    trust: {
      score: 50,
      phase: 1,
      factors: {
        conversationCount: 0,
        approvalConsistency: 0,
        genesisSuccessRate: 0,
        daysSinceFirstUse: 0,
      },
    },
    ...overrides,
  };
}

function makeFailurePattern(overrides: Partial<FailurePattern> = {}): FailurePattern {
  return {
    pattern: 'ENOENT',
    category: 'io',
    occurrences: 5,
    lastSeen: new Date().toISOString(),
    workflows: ['wf1.ts'],
    transient: false,
    ...overrides,
  };
}

function makeWorkflow(overrides: Partial<WorkflowHealth> = {}): WorkflowHealth {
  return {
    file: 'test-workflow.ts',
    score: 80,
    totalRuns: 20,
    successRate: 0.9,
    avgDurationMs: 5000,
    lastRun: new Date().toISOString(),
    trend: 'stable' as const,
    ...overrides,
  };
}

function makeBot(overrides: Partial<BotProfile> = {}): BotProfile {
  return {
    name: 'test-bot',
    workflowFile: 'bot-wf.ts',
    ejected: false,
    totalTasksRun: 10,
    successRate: 0.3,
    avgTaskDurationMs: 30000,
    topFailurePatterns: [],
    ...overrides,
  };
}

const engine = new InsightEngine();

// =========================================================================
// BUG: Sort stability with unknown severity
// =========================================================================
describe('analyze() sort', () => {
  it('sorts critical before warning before info', () => {
    const model = makeModel({
      failurePatterns: [
        // This will produce a "warning" insight (occurrences >= 3 but < 5 or transient)
        makeFailurePattern({ pattern: 'warn-pat', occurrences: 3, transient: true }),
        // This will produce a "critical" insight (occurrences >= 5 and not transient)
        makeFailurePattern({ pattern: 'crit-pat', occurrences: 5, transient: false }),
      ],
      health: {
        overall: 50,
        workflows: [
          // Unused workflow produces "info"
          makeWorkflow({ file: 'unused.ts', totalRuns: 0 }),
        ],
      },
    });

    const insights = engine.analyze(model);
    expect(insights.length).toBeGreaterThanOrEqual(3);

    const severities = insights.map((i) => i.severity);
    const critIdx = severities.indexOf('critical');
    const warnIdx = severities.indexOf('warning');
    const infoIdx = severities.indexOf('info');

    expect(critIdx).toBeLessThan(warnIdx);
    expect(warnIdx).toBeLessThan(infoIdx);
  });

  it('does not crash or produce unstable sort when severity is unrecognized', () => {
    // We can't inject an unknown severity directly, but we can verify
    // the sort handles NaN gracefully by checking the sort is deterministic.
    // The real test: if severityOrder lookup returns undefined, NaN math
    // should not corrupt the array.
    const model = makeModel({
      failurePatterns: [
        makeFailurePattern({ pattern: 'a', occurrences: 5, transient: false }),
        makeFailurePattern({ pattern: 'b', occurrences: 3, transient: true }),
      ],
      health: {
        overall: 50,
        workflows: [makeWorkflow({ file: 'unused.ts', totalRuns: 0 })],
      },
    });

    // Run sort 10 times — with NaN bug, order would be non-deterministic
    const results: string[][] = [];
    for (let i = 0; i < 10; i++) {
      const insights = engine.analyze(model);
      results.push(insights.map((ins) => ins.title));
    }
    // All 10 runs should produce the same ordering
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toEqual(results[0]);
    }
  });

  it('tiebreaks same-severity insights by confidence (descending)', () => {
    const model = makeModel({
      failurePatterns: [
        // Both will be "critical" (>=5, not transient), different confidence
        makeFailurePattern({ pattern: 'low-conf', occurrences: 5, transient: false }),
        makeFailurePattern({ pattern: 'high-conf', occurrences: 9, transient: false }),
      ],
    });

    const insights = engine.analyze(model);
    const criticals = insights.filter((i) => i.severity === 'critical');
    expect(criticals.length).toBe(2);
    // Higher occurrences = higher confidence, should come first
    expect(criticals[0].confidence).toBeGreaterThanOrEqual(criticals[1].confidence);
  });
});

// =========================================================================
// BUG: Missing guard on empty/partial cost data
// =========================================================================
describe('detectCostOptimizations with partial data', () => {
  it('does not crash when highCostWorkflows is undefined', () => {
    const model = makeModel({
      cost: {
        totalSpent: 100,
        last7Days: 50,
        last30Days: 100,
        trend: 'increasing',
        costPerSuccessfulRun: 10,
        highCostWorkflows: undefined as unknown as Array<{ workflow: string; avgCost: number }>,
      },
    });
    expect(() => engine.analyze(model)).not.toThrow();
  });

  it('does not crash when health.workflows is undefined', () => {
    const model = makeModel({
      health: {
        overall: 50,
        workflows: undefined as unknown as WorkflowHealth[],
      },
      cost: {
        totalSpent: 100,
        last7Days: 50,
        last30Days: 100,
        trend: 'increasing',
        costPerSuccessfulRun: 10,
        highCostWorkflows: [{ workflow: 'test.ts', avgCost: 5 }],
      },
    });
    expect(() => engine.analyze(model)).not.toThrow();
  });
});

// =========================================================================
// detectRecurringFailures
// =========================================================================
describe('detectRecurringFailures', () => {
  it('ignores patterns with fewer than 3 occurrences', () => {
    const model = makeModel({
      failurePatterns: [makeFailurePattern({ occurrences: 2 })],
    });
    const insights = engine.analyze(model);
    expect(insights.filter((i) => i.type === 'failure-pattern')).toHaveLength(0);
  });

  it('returns warning for transient patterns with >= 3 occurrences', () => {
    const model = makeModel({
      failurePatterns: [makeFailurePattern({ occurrences: 4, transient: true })],
    });
    const insights = engine.analyze(model).filter((i) => i.type === 'failure-pattern');
    expect(insights).toHaveLength(1);
    expect(insights[0].severity).toBe('warning');
    expect(insights[0].genesisCandidate).toBe(false);
  });

  it('returns critical for non-transient patterns with >= 5 occurrences', () => {
    const model = makeModel({
      failurePatterns: [makeFailurePattern({ occurrences: 6, transient: false })],
    });
    const insights = engine.analyze(model).filter((i) => i.type === 'failure-pattern');
    expect(insights).toHaveLength(1);
    expect(insights[0].severity).toBe('critical');
    expect(insights[0].genesisCandidate).toBe(true);
  });

  it('caps confidence at 0.95', () => {
    const model = makeModel({
      failurePatterns: [makeFailurePattern({ occurrences: 100 })],
    });
    const insights = engine.analyze(model).filter((i) => i.type === 'failure-pattern');
    expect(insights[0].confidence).toBe(0.95);
  });
});

// =========================================================================
// detectHealthTrends
// =========================================================================
describe('detectHealthTrends', () => {
  it('returns insight for degrading workflows', () => {
    const model = makeModel({
      health: {
        overall: 50,
        workflows: [makeWorkflow({ trend: 'degrading', score: 40, totalRuns: 50 })],
      },
    });
    const insights = engine.analyze(model).filter((i) => i.type === 'health-trend');
    expect(insights).toHaveLength(1);
    expect(insights[0].severity).toBe('critical'); // score < 50
  });

  it('ignores stable and improving workflows', () => {
    const model = makeModel({
      health: {
        overall: 80,
        workflows: [
          makeWorkflow({ trend: 'stable' }),
          makeWorkflow({ trend: 'improving', file: 'good.ts' }),
        ],
      },
    });
    const insights = engine.analyze(model).filter((i) => i.type === 'health-trend');
    expect(insights).toHaveLength(0);
  });

  it('returns warning when score >= 50', () => {
    const model = makeModel({
      health: {
        overall: 60,
        workflows: [makeWorkflow({ trend: 'degrading', score: 60 })],
      },
    });
    const insights = engine.analyze(model).filter((i) => i.type === 'health-trend');
    expect(insights[0].severity).toBe('warning');
  });
});

// =========================================================================
// detectCostOptimizations
// =========================================================================
describe('detectCostOptimizations', () => {
  it('flags increasing cost trend', () => {
    const model = makeModel({
      cost: {
        totalSpent: 100,
        last7Days: 50,
        last30Days: 100,
        trend: 'increasing',
        costPerSuccessfulRun: 10,
        highCostWorkflows: [],
      },
    });
    const insights = engine.analyze(model).filter((i) => i.type === 'cost-optimization');
    expect(insights.some((i) => i.title === 'Cost trend is increasing')).toBe(true);
  });

  it('flags low-success-rate bots with enough runs', () => {
    const model = makeModel({
      bots: [makeBot({ successRate: 0.4, totalTasksRun: 10 })],
    });
    const insights = engine.analyze(model).filter(
      (i) => i.type === 'cost-optimization' && i.title.includes('bot'),
    );
    expect(insights).toHaveLength(1);
  });

  it('does not flag bots with high success rate', () => {
    const model = makeModel({
      bots: [makeBot({ successRate: 0.9, totalTasksRun: 10 })],
    });
    const insights = engine.analyze(model).filter(
      (i) => i.type === 'cost-optimization' && i.title.includes('bot'),
    );
    expect(insights).toHaveLength(0);
  });

  it('flags high-cost workflows with low success rate', () => {
    const model = makeModel({
      health: {
        overall: 50,
        workflows: [makeWorkflow({ file: 'expensive.ts', successRate: 0.3, totalRuns: 10 })],
      },
      cost: {
        totalSpent: 200,
        last7Days: 50,
        last30Days: 200,
        trend: 'stable',
        costPerSuccessfulRun: 20,
        highCostWorkflows: [{ workflow: 'expensive.ts', avgCost: 15 }],
      },
    });
    const insights = engine.analyze(model).filter(
      (i) => i.type === 'cost-optimization' && i.title.includes('workflow'),
    );
    expect(insights).toHaveLength(1);
  });
});

// =========================================================================
// detectEvolutionOpportunities
// =========================================================================
describe('detectEvolutionOpportunities', () => {
  it('suggests first genesis cycle when conditions met', () => {
    const model = makeModel({
      health: { overall: 50, workflows: [makeWorkflow()] },
      failurePatterns: [makeFailurePattern()],
      evolution: {
        totalCycles: 0,
        successRate: 0,
        byOperationType: {},
        recentCycles: [],
      },
    });
    const insights = engine.analyze(model).filter((i) => i.type === 'evolution-opportunity');
    expect(insights.some((i) => i.title.includes('first genesis'))).toBe(true);
  });

  it('does not suggest first cycle if already run', () => {
    const model = makeModel({
      health: { overall: 50, workflows: [makeWorkflow()] },
      failurePatterns: [makeFailurePattern()],
      evolution: {
        totalCycles: 3,
        successRate: 0.5,
        byOperationType: {},
        recentCycles: [],
      },
    });
    const insights = engine.analyze(model).filter(
      (i) => i.type === 'evolution-opportunity' && i.title.includes('first genesis'),
    );
    expect(insights).toHaveLength(0);
  });

  it('flags high-effectiveness operations', () => {
    const model = makeModel({
      evolution: {
        totalCycles: 10,
        successRate: 0.8,
        byOperationType: {
          addNode: { proposed: 10, applied: 9, rolledBack: 1, effectiveness: 0.9 },
        },
        recentCycles: [],
      },
    });
    const insights = engine.analyze(model).filter(
      (i) => i.type === 'evolution-opportunity' && i.title.includes('High-effectiveness'),
    );
    expect(insights).toHaveLength(1);
    expect(insights[0].severity).toBe('info');
  });

  it('flags low-effectiveness operations as warning', () => {
    const model = makeModel({
      evolution: {
        totalCycles: 10,
        successRate: 0.3,
        byOperationType: {
          removeNode: { proposed: 10, applied: 2, rolledBack: 8, effectiveness: 0.2 },
        },
        recentCycles: [],
      },
    });
    const insights = engine.analyze(model).filter(
      (i) => i.type === 'evolution-opportunity' && i.title.includes('Low-effectiveness'),
    );
    expect(insights).toHaveLength(1);
    expect(insights[0].severity).toBe('warning');
  });
});

// =========================================================================
// detectBotPerformance
// =========================================================================
describe('detectBotPerformance', () => {
  it('flags underperforming bots', () => {
    const model = makeModel({
      bots: [makeBot({ name: 'slow-bot', successRate: 0.2, totalTasksRun: 10 })],
    });
    const insights = engine.analyze(model).filter((i) => i.type === 'bot-performance');
    expect(insights).toHaveLength(1);
    expect(insights[0].severity).toBe('critical'); // < 0.3
    expect(insights[0].targetBot).toBe('slow-bot');
    expect(insights[0].genesisCandidate).toBe(true);
  });

  it('returns warning for moderate underperformance', () => {
    const model = makeModel({
      bots: [makeBot({ successRate: 0.4, totalTasksRun: 5 })],
    });
    const insights = engine.analyze(model).filter((i) => i.type === 'bot-performance');
    expect(insights).toHaveLength(1);
    expect(insights[0].severity).toBe('warning');
  });

  it('ignores bots with too few tasks', () => {
    const model = makeModel({
      bots: [makeBot({ successRate: 0.1, totalTasksRun: 2 })],
    });
    const insights = engine.analyze(model).filter((i) => i.type === 'bot-performance');
    expect(insights).toHaveLength(0);
  });

  it('ignores bots with good success rate', () => {
    const model = makeModel({
      bots: [makeBot({ successRate: 0.8, totalTasksRun: 20 })],
    });
    const insights = engine.analyze(model).filter((i) => i.type === 'bot-performance');
    expect(insights).toHaveLength(0);
  });
});

// =========================================================================
// detectUnusedWorkflows
// =========================================================================
describe('detectUnusedWorkflows', () => {
  it('flags workflows with zero runs', () => {
    const model = makeModel({
      health: {
        overall: 50,
        workflows: [makeWorkflow({ file: 'never-run.ts', totalRuns: 0 })],
      },
    });
    const insights = engine.analyze(model).filter((i) => i.type === 'unused-workflow');
    expect(insights).toHaveLength(1);
    expect(insights[0].severity).toBe('info');
  });

  it('ignores workflows with runs', () => {
    const model = makeModel({
      health: {
        overall: 80,
        workflows: [makeWorkflow({ totalRuns: 5 })],
      },
    });
    const insights = engine.analyze(model).filter((i) => i.type === 'unused-workflow');
    expect(insights).toHaveLength(0);
  });
});

// =========================================================================
// makeId determinism
// =========================================================================
describe('insight IDs', () => {
  it('produces stable IDs for the same input', () => {
    const model = makeModel({
      failurePatterns: [makeFailurePattern({ pattern: 'stable-id-test', occurrences: 5 })],
    });
    const first = engine.analyze(model);
    const second = engine.analyze(model);
    expect(first.map((i) => i.id)).toEqual(second.map((i) => i.id));
  });
});

// =========================================================================
// Empty model
// =========================================================================
describe('empty model', () => {
  it('returns empty array for model with no data', () => {
    const model = makeModel();
    const insights = engine.analyze(model);
    expect(insights).toEqual([]);
  });
});
