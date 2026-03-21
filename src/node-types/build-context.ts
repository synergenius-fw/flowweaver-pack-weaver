import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WeaverContext } from '../bot/types.js';

/**
 * Builds the knowledge bundle the AI needs for planning.
 * Adaptive: for modify tasks, includes only grammar + referenced node types.
 * For create tasks, includes full authoring context + templates.
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

  if (task.mode === 'modify' && task.targets?.length) {
    // Adaptive context: minimal grammar + target files + referenced node types
    sections.push(...buildModifyContext(projectDir, task.targets));
  } else {
    // Full context for create tasks or unknown modes
    sections.push(...buildFullContext(projectDir, task.mode));
  }

  const bundle = sections.join('\n\n---\n\n');
  // Output handled by session renderer; keep a dim line for debugging
  if (process.env.WEAVER_VERBOSE) process.stderr.write(`\x1b[2m  Context: ${bundle.length} chars\x1b[0m\n`);

  context.contextBundle = bundle;
  return { ctx: JSON.stringify(context) };
}

/** Minimal context for modify tasks: grammar + annotations + target sources + referenced node types. */
function buildModifyContext(projectDir: string, targets: string[]): string[] {
  const sections: string[] = [];

  // Minimal grammar (jsdoc-grammar + advanced-annotations only — skip concepts/scaffold/patterns)
  try {
    const ctxOutput = execFileSync(
      'flow-weaver',
      ['context', '--topics', 'jsdoc-grammar,advanced-annotations', '--profile', 'assistant'],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000, cwd: projectDir },
    ).trim();
    if (ctxOutput) sections.push(ctxOutput);
  } catch {
    sections.push('(flow-weaver context not available)');
  }

  // Target file sources + referenced node type sources
  const includedFiles = new Set<string>();
  for (const target of targets) {
    const filePath = path.isAbsolute(target) ? target : path.resolve(projectDir, target);
    try {
      if (!fs.existsSync(filePath)) continue;
      const source = fs.readFileSync(filePath, 'utf-8');
      sections.push(`## Target: ${target}\n\n\`\`\`typescript\n${source}\n\`\`\``);
      includedFiles.add(filePath);

      // Extract import paths to find referenced node type files
      const nodeTypeSources = extractReferencedNodeTypes(filePath, source, projectDir);
      for (const [relPath, ntSource] of nodeTypeSources) {
        const absPath = path.resolve(projectDir, relPath);
        if (!includedFiles.has(absPath)) {
          includedFiles.add(absPath);
          sections.push(`## Node Type: ${relPath}\n\n\`\`\`typescript\n${ntSource}\n\`\`\``);
        }
      }
    } catch { /* skip unreadable files */ }
  }

  return sections;
}

/** Full context for create tasks: full authoring preset + templates. */
function buildFullContext(projectDir: string, mode?: string): string[] {
  const sections: string[] = [];

  try {
    const ctxOutput = execFileSync(
      'flow-weaver',
      ['context', 'authoring', '--profile', 'assistant'],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000, cwd: projectDir },
    ).trim();
    if (ctxOutput) sections.push(ctxOutput);
  } catch {
    sections.push('(flow-weaver context not available)');
  }

  if (mode === 'create') {
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

  return sections;
}

/**
 * Extract node type file sources referenced by a workflow file's imports.
 * Parses import statements to find relative imports from node-types directories.
 */
function extractReferencedNodeTypes(
  filePath: string,
  source: string,
  projectDir: string,
): Array<[relPath: string, source: string]> {
  const results: Array<[string, string]> = [];
  const dir = path.dirname(filePath);

  // Match: import { ... } from '../node-types/foo.js' or './node-types/bar'
  const importRegex = /import\s+(?:type\s+)?{[^}]+}\s+from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;

  while ((match = importRegex.exec(source)) !== null) {
    const importPath = match[1];
    // Only include relative imports that look like node type files
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) continue;
    if (!importPath.includes('node-type') && !importPath.includes('node_type')) continue;

    // Resolve the import to an absolute path
    let resolved = path.resolve(dir, importPath);
    // Try with .ts extension if no extension
    if (!fs.existsSync(resolved)) {
      if (fs.existsSync(resolved + '.ts')) resolved = resolved + '.ts';
      else if (fs.existsSync(resolved.replace(/\.js$/, '.ts'))) resolved = resolved.replace(/\.js$/, '.ts');
      else continue;
    }

    try {
      const ntSource = fs.readFileSync(resolved, 'utf-8');
      const relPath = path.relative(projectDir, resolved);
      results.push([relPath, ntSource]);
    } catch { /* skip */ }
  }

  return results;
}
