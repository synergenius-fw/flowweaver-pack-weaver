import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { withFileLock } from './file-lock.js';

export interface SessionState {
  sessionId: string;
  status: 'idle' | 'planning' | 'executing' | 'validating' | 'waiting-approval' | 'paused' | 'fixing';
  currentTask: string | null;
  completedTasks: number;
  totalCost: number;
  startedAt: number;
  lastActivity: number;
}

export class SessionStore {
  private filePath: string;

  constructor(dir?: string) {
    const base = dir ?? path.join(os.homedir(), '.weaver');
    this.filePath = path.join(base, 'session.json');
  }

  async create(): Promise<SessionState> {
    const state: SessionState = {
      sessionId: crypto.randomUUID().slice(0, 8),
      status: 'idle',
      currentTask: null,
      completedTasks: 0,
      totalCost: 0,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    };
    await this.save(state);
    return state;
  }

  load(): SessionState | null {
    try {
      if (!fs.existsSync(this.filePath)) return null;
      return JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as SessionState;
    } catch (err) {
      if (process.env.WEAVER_VERBOSE) process.stderr.write(`[weaver] session state load failed: ${err}\n`);
      return null;
    }
  }

  async save(state: SessionState): Promise<void> {
    return withFileLock(this.filePath, () => {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      state.lastActivity = Date.now();
      fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2), 'utf-8');
    });
  }

  async update(patch: Partial<SessionState>): Promise<SessionState | null> {
    return withFileLock(this.filePath, () => {
      const state = this.load();
      if (!state) return null;
      Object.assign(state, patch);
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      state.lastActivity = Date.now();
      fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2), 'utf-8');
      return state;
    });
  }

  clear(): void {
    try {
      fs.unlinkSync(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
