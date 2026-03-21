import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { withFileLock } from './file-lock.js';

export interface SteeringCommand {
  command: 'pause' | 'resume' | 'cancel' | 'redirect' | 'queue';
  payload?: string;
  timestamp: number;
}

export class SteeringController {
  private controlPath: string;

  constructor(controlDir?: string) {
    const dir = controlDir ?? process.env.WEAVER_STEERING_DIR ?? path.join(os.homedir(), '.weaver');
    this.controlPath = path.join(dir, 'control.json');
  }

  async check(): Promise<SteeringCommand | null> {
    return withFileLock(this.controlPath, () => {
      try {
        if (!fs.existsSync(this.controlPath)) return null;
        const raw = fs.readFileSync(this.controlPath, 'utf-8');
        fs.unlinkSync(this.controlPath);
        return JSON.parse(raw) as SteeringCommand;
      } catch {
        return null;
      }
    });
  }

  async write(command: SteeringCommand): Promise<void> {
    return withFileLock(this.controlPath, () => {
      const dir = path.dirname(this.controlPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.controlPath, JSON.stringify(command, null, 2), 'utf-8');
    });
  }

  clear(): void {
    try { fs.unlinkSync(this.controlPath); } catch { /* ignore */ }
  }
}
