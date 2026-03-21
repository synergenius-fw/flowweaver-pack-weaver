/**
 * Trust Calculator — pure function that derives a trust level from the project model.
 *
 * Trust phases:
 *   Phase 1: Insights + suggestions (default)
 *   Phase 2: Proposals with explanation
 *   Phase 3: Proposals with visual diff
 *   Phase 4: Auto-apply COSMETIC changes
 */

import type { TrustLevel } from './types.js';

interface TrustInput {
  health: { workflows: Array<{ lastRun: string | null }> };
  userPreferences: { approvalHistory: Array<{ approved: boolean; impactLevel: string }> };
  evolution: { totalCycles: number; successRate: number };
  cost: { last7Days: number };
  _conversationCount?: number;
}

export function computeTrustLevel(model: TrustInput): TrustLevel {
  const conversationCount = model._conversationCount ?? 0;
  const approvalHistory = model.userPreferences.approvalHistory;
  const approvalCount = approvalHistory.length;
  const approvalRate = approvalCount > 0
    ? approvalHistory.filter(a => a.approved).length / approvalCount
    : 0;
  const genesisSuccessRate = model.evolution.totalCycles > 0 ? model.evolution.successRate : 0;

  // Estimate days since first use from earliest workflow run
  const timestamps: number[] = [];
  for (const w of model.health.workflows) {
    if (w.lastRun) timestamps.push(new Date(w.lastRun).getTime());
  }
  const earliest = timestamps.length > 0 ? Math.min(...timestamps) : Date.now();
  const daysSinceFirstUse = Math.max(0, Math.round((Date.now() - earliest) / 86_400_000));

  // COSMETIC-specific approval rate
  const cosmeticApprovals = approvalHistory.filter(a => a.impactLevel === 'COSMETIC');
  const cosmeticApprovalRate = cosmeticApprovals.length > 0
    ? cosmeticApprovals.filter(a => a.approved).length / cosmeticApprovals.length
    : 0;

  // Weighted score (0-100)
  const score = Math.round(
    Math.min(conversationCount / 30, 1) * 25 +
    approvalRate * 25 +
    genesisSuccessRate * 25 +
    Math.min(daysSinceFirstUse / 30, 1) * 25,
  );

  // Phase thresholds
  let phase: 1 | 2 | 3 | 4 = 1;
  if (
    conversationCount >= 30 &&
    cosmeticApprovalRate >= 0.85 &&
    cosmeticApprovals.length >= 3 &&
    daysSinceFirstUse >= 7
  ) {
    phase = 4;
  } else if (
    conversationCount >= 15 &&
    approvalRate >= 0.7 &&
    approvalCount >= 5 &&
    model.evolution.totalCycles >= 3 &&
    genesisSuccessRate >= 0.5
  ) {
    phase = 3;
  } else if (
    conversationCount >= 5 &&
    approvalCount >= 3 &&
    approvalRate >= 0.6
  ) {
    phase = 2;
  }

  return {
    score,
    phase,
    factors: {
      conversationCount,
      approvalConsistency: approvalRate,
      genesisSuccessRate,
      daysSinceFirstUse,
    },
  };
}
