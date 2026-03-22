/**
 * Device Connection — Weaver-specific handlers for the core DeviceConnection.
 *
 * The transport (WebSocket, heartbeat, reconnect) lives in @synergenius/flow-weaver/agent.
 * This module registers handlers for file operations, health, insights, improve status.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Re-export the core DeviceConnection for convenience
export { DeviceConnection } from '@synergenius/flow-weaver/agent';
export type { DeviceConnectionOptions, DeviceInfo, DeviceEvent } from '@synergenius/flow-weaver/agent';

/**
 * Register weaver-specific request handlers on a DeviceConnection.
 */
export function registerWeaverHandlers(
  conn: import('@synergenius/flow-weaver/agent').DeviceConnection,
  projectDir: string,
): void {
  // Advertise weaver capabilities
  conn.addCapability('file_read');
  conn.addCapability('file_list');
  conn.addCapability('health');
  conn.addCapability('insights');
  conn.addCapability('improve');
  conn.addCapability('assistant');

  // File read
  conn.onRequest('file:read', async (_method, params) => {
    const filePath = path.resolve(projectDir, String(params.path ?? ''));
    if (!filePath.startsWith(projectDir)) throw new Error('Path outside project directory');
    if (!fs.existsSync(filePath)) throw new Error('File not found');
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      return { type: 'directory', entries: fs.readdirSync(filePath) };
    }
    if (stat.size > 1_048_576) throw new Error('File too large (>1MB)');
    return { type: 'file', content: fs.readFileSync(filePath, 'utf-8') };
  });

  // File list
  conn.onRequest('file:list', async (_method, params) => {
    const dirPath = path.resolve(projectDir, String(params.path ?? '.'));
    if (!dirPath.startsWith(projectDir)) throw new Error('Path outside project directory');
    if (!fs.existsSync(dirPath)) throw new Error('Directory not found');
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries
      .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist')
      .map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
        path: path.relative(projectDir, path.join(dirPath, e.name)),
      }));
  });

  // Project health
  conn.onRequest('health', async () => {
    try {
      const { ProjectModelStore } = await import('./project-model.js');
      const pms = new ProjectModelStore(projectDir);
      const model = await pms.getOrBuild();
      return { health: model.health, trust: model.trust, cost: model.cost, bots: model.bots };
    } catch {
      return { error: 'Project model not available' };
    }
  });

  // Insights
  conn.onRequest('insights', async () => {
    try {
      const { ProjectModelStore } = await import('./project-model.js');
      const { InsightEngine } = await import('./insight-engine.js');
      const model = await new ProjectModelStore(projectDir).getOrBuild();
      return new InsightEngine().analyze(model);
    } catch {
      return [];
    }
  });

  // Improve status
  conn.onRequest('improve:status', async () => {
    try {
      const summaryDir = path.join(os.homedir(), '.weaver', 'improve');
      if (!fs.existsSync(summaryDir)) return { running: false, lastRun: null };
      const files = fs.readdirSync(summaryDir).filter(f => f.endsWith('.json')).sort().reverse();
      if (files.length === 0) return { running: false, lastRun: null };
      const latest = JSON.parse(fs.readFileSync(path.join(summaryDir, files[0]!), 'utf-8'));
      let running = false;
      try {
        const { execFileSync } = await import('node:child_process');
        const worktrees = execFileSync('git', ['worktree', 'list'], { encoding: 'utf-8', cwd: projectDir });
        running = worktrees.includes('weaver-improve');
      } catch { /* git not available */ }
      return { running, lastRun: latest };
    } catch {
      return { running: false, lastRun: null };
    }
  });
}
