import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { GenesisConfig, GenesisHistory, GenesisCycleRecord, GenesisFingerprint } from './types.js';

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
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
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
    return JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
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
    try {
      return JSON.parse(fs.readFileSync(fpPath, 'utf-8'));
    } catch {
      return null;
    }
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
}
