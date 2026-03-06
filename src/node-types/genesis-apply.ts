import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { WeaverEnv, GenesisConfig, GenesisProposal, GenesisOperation } from '../bot/types.js';

/**
 * Applies proposal operations to the target workflow by invoking the
 * flow-weaver CLI modify command for each operation.
 *
 * @flowWeaver nodeType
 * @label Genesis Apply
 * @input env [order:0] - Weaver environment bundle
 * @input genesisConfigJson [order:1] - Genesis configuration (JSON)
 * @input proposalJson [order:2] - Genesis proposal (JSON)
 * @input snapshotPath [order:3] - Path to the pre-apply snapshot
 * @output env [order:0] - Weaver environment bundle (pass-through)
 * @output genesisConfigJson [order:1] - Genesis configuration (pass-through)
 * @output proposalJson [order:2] - Genesis proposal (pass-through)
 * @output snapshotPath [order:3] - Path to the pre-apply snapshot (pass-through)
 * @output applyResultJson [order:4] - Apply result (JSON)
 * @output onSuccess [order:-2] - On Success
 * @output onFailure [order:-1] - On Failure
 */
export async function genesisApply(
  execute: boolean,
  env: WeaverEnv,
  genesisConfigJson: string,
  proposalJson: string,
  snapshotPath: string,
): Promise<{
  onSuccess: boolean; onFailure: boolean;
  env: WeaverEnv;
  genesisConfigJson: string;
  proposalJson: string;
  snapshotPath: string;
  applyResultJson: string;
}> {
  if (!execute) {
    const result = { applied: 0, failed: 0, errors: [] as string[] };
    return { onSuccess: true, onFailure: false, env, genesisConfigJson, proposalJson, snapshotPath, applyResultJson: JSON.stringify(result) };
  }

  const config = JSON.parse(genesisConfigJson) as GenesisConfig;
  const proposal = JSON.parse(proposalJson) as GenesisProposal;
  const targetPath = path.resolve(env.projectDir, config.targetWorkflow);

  let applied = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const op of proposal.operations) {
    try {
      const cliArgs = buildModifyArgs(op, targetPath);
      execFileSync('flow-weaver', cliArgs, {
        cwd: env.projectDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30_000,
      });
      applied++;
      console.log(`\x1b[32m  + ${op.type}: ${op.rationale}\x1b[0m`);
    } catch (err: unknown) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${op.type}: ${msg}`);
      console.error(`\x1b[31m  x ${op.type}: ${msg}\x1b[0m`);
    }
  }

  const result = { applied, failed, errors };
  const success = failed === 0 && applied > 0;

  console.log(`\x1b[36m→ Apply: ${applied} succeeded, ${failed} failed\x1b[0m`);

  return {
    onSuccess: success, onFailure: !success,
    env, genesisConfigJson, proposalJson, snapshotPath,
    applyResultJson: JSON.stringify(result),
  };
}

function buildModifyArgs(op: GenesisOperation, targetPath: string): string[] {
  switch (op.type) {
    case 'addNode':
      return ['modify', 'addNode', '--file', targetPath, '--nodeId', String(op.args.nodeId), '--nodeType', String(op.args.nodeType)];
    case 'removeNode':
      return ['modify', 'removeNode', '--file', targetPath, '--nodeId', String(op.args.nodeId)];
    case 'addConnection':
      return ['modify', 'addConnection', '--file', targetPath, '--from', String(op.args.from), '--to', String(op.args.to)];
    case 'removeConnection':
      return ['modify', 'removeConnection', '--file', targetPath, '--from', String(op.args.from), '--to', String(op.args.to)];
    case 'implementNode':
      return ['implement', targetPath, '--nodeId', String(op.args.nodeId)];
    default:
      throw new Error(`Unknown genesis operation type: ${op.type}`);
  }
}
