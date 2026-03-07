import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { GenesisConfig, GenesisContext } from '../bot/types.js';

/**
 * Runs flow-weaver diff between the snapshot and the current target
 * workflow to produce a human-readable diff of workflow changes.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Genesis Diff Workflow
 * @input ctx [order:0] - Genesis context (JSON)
 * @output ctx [order:0] - Genesis context with workflowDiffJson (JSON)
 * @output onFailure [hidden]
 */
export function genesisDiffWorkflow(ctx: string): { ctx: string } {
  const context = JSON.parse(ctx) as GenesisContext;
  const config = JSON.parse(context.genesisConfigJson) as GenesisConfig;
  const targetPath = path.resolve(context.env.projectDir, config.targetWorkflow);

  let diffOutput = '';
  try {
    diffOutput = execFileSync('flow-weaver', ['diff', context.snapshotPath!, targetPath], {
      cwd: context.env.projectDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    }).trim();
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'stdout' in err) {
      diffOutput = String((err as { stdout: string }).stdout).trim();
    }
    if (!diffOutput) {
      diffOutput = 'Unable to produce diff';
    }
  }

  console.log(`\x1b[36m→ Workflow diff: ${diffOutput.split('\n').length} lines\x1b[0m`);

  context.workflowDiffJson = JSON.stringify({ diff: diffOutput });
  return { ctx: JSON.stringify(context) };
}
