import type { WeaverEnv, GenesisConfig } from '../bot/types.js';
import { GenesisStore } from '../bot/genesis-store.js';

/**
 * Determines whether genesis should enter stabilize mode. This happens
 * when the config flag is set or when the last 3 cycles were all
 * rollbacks or rejections.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Genesis Check Stabilize
 * @input env [order:0] - Weaver environment bundle
 * @input genesisConfigJson [order:1] - Genesis configuration (JSON)
 * @output env [order:0] - Weaver environment bundle (pass-through)
 * @output genesisConfigJson [order:1] - Genesis configuration (pass-through)
 * @output stabilized [order:2] - Whether stabilize mode is active
 */
export function genesisCheckStabilize(
  env: WeaverEnv,
  genesisConfigJson: string,
): {
  env: WeaverEnv;
  genesisConfigJson: string;
  stabilized: boolean;
} {
  const config = JSON.parse(genesisConfigJson) as GenesisConfig;

  if (config.stabilize) {
    console.log('\x1b[33m→ Stabilize mode: enabled by config\x1b[0m');
    return { env, genesisConfigJson, stabilized: true };
  }

  const store = new GenesisStore(env.projectDir);
  const recent = store.getRecentOutcomes(3);

  if (recent.length >= 3 && recent.every(o => o === 'rolled-back' || o === 'rejected')) {
    console.log('\x1b[33m→ Stabilize mode: 3+ consecutive rollbacks/rejections\x1b[0m');
    return { env, genesisConfigJson, stabilized: true };
  }

  return { env, genesisConfigJson, stabilized: false };
}
