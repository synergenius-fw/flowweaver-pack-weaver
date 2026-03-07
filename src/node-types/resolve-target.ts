import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WeaverEnv, WeaverContext } from '../bot/types.js';

/**
 * Find the target workflow file from config or by scanning the project directory.
 * Creates the WeaverContext that threads through the pipeline.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Resolve Target
 * @input env [order:0] - Weaver environment bundle
 * @output ctx [order:0] - Weaver context (JSON)
 * @output onFailure [hidden]
 */
export function weaverResolveTarget(
  env: WeaverEnv,
): { ctx: string } {
  const { projectDir, config } = env;

  let targetPath: string;

  if (config.target) {
    const abs = path.resolve(projectDir, config.target);
    if (!fs.existsSync(abs)) throw new Error(`Target workflow not found: ${abs}`);
    console.log(`\x1b[36m→ Target: ${abs}\x1b[0m`);
    targetPath = abs;
  } else {
    const found: string[] = [];
    const scan = (dir: string, depth: number): void => {
      if (depth > 2) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { scan(full, depth + 1); }
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
          try {
            const content = fs.readFileSync(full, 'utf-8').slice(0, 2000);
            if (content.includes('@flowWeaver workflow')) found.push(full);
          } catch { /* skip */ }
        }
      }
    };
    scan(projectDir, 0);

    if (found.length === 0) {
      throw new Error(`No workflow files found in ${projectDir}. Set "target" in .weaver.json or pass a file path.`);
    }
    if (found.length > 1) {
      throw new Error(
        `Multiple workflows found. Set "target" in .weaver.json to pick one:\n` +
        found.map(f => `  - ${path.relative(projectDir, f)}`).join('\n'),
      );
    }

    console.log(`\x1b[36m→ Target: ${found[0]}\x1b[0m`);
    targetPath = found[0]!;
  }

  const context: WeaverContext = { env, targetPath };
  return { ctx: JSON.stringify(context) };
}
