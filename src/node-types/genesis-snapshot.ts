import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GenesisConfig, GenesisContext } from '../bot/types.js';
import { GenesisStore } from '../bot/genesis-store.js';

/**
 * Saves a snapshot of the target workflow file before any modifications
 * are applied, enabling rollback if something goes wrong.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Genesis Snapshot
 * @input ctx [order:0] - Genesis context (JSON)
 * @output ctx [order:0] - Genesis context with snapshotPath (JSON)
 * @output onFailure [hidden]
 */
export function genesisSnapshot(ctx: string): { ctx: string } {
  const context = JSON.parse(ctx) as GenesisContext;
  const config = JSON.parse(context.genesisConfigJson) as GenesisConfig;
  const targetPath = path.resolve(context.env.projectDir, config.targetWorkflow);
  const content = fs.readFileSync(targetPath, 'utf-8');

  const store = new GenesisStore(context.env.projectDir);
  const snapshotPath = store.saveSnapshot(context.cycleId, content);

  console.log(`\x1b[36m→ Snapshot saved: ${snapshotPath}\x1b[0m`);

  context.snapshotPath = snapshotPath;
  return { ctx: JSON.stringify(context) };
}
