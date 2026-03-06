import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { WeaverEnv, GenesisConfig } from '../bot/types.js';
import { GenesisStore } from '../bot/genesis-store.js';

/**
 * Runs flow-weaver validate and compile on the target workflow after
 * operations have been applied. On failure, restores from the snapshot
 * and fires the failure path.
 *
 * @flowWeaver nodeType
 * @label Genesis Compile & Validate
 * @input env [order:0] - Weaver environment bundle
 * @input genesisConfigJson [order:1] - Genesis configuration (JSON)
 * @input snapshotPath [order:2] - Path to the pre-apply snapshot
 * @input applyResultJson [order:3] - Apply result (JSON)
 * @output env [order:0] - Weaver environment bundle (pass-through)
 * @output genesisConfigJson [order:1] - Genesis configuration (pass-through)
 * @output snapshotPath [order:2] - Path to the snapshot (pass-through)
 * @output onSuccess [order:-2] - On Success
 * @output onFailure [order:-1] - On Failure
 */
export async function genesisCompileValidate(
  execute: boolean,
  env: WeaverEnv,
  genesisConfigJson: string,
  snapshotPath: string,
  applyResultJson: string,
): Promise<{
  onSuccess: boolean; onFailure: boolean;
  env: WeaverEnv;
  genesisConfigJson: string;
  snapshotPath: string;
}> {
  if (!execute) {
    return { onSuccess: true, onFailure: false, env, genesisConfigJson, snapshotPath };
  }

  const config = JSON.parse(genesisConfigJson) as GenesisConfig;
  const targetPath = path.resolve(env.projectDir, config.targetWorkflow);

  try {
    // Validate
    execFileSync('flow-weaver', ['validate', targetPath], {
      cwd: env.projectDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    console.log('\x1b[32m→ Validation passed\x1b[0m');

    // Compile
    execFileSync('flow-weaver', ['compile', targetPath], {
      cwd: env.projectDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    console.log('\x1b[32m→ Compilation passed\x1b[0m');

    return { onSuccess: true, onFailure: false, env, genesisConfigJson, snapshotPath };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m→ Compile/validate failed: ${msg}\x1b[0m`);

    // Restore from snapshot
    const store = new GenesisStore(env.projectDir);
    const snapshot = store.loadSnapshot(snapshotPath);
    if (snapshot) {
      fs.writeFileSync(targetPath, snapshot, 'utf-8');
      console.log('\x1b[33m→ Restored from snapshot\x1b[0m');
    }

    return { onSuccess: false, onFailure: true, env, genesisConfigJson, snapshotPath };
  }
}
