import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { CostRecord, CostSummary } from './types.js';

const MAX_ENTRIES = 10_000;
const CAP_CHECK_INTERVAL = 100;

export class CostStore {
  private readonly dir: string;
  private readonly filePath: string;
  private appendCount = 0;

  constructor(dir?: string) {
    this.dir = dir ?? process.env.WEAVER_DATA_DIR ?? path.join(os.homedir(), '.weaver');
    fs.mkdirSync(this.dir, { recursive: true });
    this.filePath = path.join(this.dir, 'costs.ndjson');
  }

  append(record: CostRecord): void {
    fs.appendFileSync(this.filePath, JSON.stringify(record) + '\n', 'utf-8');
    this.appendCount++;
    if (this.appendCount % CAP_CHECK_INTERVAL === 0) {
      this.enforceCap();
    }
  }

  query(filters?: { since?: number; model?: string }): CostRecord[] {
    if (!fs.existsSync(this.filePath)) return [];

    const content = fs.readFileSync(this.filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    const records: CostRecord[] = [];

    for (const line of lines) {
      try {
        const record = JSON.parse(line) as CostRecord;
        if (filters?.since && record.timestamp < filters.since) continue;
        if (filters?.model && record.model !== filters.model) continue;
        records.push(record);
      } catch {
        // skip corrupt lines
      }
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

  private enforceCap(): void {
    if (!fs.existsSync(this.filePath)) return;

    const content = fs.readFileSync(this.filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);

    if (lines.length <= MAX_ENTRIES) return;

    const kept = lines.slice(lines.length - MAX_ENTRIES);
    const tmpPath = this.filePath + '.tmp';
    fs.writeFileSync(tmpPath, kept.join('\n') + '\n', 'utf-8');
    fs.renameSync(tmpPath, this.filePath);
  }
}
