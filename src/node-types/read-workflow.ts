import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Reads and analyzes a workflow file. Produces structured description
 * with diagram using flow-weaver CLI commands.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Read Workflow
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
 * @output resultJson [order:5] - Workflow description and diagram (JSON)
 * @output filesModified [order:6] - Files modified (empty array, JSON)
 */
export function weaverReadWorkflow(
  projectDir: string,
  config: string,
  providerType: string,
  providerInfo: string,
  taskJson: string,
): { projectDir: string; config: string; providerType: string; providerInfo: string; taskJson: string; resultJson: string; filesModified: string } {
  const task = JSON.parse(taskJson) as { targets?: string[]; instruction?: string };
  const targets = task.targets ?? [];

  const passthrough = { projectDir, config, providerType, providerInfo, taskJson };

  if (targets.length === 0) {
    return {
      ...passthrough,
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
      diagram = execSync(`flow-weaver diagram "${filePath}" -f ascii-compact`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30_000,
        cwd: projectDir,
      }).trim();
    } catch { /* diagram generation failed, continue without it */ }

    try {
      description = execSync(`flow-weaver describe "${filePath}"`, {
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
    ...passthrough,
    resultJson: JSON.stringify({ success: true, results }),
    filesModified: '[]',
  };
}
