import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

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

  create(): SessionState {
    const state: SessionState = {
      sessionId: crypto.randomUUID().slice(0, 8),
      status: 'idle',
      currentTask: null,
      completedTasks: 0,
      totalCost: 0,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    };
    this.save(state);
    return state;
  }

  load(): SessionState | null {
    try {
      if (!fs.existsSync(this.filePath)) return null;
      return JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as SessionState;
    } catch {
      return null;
    }
  }

  save(state: SessionState): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    state.lastActivity = Date.now();
    fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  update(patch: Partial<SessionState>): SessionState | null {
    const state = this.load();
    if (!state) return null;
    Object.assign(state, patch);
    this.save(state);
    return state;
  }

  clear(): void {
    try { fs.unlinkSync(this.filePath); } catch { /* ignore */ }
  }
}
