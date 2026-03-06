import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

export interface QueuedTask {
  id: string;
  instruction: string;
  mode?: 'create' | 'modify' | 'read' | 'batch';
  targets?: string[];
  options?: Record<string, unknown>;
  priority: number;
  addedAt: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
}

export class TaskQueue {
  private filePath: string;

  constructor(dir?: string) {
    const base = dir ?? path.join(os.homedir(), '.weaver');
    this.filePath = path.join(base, 'task-queue.ndjson');
  }

  add(task: Omit<QueuedTask, 'id' | 'addedAt' | 'status'>): string {
    const entry: QueuedTask = {
      ...task,
      id: crypto.randomUUID().slice(0, 8),
      addedAt: Date.now(),
      status: 'pending',
    };
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf-8');
    return entry.id;
  }

  next(): QueuedTask | null {
    const tasks = this.readAll().filter(t => t.status === 'pending');
    tasks.sort((a, b) => b.priority - a.priority || a.addedAt - b.addedAt);
    return tasks[0] ?? null;
  }

  list(): QueuedTask[] {
    return this.readAll();
  }

  remove(id: string): boolean {
    const tasks = this.readAll();
    const filtered = tasks.filter(t => t.id !== id);
    if (filtered.length === tasks.length) return false;
    this.writeAll(filtered);
    return true;
  }

  clear(): number {
    const tasks = this.readAll();
    if (tasks.length === 0) return 0;
    try { fs.unlinkSync(this.filePath); } catch { /* ignore */ }
    return tasks.length;
  }

  markRunning(id: string): void {
    this.updateStatus(id, 'running');
  }

  markComplete(id: string): void {
    this.updateStatus(id, 'completed');
  }

  markFailed(id: string): void {
    this.updateStatus(id, 'failed');
  }

  private updateStatus(id: string, status: QueuedTask['status']): void {
    const tasks = this.readAll();
    const task = tasks.find(t => t.id === id);
    if (task) {
      task.status = status;
      this.writeAll(tasks);
    }
  }

  private readAll(): QueuedTask[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const content = fs.readFileSync(this.filePath, 'utf-8').trim();
      if (!content) return [];
      return content.split('\n').map(line => JSON.parse(line) as QueuedTask);
    } catch {
      return [];
    }
  }

  private writeAll(tasks: QueuedTask[]): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, tasks.map(t => JSON.stringify(t)).join('\n') + (tasks.length > 0 ? '\n' : ''), 'utf-8');
  }
}
