import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { GenesisConfig, GenesisProposal, GenesisOperation, GenesisContext } from '../bot/types.js';
import { GenesisStore } from '../bot/genesis-store.js';

/**
 * Applies proposal operations then validates + compiles. On compile
 * failure, restores the snapshot and returns the failure path with
 * error details so the parent scope can retry with a revised proposal.
 *
 * @flowWeaver nodeType
 * @label Genesis Try Apply
 * @input ctx [order:0] - Genesis context (JSON)
 * @output ctx [order:0] - Genesis context with apply results (JSON)
 * @output onSuccess [order:-2] - On Success
 * @output onFailure [order:-1] [hidden] - On Failure
 */
export async function genesisTryApply(
  execute: boolean,
  ctx: string,
): Promise<{
  onSuccess: boolean; onFailure: boolean;
  ctx: string;
}> {
  const context = JSON.parse(ctx) as GenesisContext;

  if (!execute) {
    const result = { applied: 0, failed: 0, errors: [] };
    context.applyResultJson = JSON.stringify(result);
    context.error = '';
    return { onSuccess: true, onFailure: false, ctx: JSON.stringify(context) };
  }

  const { env } = context;
  const config = JSON.parse(context.genesisConfigJson) as GenesisConfig;
  const proposal = JSON.parse(context.proposalJson!) as GenesisProposal;
  const targetPath = path.resolve(env.projectDir, config.targetWorkflow);

  // Apply operations
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

  const applyResult = { applied, failed, errors };
  context.applyResultJson = JSON.stringify(applyResult);

  console.log(`\x1b[36m→ Apply: ${applied} succeeded, ${failed} failed\x1b[0m`);

  // If all operations failed, no point compiling
  if (applied === 0) {
    context.error = '';
    return { onSuccess: false, onFailure: true, ctx: JSON.stringify(context) };
  }

  // Validate + compile
  try {
    execFileSync('flow-weaver', ['validate', targetPath], {
      cwd: env.projectDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    console.log('\x1b[32m→ Validation passed\x1b[0m');

    execFileSync('flow-weaver', ['compile', targetPath], {
      cwd: env.projectDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    console.log('\x1b[32m→ Compilation passed\x1b[0m');

    context.error = '';
    return { onSuccess: true, onFailure: false, ctx: JSON.stringify(context) };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m→ Compile/validate failed: ${msg}\x1b[0m`);

    // Restore from snapshot
    const store = new GenesisStore(env.projectDir);
    const snapshot = store.loadSnapshot(context.snapshotPath!);
    if (snapshot) {
      fs.writeFileSync(targetPath, snapshot, 'utf-8');
      console.log('\x1b[33m→ Restored from snapshot\x1b[0m');
    }

    context.error = msg;
    return { onSuccess: false, onFailure: true, ctx: JSON.stringify(context) };
  }
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
