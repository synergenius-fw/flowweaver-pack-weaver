import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { withFileLock } from './file-lock.js';
import { parseNdjson } from './safe-json.js';
import { resolveWeaverDir } from './paths.js';

export interface QueuedTask {
  id: string;
  instruction: string;
  mode?: 'create' | 'modify' | 'read' | 'batch';
  targets?: string[];
  options?: Record<string, unknown>;
  priority: number;
  addedAt: number;
  status: 'pending' | 'running' | 'completed' | 'no-op' | 'failed' | 'cancelled';
  /** PID of the process running this task (set when status becomes 'running'). */
  runnerId?: number;
  /** Error reason (set on failure) */
  failureReason?: string;
}

export interface AddResult {
  id: string;
  duplicate: boolean;
}

/** Max pending tasks before queue rejects new additions. */
const MAX_PENDING = 200;
/** Don't re-queue tasks completed within this window (ms). */
const CYCLE_DEDUP_WINDOW = 3600_000; // 1 hour

export class TaskQueue {
  readonly filePath: string;

  constructor(dir?: string) {
    const base = dir ?? resolveWeaverDir();
    this.filePath = path.join(base, 'task-queue.ndjson');
  }

  async add(task: Omit<QueuedTask, 'id' | 'addedAt' | 'status'>): Promise<AddResult> {
    return withFileLock(this.filePath, () => {
      const existing = this.readAll();

      // Dedup: skip if a pending task with the same instruction exists
      const pendingDup = existing.find(
        t => t.status === 'pending' && t.instruction === task.instruction,
      );
      if (pendingDup) return { id: pendingDup.id, duplicate: true };

      // Cycle-aware dedup: skip if same instruction was completed recently
      const recentDup = existing.find(
        t => (t.status === 'completed' || t.status === 'no-op')
          && t.instruction === task.instruction
          && Date.now() - t.addedAt < CYCLE_DEDUP_WINDOW,
      );
      if (recentDup) return { id: recentDup.id, duplicate: true };

      // Queue size cap
      const pendingCount = existing.filter(t => t.status === 'pending').length;
      if (pendingCount >= MAX_PENDING) {
        throw new Error(`Queue full (${MAX_PENDING} pending tasks). Use queue_retry to resume failed tasks, or queue_list to review.`);
      }

      const entry: QueuedTask = {
        ...task,
        id: crypto.randomUUID().slice(0, 8),
        addedAt: Date.now(),
        status: 'pending',
      };
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf-8');
      return { id: entry.id, duplicate: false };
    });
  }

  async next(): Promise<QueuedTask | null> {
    return withFileLock(this.filePath, () => {
      const tasks = this.readAll().filter(t => t.status === 'pending');
      tasks.sort((a, b) => b.priority - a.priority || a.addedAt - b.addedAt);
      return tasks[0] ?? null;
    });
  }

  async list(): Promise<QueuedTask[]> {
    return withFileLock(this.filePath, () => this.readAll());
  }

  async remove(id: string): Promise<boolean> {
    return withFileLock(this.filePath, () => {
      const tasks = this.readAll();
      const filtered = tasks.filter(t => t.id !== id);
      if (filtered.length === tasks.length) return false;
      this.writeAll(filtered);
      return true;
    });
  }

  async clear(): Promise<number> {
    return withFileLock(this.filePath, () => {
      const tasks = this.readAll();
      if (tasks.length === 0) return 0;
      try { fs.unlinkSync(this.filePath); } catch { /* ignore */ }
      return tasks.length;
    });
  }

  async markRunning(id: string): Promise<void> {
    return withFileLock(this.filePath, () => {
      const tasks = this.readAll();
      const task = tasks.find(t => t.id === id);
      if (task) {
        task.status = 'running';
        task.runnerId = process.pid;
        this.writeAll(tasks);
      }
    });
  }

  async markComplete(id: string): Promise<void> {
    await this.updateStatus(id, 'completed');
  }

  async markNoOp(id: string): Promise<void> {
    await this.updateStatus(id, 'no-op');
  }

  async markFailed(id: string, reason?: string): Promise<void> {
    return withFileLock(this.filePath, () => {
      const tasks = this.readAll();
      const task = tasks.find(t => t.id === id);
      if (task) {
        task.status = 'failed';
        if (reason) task.failureReason = reason.slice(0, 500);
        this.writeAll(tasks);
      }
    });
  }

  /** Reset a failed or running task back to pending. */
  async retry(id: string): Promise<boolean> {
    return withFileLock(this.filePath, () => {
      const tasks = this.readAll();
      const task = tasks.find(t => t.id === id && (t.status === 'failed' || t.status === 'running'));
      if (!task) return false;
      task.status = 'pending';
      task.failureReason = undefined;
      this.writeAll(tasks);
      return true;
    });
  }

  /** Reset ALL failed tasks back to pending. Returns count reset. */
  async retryAll(): Promise<number> {
    return withFileLock(this.filePath, () => {
      const tasks = this.readAll();
      let count = 0;
      for (const t of tasks) {
        if (t.status === 'failed') {
          t.status = 'pending';
          t.failureReason = undefined;
          count++;
        }
      }
      if (count > 0) this.writeAll(tasks);
      return count;
    });
  }

  /** Reset orphaned "running" tasks to pending (crash recovery).
   *  Only resets tasks whose runner PID is no longer alive. */
  async recoverOrphans(): Promise<number> {
    return withFileLock(this.filePath, () => {
      const tasks = this.readAll();
      let count = 0;
      for (const t of tasks) {
        if (t.status === 'running') {
          // Check if the runner process is still alive
          if (t.runnerId != null) {
            let alive = false;
            try { process.kill(t.runnerId, 0); alive = true; } catch { /* process gone */ }
            if (alive) continue; // skip — process is still working on this task
          }
          t.status = 'pending';
          t.runnerId = undefined;
          count++;
        }
      }
      if (count > 0) this.writeAll(tasks);
      return count;
    });
  }

  private async updateStatus(id: string, status: QueuedTask['status']): Promise<void> {
    return withFileLock(this.filePath, () => {
      const tasks = this.readAll();
      const task = tasks.find(t => t.id === id);
      if (task) {
        task.status = status;
        this.writeAll(tasks);
      }
    });
  }

  private readAll(): QueuedTask[] {
    if (!fs.existsSync(this.filePath)) return [];
    const content = fs.readFileSync(this.filePath, 'utf-8').trim();
    if (!content) return [];
    const { records } = parseNdjson<QueuedTask>(content, 'task-queue');
    return records;
  }

  /** Atomically claim the next pending task: selects highest-priority and marks it running in one lock. */
  async claimNext(): Promise<QueuedTask | null> {
    return withFileLock(this.filePath, () => {
      const tasks = this.readAll();
      const pending = tasks.filter(t => t.status === 'pending');
      pending.sort((a, b) => b.priority - a.priority || a.addedAt - b.addedAt);
      const chosen = pending[0];
      if (!chosen) return null;
      chosen.status = 'running';
      chosen.runnerId = process.pid;
      this.writeAll(tasks);
      return chosen;
    });
  }

  private writeAll(tasks: QueuedTask[]): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Atomic write: write to temp file then rename to avoid partial reads on crash
    const tmpPath = this.filePath + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, tasks.map(t => JSON.stringify(t)).join('\n') + (tasks.length > 0 ? '\n' : ''), 'utf-8');
    fs.renameSync(tmpPath, this.filePath);
  }
}
