import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { WeaverEnv, GenesisConfig } from '../bot/types.js';

/**
 * Runs flow-weaver diff between the snapshot and the current target
 * workflow to produce a human-readable diff of workflow changes.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Genesis Diff Workflow
 * @input env [order:0] - Weaver environment bundle
 * @input genesisConfigJson [order:1] - Genesis configuration (JSON)
 * @input snapshotPath [order:2] - Path to the pre-apply snapshot
 * @output env [order:0] - Weaver environment bundle (pass-through)
 * @output genesisConfigJson [order:1] - Genesis configuration (pass-through)
 * @output workflowDiffJson [order:2] - Workflow diff output (JSON)
 */
export function genesisDiffWorkflow(
  env: WeaverEnv,
  genesisConfigJson: string,
  snapshotPath: string,
): {
  env: WeaverEnv;
  genesisConfigJson: string;
  workflowDiffJson: string;
} {
  const config = JSON.parse(genesisConfigJson) as GenesisConfig;
  const targetPath = path.resolve(env.projectDir, config.targetWorkflow);

  let diffOutput = '';
  try {
    diffOutput = execFileSync('flow-weaver', ['diff', snapshotPath, targetPath], {
      cwd: env.projectDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    }).trim();
  } catch (err: unknown) {
    // diff may exit non-zero when files differ, capture output from the error
    if (err && typeof err === 'object' && 'stdout' in err) {
      diffOutput = String((err as { stdout: string }).stdout).trim();
    }
    if (!diffOutput) {
      diffOutput = 'Unable to produce diff';
    }
  }

  console.log(`\x1b[36m→ Workflow diff: ${diffOutput.split('\n').length} lines\x1b[0m`);

  return {
    env, genesisConfigJson,
    workflowDiffJson: JSON.stringify({ diff: diffOutput }),
  };
}
