import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WeaverContext } from '../bot/types.js';

/**
 * Reads and analyzes a workflow file. Produces structured description
 * with diagram using flow-weaver CLI commands.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Read Workflow
 * @input ctx [order:0] - Weaver context (JSON)
 * @output ctx [order:0] - Weaver context with resultJson (JSON)
 * @output onFailure [hidden]
 */
export function weaverReadWorkflow(ctx: string): { ctx: string } {
  const context = JSON.parse(ctx) as WeaverContext;
  const task = JSON.parse(context.taskJson!) as { targets?: string[]; instruction?: string };
  const targets = task.targets ?? [];
  const { projectDir } = context.env;

  if (targets.length === 0) {
    context.resultJson = JSON.stringify({ success: false, error: 'No target files specified for read' });
    context.filesModified = '[]';
    return { ctx: JSON.stringify(context) };
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

  context.resultJson = JSON.stringify({ success: true, results });
  context.filesModified = '[]';
  return { ctx: JSON.stringify(context) };
}
