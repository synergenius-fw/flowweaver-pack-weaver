import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GenesisContext } from '../bot/types.js';
import { GenesisStore } from '../bot/genesis-store.js';
import { withFileLock } from '../bot/file-lock.js';

/**
 * Copies staged files to their actual pack locations, completing the
 * self-modification migration. Uses a file lock to prevent concurrent access.
 *
 * @flowWeaver nodeType
 * @label Genesis Escrow Migrate
 * @input ctx [order:0] - Genesis context (JSON)
 * @output ctx [order:0] - Genesis context with migration result (JSON)
 * @output onSuccess [order:-2] - On Success
 * @output onFailure [order:-1] [hidden] - On Failure
 */
export async function genesisEscrowMigrate(
  execute: boolean,
  ctx: string,
): Promise<{
  onSuccess: boolean; onFailure: boolean;
  ctx: string;
}> {
  const context = JSON.parse(ctx) as GenesisContext;
  const { env } = context;
  const store = new GenesisStore(env.projectDir);
  const token = store.loadEscrowToken();

  if (!execute) {
    context.escrowResultJson = JSON.stringify({ migrated: false, reason: 'dry run' });
    return { onSuccess: true, onFailure: false, ctx: JSON.stringify(context) };
  }

  if (!token || token.phase !== 'validated') {
    context.error = 'No validated escrow token found';
    return { onSuccess: false, onFailure: true, ctx: JSON.stringify(context) };
  }

  const packRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const lockPath = path.join(env.projectDir, '.genesis', 'escrow', 'migrate');

  try {
    await withFileLock(lockPath, () => {
      // Re-read token inside lock to confirm state
      const lockedToken = store.loadEscrowToken();
      if (!lockedToken || lockedToken.phase !== 'validated') {
        throw new Error('Token state changed during lock acquisition');
      }

      lockedToken.phase = 'migrating';
      store.saveEscrowToken(lockedToken);

      // Copy each staged file to actual location
      for (const relFile of lockedToken.affectedFiles) {
        const stagedPath = store.getEscrowStagedPath(relFile);
        const destPath = path.resolve(packRoot, relFile);

        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(stagedPath, destPath);
      }

      lockedToken.phase = 'migrated';
      lockedToken.migratedAt = new Date().toISOString();
      store.saveEscrowToken(lockedToken);
    });

    console.log(`\x1b[32m→ Escrow migration complete: ${token.affectedFiles.length} file(s) swapped\x1b[0m`);
    context.escrowResultJson = JSON.stringify({
      migrated: true,
      migrationId: token.migrationId,
      files: token.affectedFiles,
    });
    return { onSuccess: true, onFailure: false, ctx: JSON.stringify(context) };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m→ Escrow migration failed: ${msg}\x1b[0m`);

    // Attempt rollback
    rollbackFromBackup(store, token, packRoot, `Migration failed: ${msg}`);

    context.error = `Escrow migration failed: ${msg}`;
    return { onSuccess: false, onFailure: true, ctx: JSON.stringify(context) };
  }
}

/** Restore all affected files from backup. */
export function rollbackFromBackup(
  store: GenesisStore,
  token: { migrationId: string; cycleId: string; affectedFiles: string[]; backupFileHashes: Record<string, string> },
  packRoot: string,
  reason: string,
): void {
  for (const relFile of token.affectedFiles) {
    const backupPath = store.getEscrowBackupPath(relFile);
    const destPath = path.resolve(packRoot, relFile);

    if (fs.existsSync(backupPath)) {
      // Verify backup integrity
      const actualHash = GenesisStore.hashFile(backupPath);
      const expectedHash = token.backupFileHashes[relFile];
      if (expectedHash && actualHash !== expectedHash) {
        console.error(`\x1b[31m→ Backup integrity check failed for ${relFile}\x1b[0m`);
        continue;
      }
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(backupPath, destPath);
    }
  }

  // Update token
  const fullToken = store.loadEscrowToken();
  if (fullToken) {
    fullToken.phase = 'rolled-back';
    fullToken.rollbackReason = reason;
    store.saveEscrowToken(fullToken);
  }

  store.appendSelfMigration({
    migrationId: token.migrationId,
    cycleId: token.cycleId,
    timestamp: new Date().toISOString(),
    affectedFiles: token.affectedFiles,
    outcome: 'rolled-back',
    graceCompleted: false,
    rollbackReason: reason,
  });

  console.log(`\x1b[33m→ Rolled back migration ${token.migrationId}: ${reason}\x1b[0m`);
}
