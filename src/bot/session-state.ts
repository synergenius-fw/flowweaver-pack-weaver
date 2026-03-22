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
      // Try backup recovery
      return this.loadBackup();
    }
  }

  /** Recover session from backup file when primary is corrupt. */
  private loadBackup(): SessionState | null {
    const backupPath = this.filePath + '.bak';
    if (!fs.existsSync(backupPath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(backupPath, 'utf-8')) as SessionState;
      // Restore backup to primary
      try { this.writeAtomic(data); } catch { /* best effort */ }
      return data;
    } catch (err) {
      if (process.env.WEAVER_VERBOSE) process.stderr.write(`[weaver] session backup load failed: ${err}\n`);
      return null;
    }
  }

  async save(state: SessionState): Promise<void> {
    return withFileLock(this.filePath, () => {
      state.lastActivity = Date.now();
      this.writeAtomic(state);
    });
  }

  async update(patch: Partial<SessionState>): Promise<SessionState | null> {
    return withFileLock(this.filePath, () => {
      const state = this.load();
      if (!state) return null;
      Object.assign(state, patch);
      state.lastActivity = Date.now();
      this.writeAtomic(state);
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

  /** Atomic write: write to temp file, backup existing, rename into place. */
  private writeAtomic(state: SessionState): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const tmpPath = this.filePath + `.tmp.${process.pid}`;
    const backupPath = this.filePath + '.bak';
    const content = JSON.stringify(state, null, 2);

    // Write to temp file first
    fs.writeFileSync(tmpPath, content, 'utf-8');

    // Backup current file if it exists
    if (fs.existsSync(this.filePath)) {
      try { fs.copyFileSync(this.filePath, backupPath); } catch { /* best effort */ }
    }

    // Atomic rename
    fs.renameSync(tmpPath, this.filePath);

    // Update backup after successful write
    try { fs.copyFileSync(this.filePath, backupPath); } catch { /* best effort */ }
  }
}
