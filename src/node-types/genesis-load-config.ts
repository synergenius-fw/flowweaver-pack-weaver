import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WeaverEnv, GenesisConfig } from '../bot/types.js';
import { GenesisStore } from '../bot/genesis-store.js';

/**
 * Loads genesis configuration from the project .genesis directory,
 * validates the target workflow exists, and generates a new cycle ID.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Genesis Load Config
 * @input env [order:0] - Weaver environment bundle
 * @output env [order:0] - Weaver environment bundle (pass-through)
 * @output genesisConfigJson [order:1] - Genesis configuration (JSON)
 * @output cycleId [order:2] - New cycle identifier
 */
export function genesisLoadConfig(env: WeaverEnv): {
  env: WeaverEnv;
  genesisConfigJson: string;
  cycleId: string;
} {
  const store = new GenesisStore(env.projectDir);
  const config = store.loadConfig();

  if (!config.targetWorkflow) {
    throw new Error('Genesis config has no targetWorkflow set. Run "weaver genesis --init" and set it in .genesis/config.json');
  }

  const targetPath = path.resolve(env.projectDir, config.targetWorkflow);
  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
    throw new Error(`Target workflow not found: ${targetPath}`);
  }

  const cycleId = GenesisStore.newCycleId();
  console.log(`\x1b[36m→ Genesis config loaded, cycle ${cycleId}\x1b[0m`);

  return {
    env,
    genesisConfigJson: JSON.stringify(config),
    cycleId,
  };
}
