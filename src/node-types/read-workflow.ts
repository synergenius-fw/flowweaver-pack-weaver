import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WeaverEnv } from '../bot/types.js';

/**
 * Reads and analyzes a workflow file. Produces structured description
 * with diagram using flow-weaver CLI commands.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Read Workflow
 * @input env [order:0] - Weaver environment bundle
 * @input taskJson [order:1] - Task (JSON)
 * @output env [order:0] - Weaver environment bundle (pass-through)
 * @output taskJson [order:1] - Task (pass-through)
 * @output resultJson [order:2] - Workflow description and diagram (JSON)
 * @output filesModified [order:3] - Files modified (empty array, JSON)
 */
export function weaverReadWorkflow(
  env: WeaverEnv,
  taskJson: string,
): { env: WeaverEnv; taskJson: string; resultJson: string; filesModified: string } {
  const task = JSON.parse(taskJson) as { targets?: string[]; instruction?: string };
  const targets = task.targets ?? [];
  const { projectDir } = env;

  if (targets.length === 0) {
    return {
      env, taskJson,
      resultJson: JSON.stringify({ success: false, error: 'No target files specified for read' }),
      filesModified: '[]',
    };
  }

  const results: Array<{ file: string; source?: string; diagram?: string; description?: string; error?: string }> = [];

  for (const target of targets) {
    const filePath = path.isAbsolute(target) ? target : path.resolve(projectDir, target);

    if (!fs.existsSync(filePath)) {
      results.push({ file: target, error: `File not found: ${filePath}` });
      continue;
    }

    const source = fs.readFileSync(filePath, 'utf-8');
    let diagram = '';
    let description = '';

    try {
      diagram = execFileSync('flow-weaver', ['diagram', filePath, '-f', 'ascii-compact'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30_000,
        cwd: projectDir,
      }).trim();
    } catch { /* diagram generation failed, continue without it */ }

    try {
      description = execFileSync('flow-weaver', ['describe', filePath], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30_000,
        cwd: projectDir,
      }).trim();
    } catch { /* description failed, continue without it */ }

    results.push({ file: target, source, diagram, description });
    console.log(`\x1b[36m→ Read: ${target}\x1b[0m`);
  }

  return {
    env, taskJson,
    resultJson: JSON.stringify({ success: true, results }),
    filesModified: '[]',
  };
}
