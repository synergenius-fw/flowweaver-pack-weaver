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
  private bots = new Map<string, { meta: ManagedBot; process: ChildProcess | null }>();

  constructor() {
    // Ensure base dir exists
    fs.mkdirSync(BOTS_DIR, { recursive: true });

    // Clean up on process exit
    const cleanup = () => this.cleanup();
    process.on('exit', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);
  }

  spawn(name: string, opts: SpawnOpts): ManagedBot {
    if (this.bots.has(name)) {
      throw new Error(`Bot "${name}" already exists. Use bot_stop("${name}") first, or choose a different name.`);
    }

    const botDir = path.join(BOTS_DIR, name);
    fs.mkdirSync(botDir, { recursive: true });

    // Create git branch if specified (keeps main clean for overnight runs)
    // WARNING: checkout -B mutates the user's working directory. Prefer git worktree
    // for isolation when the project supports it.
    if (opts.branch) {
      try {
        // Try worktree first for isolation (does not mutate the user's working dir)
        const worktreePath = path.join(botDir, 'worktree');
        execFileSync('git', ['worktree', 'add', '-B', opts.branch, worktreePath], { cwd: opts.projectDir, encoding: 'utf-8', stdio: 'pipe' });
        opts.projectDir = worktreePath;
      } catch {
        // Worktree unavailable or failed — fall back to checkout but warn
        process.stderr.write(`[weaver] WARNING: "git checkout -B ${opts.branch}" will switch the working directory in ${opts.projectDir}. Use git worktree for isolation.\n`);
        try {
          execFileSync('git', ['checkout', '-B', opts.branch], { cwd: opts.projectDir, encoding: 'utf-8', stdio: 'pipe' });
        } catch { /* branch may already exist */ }
      }
    }

    const logPath = path.join(botDir, 'output.log');
    // Touch the file synchronously so it exists immediately after spawn() returns
    fs.writeFileSync(logPath, '', { flag: 'a' });
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });

    const sessionArgs = [
      'flow-weaver', 'weaver', 'session',
      '--continuous',
      '--project-dir', opts.projectDir,
    ];
    if (opts.autoApprove !== false) sessionArgs.push('--auto-approve');
    if (opts.parallel && opts.parallel > 1) sessionArgs.push('--parallel', String(opts.parallel));
    if (opts.deadline) sessionArgs.push('--until', opts.deadline);

    // Prevent system sleep during long runs (cross-platform)
    const { cmd, args } = wrapWithSleepInhibitor('npx', sessionArgs);

    // Set queue/steering to bot-specific paths
    const env = {
      ...process.env,
      WEAVER_QUEUE_DIR: botDir,
      WEAVER_STEERING_DIR: botDir,
    };

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd: opts.projectDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });
    } catch (err) {
      // Clean up logStream on spawn failure to prevent fd leak
      logStream.destroy();
      throw err;
    }

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
    this.discoverExistingBots();
    // Health check: update status of bots that died
    for (const [, bot] of this.bots) {
      if (bot.meta.status === 'running' && !this.isAlive(bot.meta)) {
        bot.meta.status = 'stopped';
        try {
          fs.writeFileSync(path.join(bot.meta.botDir, 'meta.json'), JSON.stringify(bot.meta, null, 2));
        } catch { /* non-fatal */ }
      }
    }
    return [...this.bots.values()].map(b => b.meta);
  }

  get(name: string): ManagedBot | null {
    const bot = this.bots.get(name);
    if (!bot) return null;
    // Health check on access
    if (bot.meta.status === 'running' && !this.isAlive(bot.meta)) {
      bot.meta.status = 'stopped';
      try {
        fs.writeFileSync(path.join(bot.meta.botDir, 'meta.json'), JSON.stringify(bot.meta, null, 2));
      } catch { /* non-fatal */ }
    }
    return bot.meta;
  }

  /** Check if a bot process is still alive. */
  private isAlive(bot: ManagedBot): boolean {
    if (!bot.pid || bot.pid === 0) return false;
    try { process.kill(bot.pid, 0); return true; } catch { return false; }
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
    // Send SIGTERM for graceful shutdown (process is null for discovered bots)
    if (bot.process?.pid && !bot.process.killed) {
      bot.process.kill('SIGTERM');
    }
    bot.meta.status = 'stopped';
  }

  kill(name: string): void {
    const bot = this.bots.get(name);
    if (!bot) throw new Error(`Bot "${name}" not found.`);
    if (bot.process?.pid && !bot.process.killed) {
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
      if (bot.process?.pid && !bot.process.killed) {
        try { bot.process.kill('SIGTERM'); } catch (err) {
          if (process.env.WEAVER_VERBOSE) process.stderr.write(`[weaver] SIGTERM failed for bot: ${err}\n`);
        }
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
        this.bots.set(name, { meta, process: null });
      } catch { /* corrupt meta */ }
    }
  }
}

/**
 * Cross-platform sleep inhibitor. Wraps a command to prevent the OS from sleeping.
 * - macOS: caffeinate -i -s
 * - Linux: systemd-inhibit (if available)
 * - Windows/other: no wrapper (runs command directly)
 */
function wrapWithSleepInhibitor(command: string, args: string[]): { cmd: string; args: string[] } {
  switch (process.platform) {
    case 'darwin':
      return { cmd: 'caffeinate', args: ['-i', '-s', command, ...args] };
    case 'linux': {
      // Check if systemd-inhibit is available
      try {
        execFileSync('which', ['systemd-inhibit'], { stdio: 'pipe' });
        return {
          cmd: 'systemd-inhibit',
          args: ['--what=idle:sleep', '--who=weaver', '--why=Bot session running', command, ...args],
        };
      } catch {
        return { cmd: command, args };
      }
    }
    default:
      return { cmd: command, args };
  }
}

/**
 * Cross-platform desktop notification.
 * - macOS: osascript
 * - Linux: notify-send (if available)
 * - Windows: PowerShell toast (if available)
 */
export function sendDesktopNotification(title: string, message: string): void {
  try {
    switch (process.platform) {
      case 'darwin':
        execFileSync('osascript', ['-e', `display notification "${message}" with title "${title}"`], { stdio: 'ignore' });
        break;
      case 'linux':
        execFileSync('notify-send', [title, message], { stdio: 'ignore' });
        break;
      case 'win32':
        execFileSync('powershell', ['-Command', `[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); [System.Windows.Forms.MessageBox]::Show('${message}','${title}')`], { stdio: 'ignore' });
        break;
    }
  } catch {
    // Non-fatal — notification is best-effort
  }
}
