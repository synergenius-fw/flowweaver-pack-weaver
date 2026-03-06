import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Builds the knowledge bundle the AI needs for planning. Calls
 * flow-weaver context authoring for the base knowledge, and
 * appends target file sources for modify tasks.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Build Context
 * @input projectDir [order:0] - Project root directory
 * @input config [order:1] - Config (JSON, pass-through)
 * @input providerType [order:2] - Provider type (pass-through)
 * @input providerInfo [order:3] - Provider info (JSON, pass-through)
 * @input taskJson [order:4] - Task (JSON)
 * @output projectDir [order:0] - Project root directory (pass-through)
 * @output config [order:1] - Config (pass-through)
 * @output providerType [order:2] - Provider type (pass-through)
 * @output providerInfo [order:3] - Provider info (pass-through)
 * @output taskJson [order:4] - Task (pass-through)
 * @output contextBundle [order:5] - Knowledge bundle (markdown string)
 */
export function weaverBuildContext(
  projectDir: string,
  config: string,
  providerType: string,
  providerInfo: string,
  taskJson: string,
): {
  projectDir: string; config: string; providerType: string; providerInfo: string;
  taskJson: string; contextBundle: string;
} {
  const passthrough = { projectDir, config, providerType, providerInfo, taskJson };
  const task = JSON.parse(taskJson) as { mode?: string; targets?: string[] };
  const sections: string[] = [];

  // Base context from flow-weaver CLI
  try {
    const context = execSync('flow-weaver context authoring --profile assistant', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
      cwd: projectDir,
    }).trim();
    if (context) sections.push(context);
  } catch {
    sections.push('(flow-weaver context not available)');
  }

  // For modify tasks, read target files
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

  // For create tasks, list available templates
  if (task.mode === 'create') {
    try {
      const templates = execSync('flow-weaver list templates', {
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

  return { ...passthrough, contextBundle: bundle };
}
