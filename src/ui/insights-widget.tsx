/**
 * Weaver Insights Widget — shows project health, insights, and cost summary.
 * Fetches data from the connected device via platform relay endpoints.
 */

import React, { useEffect, useState, useCallback } from 'react';

interface InsightsData {
  health: { overall: number; workflows: Array<{ file: string; score: number; trend: string }> };
  bots: Array<{ name: string; ejected: boolean; successRate: number; totalTasksRun: number }>;
  insights: Array<{ severity: string; title: string; description: string; confidence: number }>;
  cost: { last7Days: number; trend: string };
  trust: { phase: number; score: number };
}

interface Device {
  id: string;
  name: string;
  capabilities: string[];
}

export function WeaverInsightsWidget() {
  const [data, setData] = useState<InsightsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deviceName, setDeviceName] = useState('');

  const fetchData = useCallback(async () => {
    try {
      // Find first connected device with insights capability
      const devRes = await fetch('/api/devices', { credentials: 'include' });
      if (!devRes.ok) { setError('Not connected'); setLoading(false); return; }
      const devices: Device[] = await devRes.json();
      const device = devices.find(d => d.capabilities?.includes('insights'));
      if (!device) { setError('No device with insights capability'); setLoading(false); return; }
      setDeviceName(device.name);

      // Fetch health + insights from device
      const [healthRes, insightsRes] = await Promise.allSettled([
        fetch(`/api/devices/${device.id}/health`, { credentials: 'include' }),
        fetch(`/api/devices/${device.id}/insights`, { credentials: 'include' }),
      ]);

      const health = healthRes.status === 'fulfilled' && healthRes.value.ok
        ? await healthRes.value.json() : null;
      const insights = insightsRes.status === 'fulfilled' && insightsRes.value.ok
        ? await insightsRes.value.json() : [];

      setData({
        health: health?.health ?? { overall: 0, workflows: [] },
        bots: health?.bots ?? [],
        insights: Array.isArray(insights) ? insights : [],
        cost: health?.cost ?? { last7Days: 0, trend: 'stable' },
        trust: health?.trust ?? { phase: 1, score: 0 },
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (loading) return <div style={{ padding: 16, opacity: 0.5 }}>Loading insights...</div>;
  if (error) return (
    <div style={{ padding: 16 }}>
      <div style={{ color: '#ef4444', marginBottom: 8 }}>{error}</div>
      <button onClick={fetchData} style={{ fontSize: 12, color: '#6b7280', background: 'none', border: '1px solid #333', borderRadius: 4, padding: '4px 8px', cursor: 'pointer' }}>Retry</button>
    </div>
  );
  if (!data) return null;

  const severityColor: Record<string, string> = { critical: '#ef4444', warning: '#f59e0b', info: '#6b7280' };

  return (
    <div style={{ padding: 16, fontFamily: 'system-ui, sans-serif', fontSize: 13, color: 'var(--color-text-high, #e5e5e5)' }}>
      <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.5, marginBottom: 12 }}>
        {deviceName}
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 16 }}>
        <span style={{ fontSize: 28, fontWeight: 700 }}>{data.health.overall}</span>
        <span style={{ opacity: 0.6 }}>/100 health</span>
        <span style={{ marginLeft: 'auto', opacity: 0.5 }}>
          P{data.trust.phase} · ${data.cost.last7Days.toFixed(2)}/7d
        </span>
      </div>

      {data.insights.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', opacity: 0.6 }}>Insights</div>
          {data.insights.slice(0, 5).map((insight, i) => (
            <div key={i} style={{ padding: '6px 0', borderBottom: '1px solid rgba(128,128,128,0.15)' }}>
              <span style={{ color: severityColor[insight.severity] ?? '#6b7280', fontWeight: 600, marginRight: 8, fontSize: 10, textTransform: 'uppercase' }}>
                {insight.severity}
              </span>
              <span>{insight.title}</span>
            </div>
          ))}
        </div>
      )}

      {data.insights.length === 0 && data.health.overall === 0 && (
        <div style={{ opacity: 0.5, textAlign: 'center', padding: 20 }}>
          No data yet. Connect a device and run some workflows.
        </div>
      )}

      {data.bots.length > 0 && (
        <div>
          <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', opacity: 0.6 }}>Bots</div>
          {data.bots.map((bot, i) => (
            <div key={i} style={{ padding: '4px 0', display: 'flex', justifyContent: 'space-between' }}>
              <span>{bot.name}</span>
              <span style={{ opacity: 0.6 }}>{Math.round(bot.successRate * 100)}% ({bot.totalTasksRun})</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default WeaverInsightsWidget;
