import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { WeaverEnv, GenesisConfig } from '../bot/types.js';
import { GenesisStore } from '../bot/genesis-store.js';

/**
 * Commits the modified workflow to git if approved, or restores from
 * the snapshot if rejected. Commit messages are prefixed with "genesis:".
 *
 * @flowWeaver nodeType
 * @label Genesis Commit
 * @input env [order:0] - Weaver environment bundle
 * @input genesisConfigJson [order:1] - Genesis configuration (JSON)
 * @input snapshotPath [order:2] - Path to the pre-apply snapshot
 * @input approved [order:3] - Whether the proposal was approved
 * @output env [order:0] - Weaver environment bundle (pass-through)
 * @output genesisConfigJson [order:1] - Genesis configuration (pass-through)
 * @output commitResultJson [order:2] - Commit result (JSON)
 * @output onSuccess [order:-2] - On Success
 * @output onFailure [order:-1] - On Failure
 */
export async function genesisCommit(
  execute: boolean,
  env: WeaverEnv,
  genesisConfigJson: string,
  snapshotPath: string,
  approved: boolean,
): Promise<{
  onSuccess: boolean; onFailure: boolean;
  env: WeaverEnv;
  genesisConfigJson: string;
  commitResultJson: string;
}> {
  if (!execute) {
    return { onSuccess: true, onFailure: false, env, genesisConfigJson, commitResultJson: JSON.stringify({ committed: false, reason: 'dry run' }) };
  }

  const config = JSON.parse(genesisConfigJson) as GenesisConfig;
  const targetPath = path.resolve(env.projectDir, config.targetWorkflow);

  if (!approved) {
    // Restore from snapshot
    const store = new GenesisStore(env.projectDir);
    const snapshot = store.loadSnapshot(snapshotPath);
    if (snapshot) {
      fs.writeFileSync(targetPath, snapshot, 'utf-8');
      console.log('\x1b[33m→ Restored from snapshot (not approved)\x1b[0m');
    }
    return {
      onSuccess: false, onFailure: true,
      env, genesisConfigJson,
      commitResultJson: JSON.stringify({ committed: false, reason: 'not approved' }),
    };
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
    return {
      onSuccess: true, onFailure: false,
      env, genesisConfigJson,
      commitResultJson: JSON.stringify({ committed: true, message }),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m→ Commit failed: ${msg}\x1b[0m`);
    return {
      onSuccess: false, onFailure: true,
      env, genesisConfigJson,
      commitResultJson: JSON.stringify({ committed: false, reason: msg }),
    };
  }
}
