import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AuditEvent } from './types.js';
import { parseNdjson } from './safe-json.js';

export class AuditStore {
  private readonly dir: string;
  private readonly filePath: string;

  constructor(storeDir?: string) {
    this.dir = storeDir ?? process.env.WEAVER_HISTORY_DIR ?? path.join(os.homedir(), '.weaver');
    fs.mkdirSync(this.dir, { recursive: true });
    this.filePath = path.join(this.dir, 'audit.ndjson');
  }

  emit(event: AuditEvent): void {
    fs.appendFileSync(this.filePath, JSON.stringify(event) + '\n', 'utf-8');
  }

  queryByRun(runId: string): AuditEvent[] {
    return this.readAll().filter((e) => e.runId === runId);
  }

  queryRecent(limit = 50): AuditEvent[] {
    const all = this.readAll();
    return all.slice(-limit);
  }

  prune(maxAgeDays: number): number {
    const all = this.readAll();
    if (all.length === 0) return 0;

    const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
    const kept = all.filter((e) => e.timestamp >= cutoff);
    const pruned = all.length - kept.length;

    if (pruned === 0) return 0;

    const tmpPath = this.filePath + '.tmp';
    fs.writeFileSync(tmpPath, kept.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
    fs.renameSync(tmpPath, this.filePath);

    return pruned;
  }

  clear(): boolean {
    if (!fs.existsSync(this.filePath)) return false;
    fs.unlinkSync(this.filePath);
    return true;
  }

  private readAll(): AuditEvent[] {
    if (!fs.existsSync(this.filePath)) return [];

    const content = fs.readFileSync(this.filePath, 'utf-8');
    const { records } = parseNdjson<AuditEvent>(content, 'audit');
    return records;
  }
}
