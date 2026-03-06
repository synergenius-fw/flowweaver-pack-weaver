import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface SteeringCommand {
  command: 'pause' | 'resume' | 'cancel' | 'redirect' | 'queue';
  payload?: string;
  timestamp: number;
}

export class SteeringController {
  private controlPath: string;

  constructor(controlDir?: string) {
    const dir = controlDir ?? path.join(os.homedir(), '.weaver');
    this.controlPath = path.join(dir, 'control.json');
  }

  check(): SteeringCommand | null {
    try {
      if (!fs.existsSync(this.controlPath)) return null;
      const raw = fs.readFileSync(this.controlPath, 'utf-8');
      fs.unlinkSync(this.controlPath);
      return JSON.parse(raw) as SteeringCommand;
    } catch {
      return null;
    }
  }

  write(command: SteeringCommand): void {
    const dir = path.dirname(this.controlPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.controlPath, JSON.stringify(command, null, 2), 'utf-8');
  }

  clear(): void {
    try { fs.unlinkSync(this.controlPath); } catch { /* ignore */ }
  }
}
