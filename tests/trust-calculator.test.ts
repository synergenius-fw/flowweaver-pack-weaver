import { describe, it, expect, vi, afterEach } from 'vitest';
import { computeTrustLevel } from '../src/bot/trust-calculator.js';

/** Helper to build a TrustInput with sensible defaults */
function makeInput(overrides: {
  conversationCount?: number;
  approvalHistory?: Array<{ approved: boolean; impactLevel: string }>;
  totalCycles?: number;
  successRate?: number;
  workflowRuns?: Array<string | null>;
} = {}) {
  return {
    health: {
      workflows: (overrides.workflowRuns ?? []).map(r => ({ lastRun: r })),
    },
    userPreferences: {
      approvalHistory: overrides.approvalHistory ?? [],
    },
    evolution: {
      totalCycles: overrides.totalCycles ?? 0,
      successRate: overrides.successRate ?? 0,
    },
    cost: { last7Days: 0 },
    _conversationCount: overrides.conversationCount ?? 0,
  };
}

describe('computeTrustLevel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -- Phase 1 (default) --

  describe('Phase 1 — default', () => {
    it('returns phase 1 with empty input', () => {
      const result = computeTrustLevel(makeInput());
      expect(result.phase).toBe(1);
      expect(result.score).toBe(0);
    });

    it('returns phase 1 when conversationCount is below phase 2 threshold', () => {
      const result = computeTrustLevel(makeInput({ conversationCount: 4 }));
      expect(result.phase).toBe(1);
    });

    it('returns phase 1 when approval count is below 3 even with high rate', () => {
      const result = computeTrustLevel(makeInput({
        conversationCount: 10,
        approvalHistory: [
          { approved: true, impactLevel: 'STRUCTURAL' },
          { approved: true, impactLevel: 'STRUCTURAL' },
        ],
      }));
      expect(result.phase).toBe(1);
    });

    it('returns phase 1 when approval rate is below 0.6', () => {
      const result = computeTrustLevel(makeInput({
        conversationCount: 10,
        approvalHistory: [
          { approved: true, impactLevel: 'STRUCTURAL' },
          { approved: false, impactLevel: 'STRUCTURAL' },
          { approved: false, impactLevel: 'STRUCTURAL' },
          { approved: false, impactLevel: 'STRUCTURAL' },
        ],
      }));
      expect(result.phase).toBe(1);
    });
  });

  // -- Phase 2 --

  describe('Phase 2 — proposals with explanation', () => {
    it('reaches phase 2 at exact thresholds', () => {
      const result = computeTrustLevel(makeInput({
        conversationCount: 5,
        approvalHistory: [
          { approved: true, impactLevel: 'STRUCTURAL' },
          { approved: true, impactLevel: 'STRUCTURAL' },
          { approved: true, impactLevel: 'STRUCTURAL' },
          { approved: false, impactLevel: 'STRUCTURAL' },
          { approved: false, impactLevel: 'STRUCTURAL' },
        ],
      }));
      // 3/5 = 0.6 approval rate, 5 conversations, 3+ approved -> phase 2
      // Wait: approvalCount is 5 (total history length), approved count is 3
      // approvalRate = 3/5 = 0.6 >= 0.6 ✓
      // approvalCount = 5 >= 3 ✓
      // conversationCount = 5 >= 5 ✓
      expect(result.phase).toBe(2);
    });

    it('stays phase 2 when genesis cycles are insufficient for phase 3', () => {
      const result = computeTrustLevel(makeInput({
        conversationCount: 15,
        approvalHistory: Array.from({ length: 10 }, () => ({ approved: true, impactLevel: 'STRUCTURAL' })),
        totalCycles: 2,
        successRate: 0.8,
      }));
      expect(result.phase).toBe(2);
    });
  });

  // -- Phase 3 --

  describe('Phase 3 — proposals with visual diff', () => {
    it('reaches phase 3 at exact thresholds', () => {
      const approvals = Array.from({ length: 5 }, () => ({ approved: true, impactLevel: 'STRUCTURAL' }));
      // Add some rejected to get 70% rate with 5+ approvals
      // 5 approved + 2 rejected = 7 total, rate = 5/7 = 0.714 >= 0.7
      const rejected = Array.from({ length: 2 }, () => ({ approved: false, impactLevel: 'STRUCTURAL' }));
      const result = computeTrustLevel(makeInput({
        conversationCount: 15,
        approvalHistory: [...approvals, ...rejected],
        totalCycles: 3,
        successRate: 0.5,
      }));
      expect(result.phase).toBe(3);
    });

    it('stays phase 3 when cosmetic approvals are insufficient for phase 4', () => {
      const result = computeTrustLevel(makeInput({
        conversationCount: 30,
        approvalHistory: Array.from({ length: 10 }, () => ({ approved: true, impactLevel: 'STRUCTURAL' })),
        totalCycles: 5,
        successRate: 0.8,
      }));
      // No COSMETIC approvals at all, so cosmeticApprovalRate = 0
      expect(result.phase).toBe(3);
    });

    it('does not reach phase 3 when approval rate is below 0.7', () => {
      // 5 approved, 3 rejected = 5/8 = 0.625 < 0.7
      const approvals = Array.from({ length: 5 }, () => ({ approved: true, impactLevel: 'STRUCTURAL' }));
      const rejected = Array.from({ length: 3 }, () => ({ approved: false, impactLevel: 'STRUCTURAL' }));
      const result = computeTrustLevel(makeInput({
        conversationCount: 15,
        approvalHistory: [...approvals, ...rejected],
        totalCycles: 3,
        successRate: 0.5,
      }));
      expect(result.phase).toBe(2);
    });

    it('does not reach phase 3 when genesis success rate is below 0.5', () => {
      const result = computeTrustLevel(makeInput({
        conversationCount: 15,
        approvalHistory: Array.from({ length: 5 }, () => ({ approved: true, impactLevel: 'STRUCTURAL' })),
        totalCycles: 3,
        successRate: 0.49,
      }));
      expect(result.phase).toBe(2);
    });
  });

  // -- Phase 4 --

  describe('Phase 4 — auto-apply COSMETIC changes', () => {
    it('reaches phase 4 with sufficient cosmetic approvals and days', () => {
      // Need: 30+ conversations, 85%+ cosmetic approval, 3+ cosmetic approvals, 7+ days
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const eightDaysAgo = new Date(now - 8 * 86_400_000).toISOString();

      const cosmeticApprovals = Array.from({ length: 4 }, () => ({ approved: true, impactLevel: 'COSMETIC' }));
      // Also need enough total approvals for phase 2/3 thresholds to be met
      const structuralApprovals = Array.from({ length: 6 }, () => ({ approved: true, impactLevel: 'STRUCTURAL' }));

      const result = computeTrustLevel(makeInput({
        conversationCount: 30,
        approvalHistory: [...cosmeticApprovals, ...structuralApprovals],
        totalCycles: 5,
        successRate: 0.8,
        workflowRuns: [eightDaysAgo],
      }));
      expect(result.phase).toBe(4);
    });

    it('does not reach phase 4 when cosmetic approval rate is below 0.85', () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const tenDaysAgo = new Date(now - 10 * 86_400_000).toISOString();

      // 3 approved + 1 rejected cosmetic = 75% < 85%
      const cosmetic = [
        { approved: true, impactLevel: 'COSMETIC' },
        { approved: true, impactLevel: 'COSMETIC' },
        { approved: true, impactLevel: 'COSMETIC' },
        { approved: false, impactLevel: 'COSMETIC' },
      ];
      const structural = Array.from({ length: 6 }, () => ({ approved: true, impactLevel: 'STRUCTURAL' }));

      const result = computeTrustLevel(makeInput({
        conversationCount: 30,
        approvalHistory: [...cosmetic, ...structural],
        totalCycles: 5,
        successRate: 0.8,
        workflowRuns: [tenDaysAgo],
      }));
      expect(result.phase).not.toBe(4);
    });

    it('does not reach phase 4 when fewer than 3 cosmetic approvals', () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const tenDaysAgo = new Date(now - 10 * 86_400_000).toISOString();

      const cosmetic = [
        { approved: true, impactLevel: 'COSMETIC' },
        { approved: true, impactLevel: 'COSMETIC' },
      ];
      const structural = Array.from({ length: 8 }, () => ({ approved: true, impactLevel: 'STRUCTURAL' }));

      const result = computeTrustLevel(makeInput({
        conversationCount: 30,
        approvalHistory: [...cosmetic, ...structural],
        totalCycles: 5,
        successRate: 0.8,
        workflowRuns: [tenDaysAgo],
      }));
      expect(result.phase).not.toBe(4);
    });

    it('does not reach phase 4 when daysSinceFirstUse is below 7', () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const sixDaysAgo = new Date(now - 6 * 86_400_000).toISOString();

      const cosmetic = Array.from({ length: 4 }, () => ({ approved: true, impactLevel: 'COSMETIC' }));
      const structural = Array.from({ length: 6 }, () => ({ approved: true, impactLevel: 'STRUCTURAL' }));

      const result = computeTrustLevel(makeInput({
        conversationCount: 30,
        approvalHistory: [...cosmetic, ...structural],
        totalCycles: 5,
        successRate: 0.8,
        workflowRuns: [sixDaysAgo],
      }));
      expect(result.phase).not.toBe(4);
    });

    it('does not reach phase 4 when conversations below 30', () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const tenDaysAgo = new Date(now - 10 * 86_400_000).toISOString();

      const cosmetic = Array.from({ length: 4 }, () => ({ approved: true, impactLevel: 'COSMETIC' }));
      const structural = Array.from({ length: 6 }, () => ({ approved: true, impactLevel: 'STRUCTURAL' }));

      const result = computeTrustLevel(makeInput({
        conversationCount: 29,
        approvalHistory: [...cosmetic, ...structural],
        totalCycles: 5,
        successRate: 0.8,
        workflowRuns: [tenDaysAgo],
      }));
      expect(result.phase).not.toBe(4);
    });
  });

  // -- Score calculation --

  describe('score calculation', () => {
    it('returns 0 for empty input', () => {
      const result = computeTrustLevel(makeInput());
      expect(result.score).toBe(0);
    });

    it('returns 100 for maxed-out input', () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const thirtyOneDaysAgo = new Date(now - 31 * 86_400_000).toISOString();

      const result = computeTrustLevel(makeInput({
        conversationCount: 30, // min(30/30, 1) * 25 = 25
        approvalHistory: Array.from({ length: 10 }, () => ({ approved: true, impactLevel: 'STRUCTURAL' })), // 1.0 * 25 = 25
        totalCycles: 5,
        successRate: 1.0, // 1.0 * 25 = 25
        workflowRuns: [thirtyOneDaysAgo], // min(31/30, 1) * 25 = 25
      }));
      expect(result.score).toBe(100);
    });

    it('calculates partial scores correctly', () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const fifteenDaysAgo = new Date(now - 15 * 86_400_000).toISOString();

      const result = computeTrustLevel(makeInput({
        conversationCount: 15, // min(15/30, 1) * 25 = 12.5
        approvalHistory: [
          { approved: true, impactLevel: 'STRUCTURAL' },
          { approved: false, impactLevel: 'STRUCTURAL' },
        ], // 0.5 * 25 = 12.5
        totalCycles: 2,
        successRate: 0.5, // 0.5 * 25 = 12.5
        workflowRuns: [fifteenDaysAgo], // min(15/30, 1) * 25 = 12.5
      }));
      // 12.5 + 12.5 + 12.5 + 12.5 = 50
      expect(result.score).toBe(50);
    });

    it('caps conversation and days contributions at 25', () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const sixtyDaysAgo = new Date(now - 60 * 86_400_000).toISOString();

      const result = computeTrustLevel(makeInput({
        conversationCount: 100, // min(100/30, 1) * 25 = 25 (capped)
        approvalHistory: [],
        totalCycles: 0,
        successRate: 0,
        workflowRuns: [sixtyDaysAgo], // min(60/30, 1) * 25 = 25 (capped)
      }));
      // 25 + 0 + 0 + 25 = 50
      expect(result.score).toBe(50);
    });
  });

  // -- Factors --

  describe('factors', () => {
    it('populates all factor fields', () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const fiveDaysAgo = new Date(now - 5 * 86_400_000).toISOString();

      const result = computeTrustLevel(makeInput({
        conversationCount: 7,
        approvalHistory: [
          { approved: true, impactLevel: 'STRUCTURAL' },
          { approved: false, impactLevel: 'STRUCTURAL' },
        ],
        totalCycles: 4,
        successRate: 0.75,
        workflowRuns: [fiveDaysAgo],
      }));

      expect(result.factors.conversationCount).toBe(7);
      expect(result.factors.approvalConsistency).toBe(0.5);
      expect(result.factors.genesisSuccessRate).toBe(0.75);
      expect(result.factors.daysSinceFirstUse).toBe(5);
    });

    it('uses earliest workflow run for daysSinceFirstUse', () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const tenDaysAgo = new Date(now - 10 * 86_400_000).toISOString();
      const twoDaysAgo = new Date(now - 2 * 86_400_000).toISOString();

      const result = computeTrustLevel(makeInput({
        workflowRuns: [twoDaysAgo, tenDaysAgo, null],
      }));

      expect(result.factors.daysSinceFirstUse).toBe(10);
    });

    it('returns 0 daysSinceFirstUse when no workflow runs exist', () => {
      const result = computeTrustLevel(makeInput({
        workflowRuns: [],
      }));
      expect(result.factors.daysSinceFirstUse).toBe(0);
    });

    it('skips null workflow runs', () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const threeDaysAgo = new Date(now - 3 * 86_400_000).toISOString();

      const result = computeTrustLevel(makeInput({
        workflowRuns: [null, threeDaysAgo, null],
      }));

      expect(result.factors.daysSinceFirstUse).toBe(3);
    });
  });

  // -- Edge cases --

  describe('edge cases', () => {
    it('handles missing _conversationCount (defaults to 0)', () => {
      const input = {
        health: { workflows: [] },
        userPreferences: { approvalHistory: [] },
        evolution: { totalCycles: 0, successRate: 0 },
        cost: { last7Days: 0 },
      };
      const result = computeTrustLevel(input);
      expect(result.phase).toBe(1);
      expect(result.factors.conversationCount).toBe(0);
    });

    it('handles zero genesis cycles (successRate ignored)', () => {
      const result = computeTrustLevel(makeInput({
        totalCycles: 0,
        successRate: 1.0, // should be ignored when totalCycles is 0
      }));
      expect(result.factors.genesisSuccessRate).toBe(0);
    });

    it('handles empty approval history', () => {
      const result = computeTrustLevel(makeInput({
        approvalHistory: [],
      }));
      expect(result.factors.approvalConsistency).toBe(0);
    });

    it('phase 4 check uses cosmeticApprovals.length not total approvals', () => {
      // Many structural approvals but only 2 cosmetic -- should NOT reach phase 4
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const tenDaysAgo = new Date(now - 10 * 86_400_000).toISOString();

      const result = computeTrustLevel(makeInput({
        conversationCount: 50,
        approvalHistory: [
          ...Array.from({ length: 20 }, () => ({ approved: true, impactLevel: 'STRUCTURAL' })),
          { approved: true, impactLevel: 'COSMETIC' },
          { approved: true, impactLevel: 'COSMETIC' },
        ],
        totalCycles: 10,
        successRate: 1.0,
        workflowRuns: [tenDaysAgo],
      }));
      // Only 2 cosmetic approvals < 3 required
      expect(result.phase).not.toBe(4);
    });
  });
});
