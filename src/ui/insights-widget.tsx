/**
 * Weaver Insights Dashboard Widget — shows project health, insights, and cost summary.
 * Loaded dynamically by the platform's pack UI contributions loader.
 */

import React, { useEffect, useState } from 'react';

interface InsightsData {
  health: { overall: number; workflows: Array<{ file: string; score: number; trend: string }> };
  bots: Array<{ name: string; ejected: boolean; successRate: number; totalTasksRun: number }>;
  insights: Array<{ severity: string; title: string; description: string; confidence: number }>;
  cost: { last7Days: number; trend: string };
  trust: { phase: number; score: number };
}

export function WeaverInsightsWidget({ projectDir }: { projectDir?: string }) {
  const [data, setData] = useState<InsightsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectDir) return;
    fetch(`/api/mcp/fw_weaver_insights?projectDir=${encodeURIComponent(projectDir)}`)
      .then(r => r.json())
      .then(setData)
      .catch(e => setError(e.message));
  }, [projectDir]);

  if (error) return <div style={{ padding: 16, color: '#ef4444' }}>Error: {error}</div>;
  if (!data) return <div style={{ padding: 16, opacity: 0.5 }}>Loading insights...</div>;

  const severityColor: Record<string, string> = {
    critical: '#ef4444',
    warning: '#f59e0b',
    info: '#6b7280',
  };

  return (
    <div style={{ padding: 16, fontFamily: 'system-ui, sans-serif', fontSize: 13 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
        <span style={{ fontSize: 28, fontWeight: 700 }}>{data.health.overall}</span>
        <span style={{ opacity: 0.6 }}>/100 health</span>
        <span style={{ marginLeft: 'auto', opacity: 0.5 }}>
          Phase {data.trust.phase} · ${data.cost.last7Days.toFixed(2)}/7d ({data.cost.trend})
        </span>
      </div>

      {data.insights.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Insights</div>
          {data.insights.slice(0, 3).map((insight, i) => (
            <div key={i} style={{ padding: '4px 0', borderBottom: '1px solid rgba(128,128,128,0.1)' }}>
              <span style={{ color: severityColor[insight.severity] ?? '#6b7280', fontWeight: 600, marginRight: 8 }}>
                {insight.severity.toUpperCase()}
              </span>
              <span>{insight.title}</span>
              <span style={{ opacity: 0.5, marginLeft: 8 }}>{Math.round(insight.confidence * 100)}%</span>
            </div>
          ))}
        </div>
      )}

      {data.bots.length > 0 && (
        <div>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Bots</div>
          {data.bots.map((bot, i) => (
            <div key={i} style={{ padding: '2px 0' }}>
              {bot.name}: {Math.round(bot.successRate * 100)}% success ({bot.totalTasksRun} tasks)
              {bot.ejected && <span style={{ opacity: 0.5 }}> · ejected</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default WeaverInsightsWidget;
