import * as fs from 'node:fs';
import * as path from 'node:path';
import { withFileLock } from './file-lock.js';
import { resolveWeaverDir } from './paths.js';

export interface SteeringCommand {
  command: 'pause' | 'resume' | 'cancel' | 'redirect' | 'queue';
  payload?: string;
  timestamp: number;
}

export class SteeringController {
  private controlPath: string;

  constructor(controlDir?: string) {
    const dir = controlDir ?? resolveWeaverDir();
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
