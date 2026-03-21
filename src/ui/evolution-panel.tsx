/**
 * Weaver Evolution Panel — shows Genesis cycle history and operation effectiveness.
 * Loaded dynamically by the platform's pack UI contributions loader.
 */

import React, { useEffect, useState } from 'react';

interface EvolutionData {
  evolution: {
    totalCycles: number;
    successRate: number;
    byOperationType: Record<string, { proposed: number; applied: number; effectiveness: number }>;
    recentCycles: Array<{ id: string; outcome: string; proposal?: { summary: string; impactLevel: string } }>;
  };
  trust: { phase: number; score: number };
}

export function WeaverEvolutionPanel({ projectDir }: { projectDir?: string }) {
  const [data, setData] = useState<EvolutionData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectDir) return;
    fetch(`/api/mcp/fw_weaver_insights?projectDir=${encodeURIComponent(projectDir)}`)
      .then(r => r.json())
      .then(setData)
      .catch(e => setError(e.message));
  }, [projectDir]);

  if (error) return <div style={{ padding: 16, color: '#ef4444' }}>Error: {error}</div>;
  if (!data) return <div style={{ padding: 16, opacity: 0.5 }}>Loading evolution data...</div>;

  const { evolution, trust } = data;
  const outcomeColor: Record<string, string> = {
    applied: '#22c55e',
    'rolled-back': '#ef4444',
    rejected: '#f59e0b',
    'no-change': '#6b7280',
    error: '#ef4444',
  };

  return (
    <div style={{ padding: 16, fontFamily: 'system-ui, sans-serif', fontSize: 13 }}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Trust Level</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 20, fontWeight: 700 }}>Phase {trust.phase}</span>
          <span style={{ opacity: 0.5 }}>Score: {trust.score}/100</span>
        </div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          Genesis Cycles: {evolution.totalCycles} ({evolution.totalCycles > 0 ? Math.round(evolution.successRate * 100) : 0}% success)
        </div>
      </div>

      {Object.keys(evolution.byOperationType).length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Operation Effectiveness</div>
          {Object.entries(evolution.byOperationType).map(([op, stats]) => (
            <div key={op} style={{ padding: '2px 0', display: 'flex', justifyContent: 'space-between' }}>
              <span>{op}</span>
              <span style={{ opacity: 0.7 }}>{Math.round(stats.effectiveness * 100)}% ({stats.applied}/{stats.proposed})</span>
            </div>
          ))}
        </div>
      )}

      {evolution.recentCycles.length > 0 && (
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Recent Cycles</div>
          {evolution.recentCycles.slice(-5).reverse().map((cycle) => (
            <div key={cycle.id} style={{ padding: '4px 0', borderBottom: '1px solid rgba(128,128,128,0.1)' }}>
              <span style={{ color: outcomeColor[cycle.outcome] ?? '#6b7280', fontWeight: 600, marginRight: 8 }}>
                {cycle.outcome}
              </span>
              <span style={{ opacity: 0.7 }}>{cycle.id}</span>
              {cycle.proposal && (
                <div style={{ opacity: 0.6, paddingLeft: 8 }}>{cycle.proposal.summary}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {evolution.totalCycles === 0 && (
        <div style={{ opacity: 0.5, textAlign: 'center', padding: 20 }}>
          No genesis cycles yet. Use /genesis in the assistant to start evolving bot workflows.
        </div>
      )}
    </div>
  );
}

export default WeaverEvolutionPanel;
