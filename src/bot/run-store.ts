import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import type { RunRecord, RunFilter, RetentionPolicy } from './types.js';

export class RunStore {
  private readonly dir: string;
  private readonly filePath: string;

  constructor(storeDir?: string) {
    this.dir = storeDir ?? process.env.WEAVER_HISTORY_DIR ?? path.join(os.homedir(), '.weaver');
    fs.mkdirSync(this.dir, { recursive: true });
    this.filePath = path.join(this.dir, 'history.ndjson');
  }

  static newId(): string {
    return crypto.randomUUID();
  }

  append(record: RunRecord): void {
    fs.appendFileSync(this.filePath, JSON.stringify(record) + '\n', 'utf-8');
  }

  list(filter?: RunFilter): RunRecord[] {
    const all = this.readAll();
    let filtered = all;

    if (filter?.workflowFile) {
      const wf = filter.workflowFile;
      filtered = filtered.filter((r) => r.workflowFile === wf);
    }
    if (filter?.outcome) {
      const out = filter.outcome;
      filtered = filtered.filter((r) => r.outcome === out);
    }
    if (filter?.success !== undefined) {
      const s = filter.success;
      filtered = filtered.filter((r) => r.success === s);
    }
    if (filter?.since) {
      const since = filter.since;
      filtered = filtered.filter((r) => r.startedAt >= since);
    }
    if (filter?.before) {
      const before = filter.before;
      filtered = filtered.filter((r) => r.startedAt <= before);
    }

    filtered.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    const limit = filter?.limit ?? 50;
    return filtered.slice(0, limit);
  }

  get(idOrPrefix: string): RunRecord | null {
    if (idOrPrefix.length < 4) {
      throw new Error('ID prefix must be at least 4 characters');
    }

    const all = this.readAll();
    const matches = all.filter((r) => r.id.startsWith(idOrPrefix));

    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0]!;

    throw new Error(
      `Ambiguous ID prefix "${idOrPrefix}" matches ${matches.length} runs: ` +
        matches.map((r) => r.id).join(', '),
    );
  }

  prune(policy: RetentionPolicy): number {
    const all = this.readAll();
    if (all.length === 0) return 0;

    all.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    let kept = [...all];

    if (policy.maxAgeDays !== undefined) {
      const cutoff = new Date(Date.now() - policy.maxAgeDays * 86_400_000).toISOString();
      kept = kept.filter((r) => r.startedAt >= cutoff);
    }

    if (policy.maxRecords !== undefined) {
      kept = kept.slice(0, policy.maxRecords);
    }

    const pruned = all.length - kept.length;
    if (pruned === 0) return 0;

    // Rewrite atomically: oldest first in file
    kept.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const tmpPath = this.filePath + '.tmp';
    fs.writeFileSync(tmpPath, kept.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    fs.renameSync(tmpPath, this.filePath);

    return pruned;
  }

  clear(): boolean {
    if (!fs.existsSync(this.filePath)) return false;
    fs.unlinkSync(this.filePath);
    return true;
  }

  private readAll(): RunRecord[] {
    if (!fs.existsSync(this.filePath)) return [];

    const content = fs.readFileSync(this.filePath, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim().length > 0);
    const records: RunRecord[] = [];

    for (const line of lines) {
      try {
        records.push(JSON.parse(line) as RunRecord);
      } catch {
        console.error('[weaver] Skipping corrupt history line');
      }
    }

    return records;
  }
}
