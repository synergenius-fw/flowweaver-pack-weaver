import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { GenesisContext, GenesisConfig, GenesisProposal, GenesisOperation, EscrowToken } from '../bot/types.js';
import { GenesisStore } from '../bot/genesis-store.js';

/**
 * Separates self-modify operations from the proposal, copies current files
 * to backup, writes new content to staged, and creates the escrow token.
 *
 * @flowWeaver nodeType
 * @label Genesis Escrow Stage
 * @input ctx [order:0] - Genesis context (JSON)
 * @output ctx [order:0] - Genesis context with escrow staging result (JSON)
 * @output onSuccess [order:-2] - On Success
 * @output onFailure [order:-1] [hidden] - On Failure
 */
export function genesisEscrowStage(ctx: string): {
  onSuccess: boolean; onFailure: boolean;
  ctx: string;
} {
  const context = JSON.parse(ctx) as GenesisContext;
  const { env } = context;
  const config = JSON.parse(context.genesisConfigJson) as GenesisConfig;
  const proposal = JSON.parse(context.proposalJson!) as GenesisProposal;

  const selfModifyTypes = new Set(['selfModifyWorkflow', 'selfModifyNodeType', 'selfModifyModule']);
  const selfOps = proposal.operations.filter(op => selfModifyTypes.has(op.type));

  if (selfOps.length === 0) {
    context.hasSelfModifyOps = false;
    return { onSuccess: true, onFailure: false, ctx: JSON.stringify(context) };
  }

  // Resolve the pack root (parent of src/)
  const packRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

  const store = new GenesisStore(env.projectDir);
  store.ensureEscrowDirs();

  const affectedFiles: string[] = [];
  const stagedHashes: Record<string, string> = {};
  const backupHashes: Record<string, string> = {};

  try {
    for (const op of selfOps) {
      const relFile = op.args.file!;

      // Path traversal protection
      const normalized = path.normalize(relFile);
      if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
        console.error(`\x1b[31m→ Rejected unsafe file path: ${relFile}\x1b[0m`);
        continue;
      }

      const absFile = path.resolve(packRoot, relFile);
      affectedFiles.push(relFile);

      // Backup current file
      if (fs.existsSync(absFile)) {
        const backupDest = store.getEscrowBackupPath(relFile);
        fs.mkdirSync(path.dirname(backupDest), { recursive: true });
        fs.copyFileSync(absFile, backupDest);
        backupHashes[relFile] = GenesisStore.hashFile(absFile);
      }

      // Write staged content then hash the file (consistent with GenesisStore.hashFile)
      const stagedDest = store.getEscrowStagedPath(relFile);
      fs.mkdirSync(path.dirname(stagedDest), { recursive: true });
      fs.writeFileSync(stagedDest, op.args.content!, 'utf-8');
      stagedHashes[relFile] = GenesisStore.hashFile(stagedDest);
    }

    const gracePeriod = config.selfEvolveGracePeriod ?? 3;

    const token: EscrowToken = {
      migrationId: crypto.randomUUID().slice(0, 12),
      cycleId: context.cycleId,
      stagedAt: new Date().toISOString(),
      phase: 'staged',
      affectedFiles,
      stagedFileHashes: stagedHashes,
      backupFileHashes: backupHashes,
      ownerPid: process.pid,
      graceRemaining: gracePeriod,
      graceCycleIds: [],
    };

    store.saveEscrowToken(token);

    context.hasSelfModifyOps = true;
    context.selfModifyOpsJson = JSON.stringify(selfOps);
    context.escrowResultJson = JSON.stringify({ staged: true, migrationId: token.migrationId, files: affectedFiles });

    console.log(`\x1b[36m→ Escrow staged: ${affectedFiles.length} file(s), migration ${token.migrationId}\x1b[0m`);
    return { onSuccess: true, onFailure: false, ctx: JSON.stringify(context) };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m→ Escrow staging failed: ${msg}\x1b[0m`);
    store.clearEscrow();
    context.error = `Escrow staging failed: ${msg}`;
    return { onSuccess: false, onFailure: true, ctx: JSON.stringify(context) };
  }
}
