import { createHash } from 'crypto';
import type { Insight, ProjectModel } from './types.js';

export class InsightEngine {
  analyze(model: ProjectModel): Insight[] {
    const insights = [
      ...this.detectRecurringFailures(model),
      ...this.detectHealthTrends(model),
      ...this.detectCostOptimizations(model),
      ...this.detectEvolutionOpportunities(model),
      ...this.detectBotPerformance(model),
      ...this.detectUnusedWorkflows(model),
    ];

    const severityOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 };
    insights.sort((a, b) => {
      const sevDiff = severityOrder[a.severity] - severityOrder[b.severity];
      if (sevDiff !== 0) return sevDiff;
      return b.confidence - a.confidence;
    });

    return insights;
  }

  private makeId(type: string, title: string): string {
    return createHash('sha256').update(type + title).digest('hex').slice(0, 8);
  }

  private detectRecurringFailures(model: ProjectModel): Insight[] {
    return model.failurePatterns
      .filter((fp) => fp.occurrences >= 3)
      .map((fp) => {
        const type = 'failure-pattern' as const;
        const title = `Recurring failure: ${fp.pattern}`;
        const isCritical = !fp.transient && fp.occurrences >= 5;
        return {
          id: this.makeId(type, title),
          type,
          confidence: Math.min(fp.occurrences / 10, 0.95),
          severity: isCritical ? 'critical' as const : 'warning' as const,
          title,
          description: `Pattern "${fp.pattern}" (${fp.category}) has occurred ${fp.occurrences} times across ${fp.workflows.length} workflow(s).`,
          evidence: [
            `Pattern: ${fp.pattern}`,
            `Occurrences: ${fp.occurrences}`,
          ],
          suggestion: 'Consider adding error handling or a pre-check step',
          genesisCandidate: !fp.transient,
        };
      });
  }

  private detectHealthTrends(model: ProjectModel): Insight[] {
    return model.health.workflows
      .filter((w) => w.trend === 'degrading')
      .map((w) => {
        const type = 'health-trend' as const;
        const title = `Degrading health: ${w.file}`;
        const confidence = Math.min(Math.max(w.totalRuns / 50, 0.3), 0.9);
        return {
          id: this.makeId(type, title),
          type,
          confidence,
          severity: w.score < 50 ? 'critical' as const : 'warning' as const,
          title,
          description: `Workflow ${w.file} has a degrading health trend with a score of ${w.score}.`,
          evidence: [
            `File: ${w.file}`,
            `Score: ${w.score}`,
            `Trend: ${w.trend}`,
          ],
          suggestion: 'Investigate recent changes to this workflow',
          genesisCandidate: false,
        };
      });
  }

  private detectCostOptimizations(model: ProjectModel): Insight[] {
    const insights: Insight[] = [];

    if (model.cost.trend === 'increasing') {
      const type = 'cost-optimization' as const;
      const title = 'Cost trend is increasing';
      insights.push({
        id: this.makeId(type, title),
        type,
        confidence: 0.7,
        severity: 'info',
        title,
        description: `Spending is trending upward: $${model.cost.last7Days.toFixed(2)} in the last 7 days, $${model.cost.last30Days.toFixed(2)} in the last 30 days.`,
        evidence: [
          `Trend: ${model.cost.trend}`,
          `Last 7 days: $${model.cost.last7Days.toFixed(2)}`,
          `Last 30 days: $${model.cost.last30Days.toFixed(2)}`,
        ],
        suggestion: 'Review high-cost workflows and consider reducing run frequency or optimizing steps',
        genesisCandidate: false,
      });
    }

    for (const bot of model.bots) {
      if (bot.successRate < 0.5 && bot.totalTasksRun > 5) {
        const type = 'cost-optimization' as const;
        const title = `Wasted spend on bot: ${bot.name}`;
        insights.push({
          id: this.makeId(type, title),
          type,
          confidence: 0.8,
          severity: 'warning',
          title,
          description: `Bot "${bot.name}" has a ${(bot.successRate * 100).toFixed(0)}% success rate over ${bot.totalTasksRun} runs, resulting in wasted spend.`,
          evidence: [
            `Bot: ${bot.name}`,
            `Success rate: ${(bot.successRate * 100).toFixed(0)}%`,
            `Total runs: ${bot.totalTasksRun}`,
          ],
          suggestion: `Improve the workflow for "${bot.name}" or reduce its run frequency until reliability improves`,
          genesisCandidate: false,
        });
      }
    }

    for (const hw of model.cost.highCostWorkflows) {
      const wf = model.health.workflows.find((w) => w.file === hw.workflow);
      if (wf && wf.successRate < 0.5 && wf.totalRuns > 5) {
        const type = 'cost-optimization' as const;
        const title = `Wasted spend on workflow: ${hw.workflow}`;
        insights.push({
          id: this.makeId(type, title),
          type,
          confidence: 0.8,
          severity: 'warning',
          title,
          description: `Workflow "${hw.workflow}" has a ${(wf.successRate * 100).toFixed(0)}% success rate with an average cost of $${hw.avgCost.toFixed(2)} per run.`,
          evidence: [
            `Workflow: ${hw.workflow}`,
            `Success rate: ${(wf.successRate * 100).toFixed(0)}%`,
            `Avg cost: $${hw.avgCost.toFixed(2)}`,
          ],
          suggestion: `Fix reliability issues in "${hw.workflow}" before continuing to spend on it`,
          genesisCandidate: false,
        });
      }
    }

    return insights;
  }

  private detectEvolutionOpportunities(model: ProjectModel): Insight[] {
    const insights: Insight[] = [];
    const type = 'evolution-opportunity' as const;

    if (
      model.evolution.totalCycles === 0 &&
      model.health.workflows.length > 0 &&
      model.failurePatterns.length > 0
    ) {
      const title = 'Ready for first genesis cycle';
      insights.push({
        id: this.makeId(type, title),
        type,
        confidence: 0.7,
        severity: 'info',
        title,
        description: 'The project has workflows and failure data but has never run a genesis evolution cycle. Consider starting one.',
        evidence: [
          `Workflows: ${model.health.workflows.length}`,
          `Failure patterns: ${model.failurePatterns.length}`,
          `Evolution cycles: 0`,
        ],
        suggestion: 'Run a genesis cycle to automatically improve workflows based on failure patterns',
        genesisCandidate: true,
      });
    }

    for (const [opType, stats] of Object.entries(model.evolution.byOperationType)) {
      if (stats.effectiveness > 0.8) {
        const title = `High-effectiveness operation: ${opType}`;
        insights.push({
          id: this.makeId(type, title),
          type,
          confidence: 0.8,
          severity: 'info',
          title,
          description: `Operation type "${opType}" has an effectiveness of ${(stats.effectiveness * 100).toFixed(0)}% — consider expanding its use.`,
          evidence: [
            `Operation: ${opType}`,
            `Effectiveness: ${(stats.effectiveness * 100).toFixed(0)}%`,
            `Applied: ${stats.applied}`,
            `Rolled back: ${stats.rolledBack}`,
          ],
          suggestion: `Consider expanding the use of "${opType}" operations to more workflows`,
          genesisCandidate: true,
        });
      } else if (stats.effectiveness < 0.3) {
        const title = `Low-effectiveness operation: ${opType}`;
        insights.push({
          id: this.makeId(type, title),
          type,
          confidence: 0.6,
          severity: 'warning',
          title,
          description: `Operation type "${opType}" has an effectiveness of only ${(stats.effectiveness * 100).toFixed(0)}% — it may not be worth proposing.`,
          evidence: [
            `Operation: ${opType}`,
            `Effectiveness: ${(stats.effectiveness * 100).toFixed(0)}%`,
            `Applied: ${stats.applied}`,
            `Rolled back: ${stats.rolledBack}`,
          ],
          suggestion: `Avoid proposing "${opType}" operations until the underlying issues are understood`,
          genesisCandidate: true,
        });
      }
    }

    return insights;
  }

  private detectBotPerformance(model: ProjectModel): Insight[] {
    return model.bots
      .filter((bot) => bot.successRate < 0.5 && bot.totalTasksRun > 3)
      .map((bot) => {
        const type = 'bot-performance' as const;
        const title = `Underperforming bot: ${bot.name}`;
        const topFailure = bot.topFailurePatterns.length > 0 ? bot.topFailurePatterns[0] : undefined;
        return {
          id: this.makeId(type, title),
          type,
          confidence: Math.min(Math.max(bot.totalTasksRun / 20, 0.4), 0.9),
          severity: bot.successRate < 0.3 ? 'critical' as const : 'warning' as const,
          title,
          description: `Bot "${bot.name}" has a ${(bot.successRate * 100).toFixed(0)}% success rate over ${bot.totalTasksRun} tasks.${topFailure ? ` Top failure: ${topFailure}` : ''}`,
          evidence: [
            `Bot: ${bot.name}`,
            `Success rate: ${(bot.successRate * 100).toFixed(0)}%`,
            `Tasks run: ${bot.totalTasksRun}`,
            ...(bot.topFailurePatterns.length > 0
              ? [`Top failures: ${bot.topFailurePatterns.join(', ')}`]
              : []),
          ],
          suggestion: 'Consider evolving the bot workflow to handle these failures',
          genesisCandidate: true,
          targetBot: bot.name,
          operationHint: 'addNode:errorHandler',
        };
      });
  }

  private detectUnusedWorkflows(model: ProjectModel): Insight[] {
    return model.health.workflows
      .filter((w) => w.totalRuns === 0)
      .map((w) => {
        const type = 'unused-workflow' as const;
        const title = `Unused workflow: ${w.file}`;
        return {
          id: this.makeId(type, title),
          type,
          confidence: 0.5,
          severity: 'info' as const,
          title,
          description: `Workflow "${w.file}" has never been run.`,
          evidence: [
            `File: ${w.file}`,
            `Total runs: 0`,
          ],
          suggestion: 'Consider removing or archiving',
          genesisCandidate: false,
        };
      });
  }
}
