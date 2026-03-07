import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GenesisContext, GenesisConfig } from '../bot/types.js';
import { GenesisStore } from '../bot/genesis-store.js';
import { rollbackFromBackup } from './genesis-escrow-migrate.js';

/**
 * Checks for interrupted escrow migrations (crash recovery) and sets
 * grace-period context flags for downstream nodes. Runs early in the
 * workflow so propose and other nodes can see the escrow state.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Genesis Escrow Recover
 * @input ctx [order:0] - Genesis context (JSON)
 * @output ctx [order:0] - Genesis context with escrow state flags (JSON)
 */
export function genesisEscrowRecover(ctx: string): { ctx: string } {
  const context = JSON.parse(ctx) as GenesisContext;
  const { env } = context;
  const config = JSON.parse(context.genesisConfigJson) as GenesisConfig;

  if (!config.selfEvolve) {
    context.escrowGraceLocked = false;
    return { ctx: JSON.stringify(context) };
  }

  const store = new GenesisStore(env.projectDir);
  const token = store.loadEscrowToken();

  if (!token) {
    context.escrowGraceLocked = false;
    return { ctx: JSON.stringify(context) };
  }

  const packRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

  // Crash recovery: process died mid-swap
  if (token.phase === 'migrating') {
    console.log('\x1b[33m→ Detected interrupted migration, checking file integrity...\x1b[0m');

    let needsRollback = false;
    for (const relFile of token.affectedFiles) {
      const absFile = path.resolve(packRoot, relFile);
      if (!fs.existsSync(absFile)) {
        needsRollback = true;
        break;
      }
      const currentHash = GenesisStore.hashFile(absFile);
      const stagedHash = token.stagedFileHashes[relFile];
      const backupHash = token.backupFileHashes[relFile];
      if (currentHash !== stagedHash && currentHash !== backupHash) {
        needsRollback = true;
        break;
      }
    }

    if (needsRollback) {
      console.log('\x1b[33m→ Inconsistent state, rolling back...\x1b[0m');
      rollbackFromBackup(store, token, packRoot, 'Crash recovery: inconsistent file state');
    } else {
      // Check if all files match staged (migration was actually complete)
      const allStaged = token.affectedFiles.every(f => {
        const absFile = path.resolve(packRoot, f);
        return fs.existsSync(absFile) && GenesisStore.hashFile(absFile) === token.stagedFileHashes[f];
      });
      if (allStaged) {
        token.phase = 'migrated';
        token.migratedAt = new Date().toISOString();
        store.saveEscrowToken(token);
        console.log('\x1b[32m→ Migration was complete, advancing to grace period\x1b[0m');
      } else {
        rollbackFromBackup(store, token, packRoot, 'Crash recovery: partial migration');
      }
    }
  }

  // Set grace state for downstream nodes
  const current = store.loadEscrowToken();
  if (current && current.phase === 'migrated' && current.graceRemaining > 0) {
    context.escrowGraceLocked = true;
    context.escrowGraceRemaining = current.graceRemaining;
  } else {
    context.escrowGraceLocked = false;
  }

  return { ctx: JSON.stringify(context) };
}
