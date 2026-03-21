import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

export interface KnowledgeEntry {
  key: string;
  value: string;
  source: string;
  createdAt: number;
}

export class KnowledgeStore {
  private filePath: string;

  constructor(projectDir?: string) {
    const dir = projectDir
      ? path.join(os.homedir(), '.weaver', 'projects', crypto.createHash('sha256').update(projectDir).digest('hex').slice(0, 8))
      : path.join(os.homedir(), '.weaver');
    this.filePath = path.join(dir, 'knowledge.ndjson');
  }

  learn(key: string, value: string, source: string): void {
    // Append entry to NDJSON file. If key exists, update it.
    const entries = this.readAll().filter(e => e.key !== key);
    entries.push({ key, value, source, createdAt: Date.now() });
    this.writeAll(entries);
  }

  recall(query: string): KnowledgeEntry[] {
    // Fuzzy match: return entries whose key contains the query (case-insensitive)
    const lower = query.toLowerCase();
    return this.readAll().filter(e => e.key.toLowerCase().includes(lower) || e.value.toLowerCase().includes(lower));
  }

  forget(key: string): void {
    const entries = this.readAll().filter(e => e.key !== key);
    this.writeAll(entries);
  }

  list(): KnowledgeEntry[] {
    return this.readAll();
  }

  private readAll(): KnowledgeEntry[] {
    if (!fs.existsSync(this.filePath)) return [];
    const content = fs.readFileSync(this.filePath, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean) as KnowledgeEntry[];
  }

  private writeAll(entries: KnowledgeEntry[]): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : ''));
  }
}
