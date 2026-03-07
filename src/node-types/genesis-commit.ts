import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { GenesisConfig, GenesisContext } from '../bot/types.js';
import { GenesisStore } from '../bot/genesis-store.js';

/**
 * Commits the modified workflow to git if approved, or restores from
 * the snapshot if rejected. Commit messages are prefixed with "genesis:".
 *
 * @flowWeaver nodeType
 * @label Genesis Commit
 * @input ctx [order:0] - Genesis context (JSON)
 * @output ctx [order:0] - Genesis context with commitResultJson (JSON)
 * @output onSuccess [order:-2] - On Success
 * @output onFailure [order:-1] [hidden] - On Failure
 */
export async function genesisCommit(
  execute: boolean,
  ctx: string,
): Promise<{
  onSuccess: boolean; onFailure: boolean;
  ctx: string;
}> {
  const context = JSON.parse(ctx) as GenesisContext;

  if (!execute) {
    context.commitResultJson = JSON.stringify({ committed: false, reason: 'dry run' });
    return { onSuccess: true, onFailure: false, ctx: JSON.stringify(context) };
  }

  const { env } = context;
  const config = JSON.parse(context.genesisConfigJson) as GenesisConfig;
  const targetPath = path.resolve(env.projectDir, config.targetWorkflow);

  if (!context.approved) {
    // Restore from snapshot
    const store = new GenesisStore(env.projectDir);
    const snapshot = store.loadSnapshot(context.snapshotPath!);
    if (snapshot) {
      fs.writeFileSync(targetPath, snapshot, 'utf-8');
      console.log('\x1b[33m→ Restored from snapshot (not approved)\x1b[0m');
    }
    context.commitResultJson = JSON.stringify({ committed: false, reason: 'not approved' });
    return { onSuccess: false, onFailure: true, ctx: JSON.stringify(context) };
  }

  try {
    execFileSync('git', ['add', targetPath], {
      cwd: env.projectDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const message = `genesis: evolve ${path.basename(config.targetWorkflow)}`;
    execFileSync('git', ['commit', '-m', message], {
      cwd: env.projectDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    console.log(`\x1b[32m→ Committed: ${message}\x1b[0m`);
    context.commitResultJson = JSON.stringify({ committed: true, message });
    return { onSuccess: true, onFailure: false, ctx: JSON.stringify(context) };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m→ Commit failed: ${msg}\x1b[0m`);
    context.commitResultJson = JSON.stringify({ committed: false, reason: msg });
    return { onSuccess: false, onFailure: true, ctx: JSON.stringify(context) };
  }
}
