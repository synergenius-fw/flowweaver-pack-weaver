/**
 * Auto task decomposition — splits broad tasks into per-file tasks.
 *
 * When a task says "fix all templates" or "validate everything",
 * decompose it into one task per file. This gives the AI focused
 * context and prevents one failure from blocking all files.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface DecomposableTask {
  id: string;
  instruction: string;
  mode?: string;
  targets?: string[];
  priority?: number;
}

export interface DecomposedResult {
  decomposed: boolean;
  tasks: DecomposableTask[];
}

// Patterns that suggest a broad task targeting multiple files
const BROAD_PATTERNS = [
  /\b(all|every|each)\b.*\b(template|workflow|file|node.?type)s?\b/i,
  /\bfix\b.*\bin\s+src\/(templates|node-types|workflows)\/?$/i,
  /\bvalidat(e|ion)\b.*\b(all|every|each|src\/)\b/i,
];

/**
 * Check if a task should be decomposed into per-file tasks.
 * Returns the original task unchanged if no decomposition is needed.
 */
export function decomposeTask(
  task: DecomposableTask,
  projectDir: string,
): DecomposedResult {
  const instruction = task.instruction;

  // Already has specific targets — don't decompose
  if (task.targets && task.targets.length === 1) {
    return { decomposed: false, tasks: [task] };
  }

  // Check if instruction matches broad patterns
  const isBroad = BROAD_PATTERNS.some(p => p.test(instruction));
  if (!isBroad) {
    return { decomposed: false, tasks: [task] };
  }

  // Determine which directory to scan
  let targetDir: string | undefined;
  if (instruction.match(/template/i)) targetDir = 'src/templates';
  else if (instruction.match(/node.?type/i)) targetDir = 'src/node-types';
  else if (instruction.match(/workflow/i)) targetDir = 'src/workflows';

  if (!targetDir) {
    return { decomposed: false, tasks: [task] };
  }

  const absDir = path.resolve(projectDir, targetDir);
  if (!fs.existsSync(absDir)) {
    return { decomposed: false, tasks: [task] };
  }

  // List .ts files in the directory
  let files: string[];
  try {
    files = fs.readdirSync(absDir)
      .filter(f => f.endsWith('.ts') && !f.startsWith('index'))
      .sort();
  } catch {
    return { decomposed: false, tasks: [task] };
  }

  if (files.length === 0 || files.length > 50) {
    // Too few or too many — don't decompose
    return { decomposed: false, tasks: [task] };
  }

  // Create per-file tasks, inheriting the original instruction
  const tasks: DecomposableTask[] = files.map((file, i) => {
    const filePath = path.join(targetDir!, file);
    // Rewrite instruction to target specific file
    const fileInstruction = instruction
      .replace(/\b(all|every|each)\b/i, '')
      .replace(/\bsrc\/(templates|node-types|workflows)\/?/i, filePath)
      .trim()
      .replace(/\s+/g, ' ');

    return {
      id: `${task.id}-${i + 1}`,
      instruction: `${fileInstruction} Target: ${filePath}`,
      mode: task.mode ?? 'modify',
      targets: [filePath],
      priority: task.priority ?? 0,
    };
  });

  return { decomposed: true, tasks };
}
