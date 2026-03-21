/**
 * Platform event handler: invalidates project model cache when executions complete.
 * Registered in flowweaver.manifest.json as an event subscription.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export async function onExecutionCompleted(event: {
  deploymentId?: string;
  wsPath?: string;
  status?: string;
  executionTimeMs?: number;
}): Promise<void> {
  const projectDir = event.wsPath;
  if (!projectDir) return;

  // Invalidate project model cache directly (same logic as ProjectModelStore.invalidate)
  try {
    const hash8 = crypto.createHash('sha256').update(projectDir).digest('hex').slice(0, 8);
    const modelPath = path.join(os.homedir(), '.weaver', 'projects', hash8, 'model.json');
    if (fs.existsSync(modelPath)) {
      fs.unlinkSync(modelPath);
    }
  } catch {
    // Non-fatal — cache will be rebuilt on next access
  }
}
