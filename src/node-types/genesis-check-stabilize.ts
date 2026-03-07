import type { GenesisConfig, GenesisContext } from '../bot/types.js';
import { GenesisStore } from '../bot/genesis-store.js';

/**
 * Determines whether genesis should enter stabilize mode. This happens
 * when the config flag is set or when the last 3 cycles were all
 * rollbacks or rejections.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Genesis Check Stabilize
 * @input ctx [order:0] - Genesis context (JSON)
 * @output ctx [order:0] - Genesis context with stabilized (JSON)
 * @output onFailure [hidden]
 */
export function genesisCheckStabilize(ctx: string): { ctx: string } {
  const context = JSON.parse(ctx) as GenesisContext;
  const config = JSON.parse(context.genesisConfigJson) as GenesisConfig;

  if (config.stabilize) {
    console.log('\x1b[33m→ Stabilize mode: enabled by config\x1b[0m');
    context.stabilized = true;
    return { ctx: JSON.stringify(context) };
  }

  const store = new GenesisStore(context.env.projectDir);
  const recent = store.getRecentOutcomes(3);

  if (recent.length >= 3 && recent.every(o => o === 'rolled-back' || o === 'rejected')) {
    console.log('\x1b[33m→ Stabilize mode: 3+ consecutive rollbacks/rejections\x1b[0m');
    context.stabilized = true;
    return { ctx: JSON.stringify(context) };
  }

  context.stabilized = false;
  return { ctx: JSON.stringify(context) };
}
