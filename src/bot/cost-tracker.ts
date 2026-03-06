import type { TokenUsage, RunCostEntry, RunCostSummary } from './types.js';

// Snapshot date: 2026-03-06
export const MODEL_PRICING: Record<
  string,
  { inputPer1M: number; outputPer1M: number; cacheReadPer1M?: number; cacheCreationPer1M?: number }
> = {
  'claude-sonnet-4-6': { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheCreationPer1M: 3.75 },
  'claude-sonnet-4-20250514': { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheCreationPer1M: 3.75 },
  'claude-opus-4-6': { inputPer1M: 15, outputPer1M: 75, cacheReadPer1M: 1.5, cacheCreationPer1M: 18.75 },
  'claude-opus-4-20250514': { inputPer1M: 15, outputPer1M: 75, cacheReadPer1M: 1.5, cacheCreationPer1M: 18.75 },
  'claude-haiku-4-5': { inputPer1M: 0.8, outputPer1M: 4, cacheReadPer1M: 0.08, cacheCreationPer1M: 1.0 },
  'claude-3-5-haiku-20241022': { inputPer1M: 0.8, outputPer1M: 4, cacheReadPer1M: 0.08, cacheCreationPer1M: 1.0 },
  'claude-3-5-sonnet-20241022': { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheCreationPer1M: 3.75 },
};

export class CostTracker {
  private entries: RunCostEntry[] = [];

  constructor(
    private defaultModel: string,
    private provider: string,
  ) {}

  track(step: string, model: string, usage: TokenUsage): void {
    this.entries.push({
      step,
      model,
      usage,
      estimatedCost: CostTracker.estimateCost(model, usage),
      timestamp: Date.now(),
    });
  }

  static estimateCost(model: string, usage: TokenUsage): number {
    const pricing = MODEL_PRICING[model];
    if (!pricing) return 0;

    return (
      (usage.inputTokens * pricing.inputPer1M +
        usage.outputTokens * pricing.outputPer1M +
        (usage.cacheReadInputTokens ?? 0) * (pricing.cacheReadPer1M ?? pricing.inputPer1M) +
        (usage.cacheCreationInputTokens ?? 0) * (pricing.cacheCreationPer1M ?? pricing.inputPer1M)) /
      1_000_000
    );
  }

  getRunSummary(): RunCostSummary {
    let totalIn = 0;
    let totalOut = 0;
    let totalCost = 0;

    for (const entry of this.entries) {
      totalIn += entry.usage.inputTokens;
      totalOut += entry.usage.outputTokens;
      totalCost += entry.estimatedCost;
    }

    return {
      entries: [...this.entries],
      totalInputTokens: totalIn,
      totalOutputTokens: totalOut,
      totalCost,
      model: this.entries[0]?.model ?? this.defaultModel,
      provider: this.provider,
    };
  }

  hasEntries(): boolean {
    return this.entries.length > 0;
  }
}
