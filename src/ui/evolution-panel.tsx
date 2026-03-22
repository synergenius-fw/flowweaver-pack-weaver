/**
 * Weaver Evolution Panel — shows Genesis cycle history, trust level, improve status.
 * Fetches data from the connected device via platform relay endpoints.
 */

import React, { useEffect, useState, useCallback } from 'react';

interface ImproveStatus {
  running: boolean;
  lastRun?: {
    successes: number;
    failures: number;
    skips: number;
    cycles: Array<{ cycle: number; outcome: string; description: string; commitHash?: string }>;
  };
}

interface HealthData {
  health?: { overall: number };
  trust?: { phase: number; score: number };
  cost?: { last7Days: number; trend: string };
}

interface Device {
  id: string;
  name: string;
  capabilities: string[];
}

export function WeaverEvolutionPanel() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [improve, setImprove] = useState<ImproveStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState('');
  const [improving, setImproving] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const devRes = await fetch('/api/devices', { credentials: 'include' });
      if (!devRes.ok) { setError('Not connected'); setLoading(false); return; }
      const devices: Device[] = await devRes.json();
      const device = devices.find(d => d.capabilities?.includes('improve'));
      if (!device) { setError('No device with improve capability'); setLoading(false); return; }
      setDeviceId(device.id);
      setDeviceName(device.name);

      const [healthRes, improveRes] = await Promise.allSettled([
        fetch(`/api/devices/${device.id}/health`, { credentials: 'include' }),
        fetch(`/api/devices/${device.id}/improve/status`, { credentials: 'include' }),
      ]);

      if (healthRes.status === 'fulfilled' && healthRes.value.ok) {
        setHealth(await healthRes.value.json());
      }
      if (improveRes.status === 'fulfilled' && improveRes.value.ok) {
        const data = await improveRes.value.json();
        setImprove(data);
        setImproving(data.running ?? false);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 15_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const startImprove = async () => {
    if (!deviceId) return;
    setImproving(true);
    try {
      await fetch(`/api/devices/${deviceId}/improve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ maxCycles: 5 }),
      });
    } catch { /* ignore */ }
  };

  if (loading) return <div style={{ padding: 16, opacity: 0.5 }}>Loading...</div>;
  if (error) return (
    <div style={{ padding: 16 }}>
      <div style={{ color: '#ef4444', marginBottom: 8 }}>{error}</div>
      <button onClick={fetchData} style={{ fontSize: 12, color: '#6b7280', background: 'none', border: '1px solid #333', borderRadius: 4, padding: '4px 8px', cursor: 'pointer' }}>Retry</button>
    </div>
  );

  const trustPhase = health?.trust?.phase ?? 1;
  const trustScore = health?.trust?.score ?? 0;
  const healthScore = health?.health?.overall ?? 0;

  const outcomeIcon: Record<string, string> = { success: '\u2713', failure: '\u2717' };
  const outcomeColor: Record<string, string> = { success: '#22c55e', failure: '#ef4444' };

  return (
    <div style={{ padding: 16, fontFamily: 'system-ui, sans-serif', fontSize: 13, color: 'var(--color-text-high, #e5e5e5)' }}>
      <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.5, marginBottom: 12 }}>
        {deviceName}
      </div>

      {/* Trust + Health */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
        <div style={{ flex: 1, padding: 12, border: '1px solid rgba(128,128,128,0.2)', borderRadius: 6 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>P{trustPhase}</div>
          <div style={{ fontSize: 10, opacity: 0.5, textTransform: 'uppercase', marginTop: 2 }}>Trust · {trustScore}/100</div>
        </div>
        <div style={{ flex: 1, padding: 12, border: '1px solid rgba(128,128,128,0.2)', borderRadius: 6 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{healthScore}</div>
          <div style={{ fontSize: 10, opacity: 0.5, textTransform: 'uppercase', marginTop: 2 }}>Health</div>
        </div>
      </div>

      {/* Improve */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', opacity: 0.6 }}>
            Improve
          </div>
          <button
            onClick={startImprove}
            disabled={improving}
            style={{
              fontSize: 11,
              fontWeight: 500,
              padding: '3px 10px',
              borderRadius: 4,
              border: '1px solid rgba(128,128,128,0.3)',
              background: improving ? 'rgba(34,197,94,0.1)' : 'transparent',
              color: improving ? '#22c55e' : 'var(--color-text-medium, #999)',
              cursor: improving ? 'default' : 'pointer',
              opacity: improving ? 0.8 : 1,
            }}
          >
            {improving ? 'Running...' : 'Start Improve'}
          </button>
        </div>

        {improve?.lastRun && (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <span style={{ color: '#22c55e', fontWeight: 600 }}>{improve.lastRun.successes} committed</span>
              <span style={{ color: '#ef4444', fontWeight: 600 }}>{improve.lastRun.failures} rolled back</span>
              {improve.lastRun.skips > 0 && <span style={{ opacity: 0.5 }}>{improve.lastRun.skips} skipped</span>}
            </div>

            {improve.lastRun.cycles.slice(-5).reverse().map(cy => (
              <div key={cy.cycle} style={{ padding: '4px 0', borderBottom: '1px solid rgba(128,128,128,0.1)', display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                <span style={{ color: outcomeColor[cy.outcome] ?? '#6b7280', fontWeight: 700, fontSize: 12, width: 14, textAlign: 'center', flexShrink: 0 }}>
                  {outcomeIcon[cy.outcome] ?? '\u25CB'}
                </span>
                <span style={{ flex: 1, opacity: 0.8 }}>{cy.description.slice(0, 80)}</span>
                {cy.commitHash && <span style={{ fontFamily: 'monospace', fontSize: 10, opacity: 0.4 }}>{cy.commitHash}</span>}
              </div>
            ))}
          </>
        )}

        {!improve?.lastRun && (
          <div style={{ opacity: 0.5, textAlign: 'center', padding: 16 }}>
            No improve runs yet. Click "Start Improve" to begin.
          </div>
        )}
      </div>

      <div style={{ textAlign: 'right' }}>
        <button onClick={fetchData} style={{ fontSize: 11, color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer' }}>Refresh</button>
      </div>
    </div>
  );
}

export default WeaverEvolutionPanel;
