import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { GenesisConfig, GenesisHistory, GenesisCycleRecord, GenesisFingerprint, EscrowToken, GenesisSelfMigrationRecord } from './types.js';
import { jsonParseOr } from './safe-json.js';

const DEFAULT_CONFIG: GenesisConfig = {
  intent: 'Improve workflow reliability and efficiency',
  focus: [],
  constraints: [],
  approvalThreshold: 'MINOR',
  budgetPerCycle: 3,
  stabilize: false,
  targetWorkflow: '',
  maxCyclesPerRun: 10,
};

export class GenesisStore {
  private genesisDir: string;

  constructor(projectDir: string) {
    this.genesisDir = path.join(projectDir, '.genesis');
  }

  ensureDirs(): void {
    fs.mkdirSync(path.join(this.genesisDir, 'snapshots'), { recursive: true });
  }

  loadConfig(): GenesisConfig {
    const configPath = path.join(this.genesisDir, 'config.json');
    if (!fs.existsSync(configPath)) {
      this.ensureDirs();
      fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
      return { ...DEFAULT_CONFIG };
    }
    const content = fs.readFileSync(configPath, 'utf-8');
    const raw = jsonParseOr(content, {} as Record<string, unknown>, 'genesis config');
    return { ...DEFAULT_CONFIG, ...raw };
  }

  saveConfig(config: GenesisConfig): void {
    this.ensureDirs();
    fs.writeFileSync(path.join(this.genesisDir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
  }

  loadHistory(): GenesisHistory {
    const historyPath = path.join(this.genesisDir, 'history.json');
    if (!fs.existsSync(historyPath)) {
      return { configHash: '', cycles: [] };
    }
    const content = fs.readFileSync(historyPath, 'utf-8');
    return jsonParseOr<GenesisHistory>(content, { configHash: '', cycles: [] }, 'genesis history');
  }

  appendCycle(cycle: GenesisCycleRecord): void {
    const history = this.loadHistory();
    history.cycles.push(cycle);
    this.ensureDirs();
    fs.writeFileSync(path.join(this.genesisDir, 'history.json'), JSON.stringify(history, null, 2), 'utf-8');
  }

  saveSnapshot(cycleId: string, content: string): string {
    this.ensureDirs();
    const snapshotPath = path.join(this.genesisDir, 'snapshots', `${cycleId}.ts`);
    fs.writeFileSync(snapshotPath, content, 'utf-8');
    return snapshotPath;
  }

  loadSnapshot(snapshotPath: string): string | null {
    try {
      return fs.readFileSync(snapshotPath, 'utf-8');
    } catch {
      return null;
    }
  }

  saveFingerprint(fingerprint: GenesisFingerprint): void {
    this.ensureDirs();
    fs.writeFileSync(path.join(this.genesisDir, 'fingerprint.json'), JSON.stringify(fingerprint, null, 2), 'utf-8');
  }

  getLastFingerprint(): GenesisFingerprint | null {
    const fpPath = path.join(this.genesisDir, 'fingerprint.json');
    if (!fs.existsSync(fpPath)) return null;
    const content = fs.readFileSync(fpPath, 'utf-8');
    return jsonParseOr<GenesisFingerprint | null>(content, null, 'genesis fingerprint');
  }

  getRecentOutcomes(count: number): string[] {
    const history = this.loadHistory();
    return history.cycles.slice(-count).map(c => c.outcome);
  }

  static newCycleId(): string {
    return crypto.randomUUID().slice(0, 8);
  }

  static hashConfig(config: GenesisConfig): string {
    return crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 12);
  }

  // --- Escrow ---

  ensureEscrowDirs(): void {
    fs.mkdirSync(path.join(this.genesisDir, 'escrow', 'staged'), { recursive: true });
    fs.mkdirSync(path.join(this.genesisDir, 'escrow', 'backup'), { recursive: true });
  }

  loadEscrowToken(): EscrowToken | null {
    const tokenPath = path.join(this.genesisDir, 'escrow', 'token.json');
    if (!fs.existsSync(tokenPath)) return null;
    const content = fs.readFileSync(tokenPath, 'utf-8');
    return jsonParseOr<EscrowToken | null>(content, null, 'escrow token');
  }

  saveEscrowToken(token: EscrowToken): void {
    this.ensureEscrowDirs();
    fs.writeFileSync(
      path.join(this.genesisDir, 'escrow', 'token.json'),
      JSON.stringify(token, null, 2),
      'utf-8',
    );
  }

  clearEscrow(): void {
    const escrowDir = path.join(this.genesisDir, 'escrow');
    if (fs.existsSync(escrowDir)) {
      fs.rmSync(escrowDir, { recursive: true, force: true });
    }
  }

  getEscrowStagedPath(relativePath: string): string {
    return path.join(this.genesisDir, 'escrow', 'staged', relativePath);
  }

  getEscrowBackupPath(relativePath: string): string {
    return path.join(this.genesisDir, 'escrow', 'backup', relativePath);
  }

  // --- Self-evolution history ---

  loadSelfHistory(): GenesisSelfMigrationRecord[] {
    const histPath = path.join(this.genesisDir, 'self-history.json');
    if (!fs.existsSync(histPath)) return [];
    const content = fs.readFileSync(histPath, 'utf-8');
    return jsonParseOr<GenesisSelfMigrationRecord[]>(content, [], 'genesis self-history');
  }

  appendSelfMigration(record: GenesisSelfMigrationRecord): void {
    const records = this.loadSelfHistory();
    records.push(record);
    this.ensureDirs();
    fs.writeFileSync(
      path.join(this.genesisDir, 'self-history.json'),
      JSON.stringify(records, null, 2),
      'utf-8',
    );
  }

  getSelfFailureCount(): number {
    const records = this.loadSelfHistory();
    let count = 0;
    for (let i = records.length - 1; i >= 0; i--) {
      if (records[i]!.outcome === 'rolled-back') count++;
      else break;
    }
    return count;
  }

  static hashFile(filePath: string): string {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  }
}
