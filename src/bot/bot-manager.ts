/**
 * Bot Manager — spawns and manages multiple weaver bot sessions
 * as separate processes. Each bot has its own queue, steering file,
 * and output log under ~/.weaver/bots/{name}/.
 */

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TaskQueue } from './task-queue.js';
import { SteeringController } from './steering.js';

export interface ManagedBot {
  name: string;
  pid: number;
  projectDir: string;
  botDir: string;
  startedAt: number;
  status: 'running' | 'paused' | 'stopped';
}

export interface SpawnOpts {
  projectDir: string;
  parallel?: number;
  deadline?: string;
  autoApprove?: boolean;
  /** Git branch for commits (creates if needed). Keeps main clean for overnight runs. */
  branch?: string;
}

const BOTS_DIR = path.join(os.homedir(), '.weaver', 'bots');

export class BotManager {
  private bots = new Map<string, { meta: ManagedBot; process: ChildProcess }>();

  constructor() {
    // Ensure base dir exists
    fs.mkdirSync(BOTS_DIR, { recursive: true });

    // Clean up on process exit
    const cleanup = () => this.cleanup();
    process.on('exit', cleanup);
    process.on('SIGTERM', cleanup);
  }

  spawn(name: string, opts: SpawnOpts): ManagedBot {
    if (this.bots.has(name)) {
      throw new Error(`Bot "${name}" already exists. Stop it first or use a different name.`);
    }

    const botDir = path.join(BOTS_DIR, name);
    fs.mkdirSync(botDir, { recursive: true });

    // Create git branch if specified (keeps main clean for overnight runs)
    if (opts.branch) {
      try {
        execFileSync('git', ['checkout', '-B', opts.branch], { cwd: opts.projectDir, encoding: 'utf-8', stdio: 'pipe' });
      } catch { /* branch may already exist */ }
    }

    const logPath = path.join(botDir, 'output.log');
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });

    const sessionArgs = [
      'flow-weaver', 'weaver', 'session',
      '--continuous',
      '--project-dir', opts.projectDir,
    ];
    if (opts.autoApprove !== false) sessionArgs.push('--auto-approve');
    if (opts.parallel && opts.parallel > 1) sessionArgs.push('--parallel', String(opts.parallel));
    if (opts.deadline) sessionArgs.push('--until', opts.deadline);

    // On macOS, wrap with caffeinate to prevent sleep during long runs
    const isMac = process.platform === 'darwin';
    const cmd = isMac ? 'caffeinate' : 'npx';
    const args = isMac
      ? ['-i', '-s', 'npx', ...sessionArgs]  // -i: prevent idle sleep, -s: prevent system sleep
      : sessionArgs;

    // Set queue/steering to bot-specific paths
    const env = {
      ...process.env,
      WEAVER_QUEUE_DIR: botDir,
      WEAVER_STEERING_DIR: botDir,
    };

    const child = spawn(cmd, args, {
      cwd: opts.projectDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    // Capture output to log file
    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);

    const meta: ManagedBot = {
      name,
      pid: child.pid ?? 0,
      projectDir: opts.projectDir,
      botDir,
      startedAt: Date.now(),
      status: 'running',
    };

    // Write metadata for persistence
    fs.writeFileSync(path.join(botDir, 'meta.json'), JSON.stringify(meta, null, 2));

    child.on('exit', (code) => {
      const bot = this.bots.get(name);
      if (bot) {
        bot.meta.status = 'stopped';
        fs.writeFileSync(path.join(botDir, 'meta.json'), JSON.stringify(bot.meta, null, 2));
      }
      logStream.write(`\n[bot-manager] Process exited with code ${code}\n`);
      logStream.end();
    });

    this.bots.set(name, { meta, process: child });
    return meta;
  }

  list(): ManagedBot[] {
    // Also load any bots from disk that we didn't spawn (e.g., from a previous assistant)
    this.discoverExistingBots();
    return [...this.bots.values()].map(b => b.meta);
  }

  get(name: string): ManagedBot | null {
    return this.bots.get(name)?.meta ?? null;
  }

  getQueue(name: string): TaskQueue {
    const bot = this.bots.get(name);
    if (!bot) throw new Error(`Bot "${name}" not found.`);
    return new TaskQueue(bot.meta.botDir);
  }

  getSteering(name: string): SteeringController {
    const bot = this.bots.get(name);
    if (!bot) throw new Error(`Bot "${name}" not found.`);
    return new SteeringController(bot.meta.botDir);
  }

  async steer(name: string, command: 'pause' | 'resume' | 'cancel'): Promise<void> {
    const steering = this.getSteering(name);
    await steering.write({ command, timestamp: Date.now() });
    if (command === 'pause') {
      const bot = this.bots.get(name);
      if (bot) bot.meta.status = 'paused';
    } else if (command === 'resume') {
      const bot = this.bots.get(name);
      if (bot) bot.meta.status = 'running';
    }
  }

  stop(name: string): void {
    const bot = this.bots.get(name);
    if (!bot) throw new Error(`Bot "${name}" not found.`);
    // Send SIGTERM for graceful shutdown
    if (bot.process.pid && !bot.process.killed) {
      bot.process.kill('SIGTERM');
    }
    bot.meta.status = 'stopped';
  }

  kill(name: string): void {
    const bot = this.bots.get(name);
    if (!bot) throw new Error(`Bot "${name}" not found.`);
    if (bot.process.pid && !bot.process.killed) {
      bot.process.kill('SIGKILL');
    }
    bot.meta.status = 'stopped';
  }

  logs(name: string, lines = 50): string {
    const bot = this.bots.get(name);
    if (!bot) throw new Error(`Bot "${name}" not found.`);
    const logPath = path.join(bot.meta.botDir, 'output.log');
    if (!fs.existsSync(logPath)) return '(no logs yet)';
    const content = fs.readFileSync(logPath, 'utf-8');
    const allLines = content.split('\n');
    return allLines.slice(-lines).join('\n');
  }

  cleanup(): void {
    for (const [, bot] of this.bots) {
      if (bot.process.pid && !bot.process.killed) {
        try { bot.process.kill('SIGTERM'); } catch {}
      }
    }
  }

  /** Discover bots from disk that were spawned by a previous assistant session. */
  private discoverExistingBots(): void {
    if (!fs.existsSync(BOTS_DIR)) return;
    for (const name of fs.readdirSync(BOTS_DIR)) {
      if (this.bots.has(name)) continue;
      const metaPath = path.join(BOTS_DIR, name, 'meta.json');
      if (!fs.existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as ManagedBot;
        // Check if process is still running
        if (meta.pid > 0) {
          try {
            process.kill(meta.pid, 0); // test if process exists
            meta.status = 'running';
          } catch {
            meta.status = 'stopped';
          }
        }
        // Store without a process handle (can only steer via file, not kill directly)
        this.bots.set(name, { meta, process: null as unknown as ChildProcess });
      } catch { /* corrupt meta */ }
    }
  }
}
