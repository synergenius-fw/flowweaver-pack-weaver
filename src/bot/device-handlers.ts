import type { DeviceConnection } from '@synergenius/flow-weaver/agent';

export interface DeviceHandlerContext {
  projectDir: string;
}

let activeConnection: DeviceConnection | null = null;

export function getActiveConnection(): DeviceConnection | null {
  return activeConnection;
}

export async function register(
  conn: DeviceConnection,
  context: DeviceHandlerContext,
): Promise<void> {
  activeConnection = conn;
  const { projectDir } = context;

  conn.addCapability('health');
  conn.addCapability('insights');
  conn.addCapability('improve');

  conn.onRequest('health', async () => {
    const { ProjectModelStore } = await import('./project-model.js');
    const store = new ProjectModelStore(projectDir);
    const model = await store.getOrBuild();
    return {
      health: model.health,
      trust: model.trust,
      cost: model.cost,
      bots: model.bots,
    };
  });

  conn.onRequest('insights', async () => {
    const { ProjectModelStore } = await import('./project-model.js');
    const { InsightEngine } = await import('./insight-engine.js');
    const store = new ProjectModelStore(projectDir);
    const model = await store.getOrBuild();
    const engine = new InsightEngine();
    return engine.analyze(model);
  });

  conn.onRequest('improve:status', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const logDir = path.join(projectDir, '.weaver', 'improve');
    if (!fs.existsSync(logDir)) return { running: false };
    const files = fs.readdirSync(logDir).filter((f: string) => f.endsWith('.json')).sort().reverse();
    if (files.length === 0) return { running: false };
    try {
      const latest = JSON.parse(fs.readFileSync(path.join(logDir, files[0]), 'utf-8'));
      return { running: false, lastRun: latest };
    } catch {
      return { running: false };
    }
  });

  conn.onRequest('improve:start', async (_method, params) => {
    const { runImproveLoop, DEFAULT_PROTECTED } = await import('./improve-loop.js');
    // Run in background — don't block the request
    runImproveLoop({
      maxCycles: (params as Record<string, unknown>).maxCycles as number ?? 5,
      maxConsecutiveFailures: 5,
      protectedPatterns: DEFAULT_PROTECTED,
      testCommand: 'npx vitest run',
      projectDir,
      deviceConnection: conn,
    }).catch((err) => {
      console.error('Improve loop error:', err);
    });
    return { queued: true };
  });
}
