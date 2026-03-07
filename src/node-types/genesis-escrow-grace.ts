import * as path from 'node:path';
import type { GenesisContext, GenesisConfig } from '../bot/types.js';
import { GenesisStore } from '../bot/genesis-store.js';
import { rollbackFromBackup } from './genesis-escrow-migrate.js';

/**
 * Handles escrow grace period tracking at the end of each cycle.
 * Decrements grace on success, triggers rollback on failure, and
 * clears escrow once the grace period completes.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Genesis Escrow Grace
 * @input ctx [order:0] - Genesis context (JSON)
 * @output ctx [order:0] - Genesis context (JSON)
 */
export function genesisEscrowGrace(ctx: string): { ctx: string } {
  const context = JSON.parse(ctx) as GenesisContext;
  const { env } = context;
  const config = JSON.parse(context.genesisConfigJson) as GenesisConfig;

  if (!config.selfEvolve) {
    return { ctx: JSON.stringify(context) };
  }

  const store = new GenesisStore(env.projectDir);
  const token = store.loadEscrowToken();

  if (!token || token.phase !== 'migrated' || token.graceRemaining <= 0) {
    return { ctx: JSON.stringify(context) };
  }

  const packRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

  // Cycle failed during grace: rollback
  if (context.error) {
    rollbackFromBackup(store, token, packRoot, `Grace cycle failed: ${context.error}`);
    return { ctx: JSON.stringify(context) };
  }

  // Cycle succeeded: decrement grace
  token.graceRemaining--;
  token.graceCycleIds.push(context.cycleId);
  store.saveEscrowToken(token);

  console.log(`\x1b[36m→ Grace period: ${token.graceRemaining} cycle(s) remaining\x1b[0m`);

  if (token.graceRemaining <= 0) {
    store.appendSelfMigration({
      migrationId: token.migrationId,
      cycleId: token.cycleId,
      timestamp: new Date().toISOString(),
      affectedFiles: token.affectedFiles,
      outcome: 'grace-cleared',
      graceCompleted: true,
    });
    store.clearEscrow();
    console.log('\x1b[32m→ Grace period complete, self-modification accepted\x1b[0m');
  }

  return { ctx: JSON.stringify(context) };
}
