import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WeaverContext } from '../bot/types.js';

/**
 * Builds the knowledge bundle the AI needs for planning. Calls
 * flow-weaver context authoring for the base knowledge, and
 * appends target file sources for modify tasks.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Build Context
 * @input ctx [order:0] - Weaver context (JSON)
 * @output ctx [order:0] - Weaver context with contextBundle (JSON)
 * @output onFailure [hidden]
 */
export function weaverBuildContext(ctx: string): { ctx: string } {
  const context = JSON.parse(ctx) as WeaverContext;
  const { projectDir } = context.env;
  const task = JSON.parse(context.taskJson!) as { mode?: string; targets?: string[] };
  const sections: string[] = [];

  try {
    const ctxOutput = execFileSync('flow-weaver', ['context', 'authoring', '--profile', 'assistant'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
      cwd: projectDir,
    }).trim();
    if (ctxOutput) sections.push(ctxOutput);
  } catch {
    sections.push('(flow-weaver context not available)');
  }

  if (task.mode === 'modify' && task.targets) {
    for (const target of task.targets) {
      const filePath = path.isAbsolute(target) ? target : path.resolve(projectDir, target);
      try {
        if (fs.existsSync(filePath)) {
          const source = fs.readFileSync(filePath, 'utf-8');
          sections.push(`## Current Source: ${target}\n\n\`\`\`typescript\n${source}\n\`\`\``);
        }
      } catch { /* skip unreadable files */ }
    }
  }

  if (task.mode === 'create') {
    try {
      const templates = execFileSync('flow-weaver', ['list', 'templates'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10_000,
        cwd: projectDir,
      }).trim();
      if (templates) sections.push(`## Available Templates\n\n${templates}`);
    } catch { /* templates not available */ }
  }

  const bundle = sections.join('\n\n---\n\n');
  console.log(`\x1b[36m→ Context bundle: ${bundle.length} chars\x1b[0m`);

  context.contextBundle = bundle;
  return { ctx: JSON.stringify(context) };
}
