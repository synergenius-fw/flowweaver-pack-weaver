import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WeaverConfig } from '../bot/types.js';

/**
 * Read .weaver.json, merge with defaults, and output the config object.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Load Config
 * @input [projectDir] [order:0] - Project root directory (defaults to cwd)
 * @output projectDir [order:0] - Project root directory (pass-through)
 * @output config [order:1] - Weaver configuration (JSON)
 */
export function weaverLoadConfig(projectDir?: string): { projectDir: string; config: string } {
  const dir = projectDir || process.cwd();
  const configPath = path.join(dir, '.weaver.json');
  let config: WeaverConfig = { provider: 'auto' };
  if (fs.existsSync(configPath)) {
    config = { ...config, ...JSON.parse(fs.readFileSync(configPath, 'utf-8')) };
    console.log(`\x1b[36m→ Loaded config from ${configPath}\x1b[0m`);
  } else {
    console.log('\x1b[36m→ No .weaver.json found, using defaults (provider: auto)\x1b[0m');
  }
  return { projectDir: dir, config: JSON.stringify(config) };
}
