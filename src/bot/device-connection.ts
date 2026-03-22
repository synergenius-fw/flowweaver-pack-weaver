/**
 * Device Connection — WebSocket client that connects to the Flow Weaver platform.
 *
 * When connected, the device appears in Studio as a mounted environment.
 * The platform can request file operations, command execution, and status queries.
 * The device streams events (improve cycles, bot status, health updates).
 *
 * Usage: `weaver connect`
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
// WebSocket uses native API (available in Node 22+)
import { c } from './ansi.js';

export interface DeviceInfo {
  name: string;
  hostname: string;
  projectDir: string;
  platform: string;
  capabilities: string[];
}

export interface DeviceConnectionOptions {
  platformUrl: string;
  token: string;
  projectDir: string;
  deviceName?: string;
  onEvent?: (event: DeviceEvent) => void;
}

export interface DeviceEvent {
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
}

type RequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export class DeviceConnection {
  private ws: WebSocket | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private requestHandlers = new Map<string, RequestHandler>();
  private connected = false;
  private readonly options: DeviceConnectionOptions;
  private readonly deviceInfo: DeviceInfo;
  private readonly out = (s: string) => process.stderr.write(s);

  constructor(options: DeviceConnectionOptions) {
    this.options = options;
    this.deviceInfo = {
      name: options.deviceName ?? os.hostname(),
      hostname: os.hostname(),
      projectDir: options.projectDir,
      platform: process.platform,
      capabilities: ['improve', 'assistant', 'genesis', 'file_read', 'file_list'],
    };
  }

  /**
   * Register a handler for incoming requests from the platform.
   */
  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  /**
   * Connect to the platform. Reconnects automatically on disconnect.
   */
  async connect(): Promise<void> {
    const wsUrl = this.options.platformUrl
      .replace(/^http/, 'ws')
      .replace(/\/$/, '') + '/ws/device';

    this.out(`  ${c.dim(`Connecting to ${wsUrl}...`)}\n`);

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(`${wsUrl}?token=${encodeURIComponent(this.options.token)}`);
      } catch (err) {
        reject(err);
        return;
      }

      this.ws.addEventListener('open', () => {
        this.connected = true;
        this.out(`  ${c.green('✓')} Connected as "${this.deviceInfo.name}"\n`);

        // Send device registration
        this.send({
          type: 'device:register',
          device: this.deviceInfo,
        });

        // Start heartbeat
        this.heartbeatInterval = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.send({ type: 'heartbeat', timestamp: Date.now() });
          }
        }, 30_000);

        resolve();
      });

      this.ws.addEventListener('message', async (event) => {
        try {
          const msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
          await this.handleMessage(msg);
        } catch (err) {
          this.out(`  ${c.dim(`Parse error: ${err instanceof Error ? err.message : err}`)}\n`);
        }
      });

      this.ws.addEventListener('close', (event) => {
        this.connected = false;
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        this.out(`  ${c.dim(`Disconnected (${event.code}). Reconnecting in 5s...`)}\n`);
        this.scheduleReconnect();
      });

      this.ws.addEventListener('error', () => {
        if (!this.connected) {
          reject(new Error('WebSocket connection failed'));
        } else {
          this.out(`  ${c.dim('Connection error')}\n`);
        }
      });
    });
  }

  /**
   * Emit an event to the platform (improve cycle, bot status, etc.)
   */
  emit(event: DeviceEvent): void {
    if (!this.connected) return;
    this.send({ type: 'device:event', event });
    this.options.onEvent?.(event);
  }

  /**
   * Disconnect from the platform.
   */
  disconnect(): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    if (this.ws) {
      this.ws.close(1000, 'Device disconnecting');
      this.ws = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  // --- Private ---

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    const type = String(msg.type ?? '');
    const requestId = String(msg.requestId ?? '');

    if (type === 'request') {
      // Platform is requesting something from this device
      const method = String(msg.method ?? '');
      const params = (msg.params as Record<string, unknown>) ?? {};
      const handler = this.requestHandlers.get(method);

      if (!handler) {
        this.send({ type: 'response', requestId, success: false, error: `Unknown method: ${method}` });
        return;
      }

      try {
        const result = await handler(method, params);
        this.send({ type: 'response', requestId, success: true, result });
      } catch (err) {
        this.send({ type: 'response', requestId, success: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = setTimeout(async () => {
      try {
        await this.connect();
      } catch {
        this.out(`  ${c.dim('Reconnect failed. Retrying in 10s...')}\n`);
        this.reconnectTimeout = setTimeout(() => this.scheduleReconnect(), 10_000);
      }
    }, 5_000);
  }
}

/**
 * Register standard request handlers for file operations and status.
 */
export function registerDefaultHandlers(conn: DeviceConnection, projectDir: string): void {
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

  // Improve status
  conn.onRequest('improve:status', async () => {
    try {
      const summaryDir = path.join(os.homedir(), '.weaver', 'improve');
      if (!fs.existsSync(summaryDir)) return { running: false, lastRun: null };
      const files = fs.readdirSync(summaryDir).filter(f => f.endsWith('.json')).sort().reverse();
      if (files.length === 0) return { running: false, lastRun: null };
      const latest = JSON.parse(fs.readFileSync(path.join(summaryDir, files[0]!), 'utf-8'));
      // Check if worktree exists (indicates running)
      const { execFileSync } = await import('node:child_process');
      let running = false;
      try {
        const worktrees = execFileSync('git', ['worktree', 'list'], { encoding: 'utf-8', cwd: projectDir });
        running = worktrees.includes('weaver-improve');
      } catch { /* git not available */ }
      return { running, lastRun: latest };
    } catch {
      return { running: false, lastRun: null };
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
}
