import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WeaverEnv, GenesisConfig } from '../bot/types.js';
import { GenesisStore } from '../bot/genesis-store.js';

/**
 * Saves a snapshot of the target workflow file before any modifications
 * are applied, enabling rollback if something goes wrong.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Genesis Snapshot
 * @input env [order:0] - Weaver environment bundle
 * @input genesisConfigJson [order:1] - Genesis configuration (JSON)
 * @input cycleId [order:2] - Cycle identifier
 * @output env [order:0] - Weaver environment bundle (pass-through)
 * @output genesisConfigJson [order:1] - Genesis configuration (pass-through)
 * @output cycleId [order:2] - Cycle identifier (pass-through)
 * @output snapshotPath [order:3] - Path to the saved snapshot file
 */
export function genesisSnapshot(
  env: WeaverEnv,
  genesisConfigJson: string,
  cycleId: string,
): {
  env: WeaverEnv;
  genesisConfigJson: string;
  cycleId: string;
  snapshotPath: string;
} {
  const config = JSON.parse(genesisConfigJson) as GenesisConfig;
  const targetPath = path.resolve(env.projectDir, config.targetWorkflow);
  const content = fs.readFileSync(targetPath, 'utf-8');

  const store = new GenesisStore(env.projectDir);
  const snapshotPath = store.saveSnapshot(cycleId, content);

  console.log(`\x1b[36m→ Snapshot saved: ${snapshotPath}\x1b[0m`);

  return { env, genesisConfigJson, cycleId, snapshotPath };
}
