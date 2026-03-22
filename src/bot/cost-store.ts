import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { CostRecord, CostSummary } from './types.js';
import { parseNdjson } from './safe-json.js';
import { withFileLock } from './file-lock.js';

const MAX_ENTRIES = 10_000;
const CAP_CHECK_INTERVAL = 100;

export class CostStore {
  private readonly dir: string;
  private readonly filePath: string;
  private appendCount = 0;
  private pendingCap: Promise<void> | null = null;

  constructor(dir?: string) {
    this.dir = dir ?? process.env.WEAVER_DATA_DIR ?? path.join(os.homedir(), '.weaver');
    fs.mkdirSync(this.dir, { recursive: true });
    this.filePath = path.join(this.dir, 'costs.ndjson');
  }

  append(record: CostRecord): void {
    fs.appendFileSync(this.filePath, JSON.stringify(record) + '\n', 'utf-8');
    this.appendCount++;
    if (this.appendCount % CAP_CHECK_INTERVAL === 0) {
      this.pendingCap = this.enforceCap().catch(() => {}).finally(() => { this.pendingCap = null; });
    }
  }

  /** Wait for any in-flight cap enforcement to finish (used in tests). */
  async waitForPendingCap(): Promise<void> {
    if (this.pendingCap) await this.pendingCap;
  }

  query(filters?: { since?: number; model?: string }): CostRecord[] {
    if (!fs.existsSync(this.filePath)) return [];

    const content = fs.readFileSync(this.filePath, 'utf-8');
    const { records: all } = parseNdjson<CostRecord>(content, 'costs');

    let records = all;
    if (filters?.since) {
      const since = filters.since;
      records = records.filter((r) => r.timestamp >= since);
    }
    if (filters?.model) {
      const model = filters.model;
      records = records.filter((r) => r.model === model);
    }

    return records;
  }

  summarize(filters?: { since?: number; model?: string }): CostSummary {
    const records = this.query(filters);

    const summary: CostSummary = {
      totalCost: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalRuns: records.length,
      byModel: {},
    };

    for (const r of records) {
      summary.totalCost += r.estimatedCost;
      summary.totalInputTokens += r.inputTokens;
      summary.totalOutputTokens += r.outputTokens;

      const model = r.model || 'unknown';
      if (!summary.byModel[model]) {
        summary.byModel[model] = { runs: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
      }
      const m = summary.byModel[model]!;
      m.runs++;
      m.inputTokens += r.inputTokens;
      m.outputTokens += r.outputTokens;
      m.cost += r.estimatedCost;
    }

    return summary;
  }

  private async enforceCap(): Promise<void> {
    if (!fs.existsSync(this.filePath)) return;

    await withFileLock(this.filePath, () => {
      if (!fs.existsSync(this.filePath)) return;

      const content = fs.readFileSync(this.filePath, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);

      if (lines.length <= MAX_ENTRIES) return;

      const kept = lines.slice(lines.length - MAX_ENTRIES);
      const tmpPath = this.filePath + '.tmp';
      fs.writeFileSync(tmpPath, kept.join('\n') + '\n', 'utf-8');
      fs.renameSync(tmpPath, this.filePath);
    });
  }
}
