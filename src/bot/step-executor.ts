import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { runCommand } from '@synergenius/flow-weaver';

// ---------------------------------------------------------------------------
// Safety thresholds
// ---------------------------------------------------------------------------

/** Refuse writes that shrink an existing file by more than this ratio (0-1). */
const MAX_SHRINK_RATIO = 0.5;

/** Minimum file size (bytes) before shrink guard kicks in. */
const SHRINK_GUARD_MIN_SIZE = 100;

/** Maximum number of files that can be written in a single plan. */
const MAX_FILES_PER_PLAN = 50;

/** Maximum shell command execution time (ms). */
const SHELL_TIMEOUT = 60_000;

/** Shell commands that are NEVER allowed (destructive operations). */
const BLOCKED_SHELL_PATTERNS = [
  /\brm\s+-rf?\s+[\/~]/i,        // rm -rf /
  /\bgit\s+push\b/i,              // git push (no remote ops)
  /\bnpm\s+publish\b/i,           // npm publish
  /\bcurl\b.*\|\s*sh/i,           // curl | sh (pipe to shell)
  /\bsudo\b/i,                    // sudo
  /\bchmod\s+777\b/i,             // chmod 777
  /\bkill\s+-9\b/i,               // kill -9
  /\bmkfs\b/i,                    // format disk
  /\bdd\s+if=/i,                  // dd (disk destroyer)
];

/** Track files written in this process to enforce the per-plan cap. */
let filesWrittenThisPlan = 0;

/** Reset the per-plan counter between plans. */
export function resetPlanFileCounter(): void {
  filesWrittenThisPlan = 0;
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

function assertSafePath(filePath: string, projectDir: string): void {
  const resolved = path.resolve(projectDir, filePath);
  if (!resolved.startsWith(path.resolve(projectDir))) {
    throw new Error(
      `Path traversal blocked: "${filePath}" resolves outside project directory.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Write safety
// ---------------------------------------------------------------------------

interface WriteGuardResult {
  allowed: boolean;
  reason?: string;
}

function checkWriteSafety(filePath: string, content: string): WriteGuardResult {
  // Guard 1: Empty content
  if (!content || content.trim().length === 0) {
    return {
      allowed: false,
      reason:
        `Refusing to write empty content to ${path.basename(filePath)}. ` +
        `Use read-file first, then write the complete modified file back.`,
    };
  }

  // Guard 2: Per-plan file cap
  if (filesWrittenThisPlan >= MAX_FILES_PER_PLAN) {
    return {
      allowed: false,
      reason: `File write limit reached (${MAX_FILES_PER_PLAN} files per plan).`,
    };
  }

  // Guard 3: Shrink detection
  if (fs.existsSync(filePath)) {
    const existingSize = fs.statSync(filePath).size;
    const newSize = Buffer.byteLength(content, 'utf-8');
    if (existingSize > SHRINK_GUARD_MIN_SIZE && newSize < existingSize * MAX_SHRINK_RATIO) {
      const shrinkPct = Math.round((1 - newSize / existingSize) * 100);
      return {
        allowed: false,
        reason:
          `Refusing to write ${path.basename(filePath)}: new content (${newSize}B) ` +
          `is ${shrinkPct}% smaller than existing (${existingSize}B). ` +
          `Use read-file first, make targeted changes, write complete file back.`,
      };
    }
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Shell safety
// ---------------------------------------------------------------------------

function checkShellSafety(command: string): WriteGuardResult {
  for (const pattern of BLOCKED_SHELL_PATTERNS) {
    if (pattern.test(command)) {
      return {
        allowed: false,
        reason: `Shell command blocked by safety policy: matches "${pattern.source}"`,
      };
    }
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

export interface StepResult {
  file?: string;
  files?: string[];
  created?: boolean;
  output?: string;
  blocked?: boolean;
  blockReason?: string;
}

export async function executeStep(
  step: { operation: string; args: Record<string, unknown> },
  projectDir: string,
): Promise<StepResult> {
  const args = step.args;
  const file = args.file as string | undefined;

  switch (step.operation) {
    // -----------------------------------------------------------------
    // File write operations (with safety guards)
    // -----------------------------------------------------------------
    case 'write-file':
    case 'create-workflow':
    case 'modify-source':
    case 'implement-node': {
      if (!file) {
        return { blocked: true, blockReason: `${step.operation} requires a "file" argument.` };
      }
      assertSafePath(file, projectDir);
      const filePath = path.resolve(projectDir, file);
      const content = (args.content as string) ?? (args.body as string) ?? '';

      const guard = checkWriteSafety(filePath, content);
      if (!guard.allowed) {
        return { file: filePath, blocked: true, blockReason: guard.reason };
      }

      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const existed = fs.existsSync(filePath);
      fs.writeFileSync(filePath, content, 'utf-8');
      filesWrittenThisPlan++;
      return { file: filePath, created: !existed };
    }

    // -----------------------------------------------------------------
    // Patch file: surgical find-and-replace (no full rewrite needed)
    // -----------------------------------------------------------------
    case 'patch-file': {
      if (!file) {
        return { blocked: true, blockReason: 'patch-file requires a "file" argument.' };
      }
      assertSafePath(file, projectDir);
      const filePath = path.resolve(projectDir, file);

      if (!fs.existsSync(filePath)) {
        return { blocked: true, blockReason: `File not found: ${file}` };
      }

      let content = fs.readFileSync(filePath, 'utf-8');
      const patches = (args.patches as Array<{ find: string; replace: string }>) ?? [];

      if (!patches.length && args.find && args.replace !== undefined) {
        // Single patch shorthand: { find: "old", replace: "new" }
        patches.push({ find: args.find as string, replace: args.replace as string });
      }

      if (!patches.length) {
        return { blocked: true, blockReason: 'patch-file requires "patches" array or "find"+"replace" args.' };
      }

      let applied = 0;
      const notFound: string[] = [];

      for (const patch of patches) {
        if (content.includes(patch.find)) {
          content = content.replace(patch.find, patch.replace);
          applied++;
        } else {
          notFound.push(patch.find.substring(0, 60));
        }
      }

      if (applied === 0) {
        return {
          file: filePath,
          output: `No patches applied. Search strings not found: ${notFound.join('; ')}`,
        };
      }

      fs.writeFileSync(filePath, content, 'utf-8');
      filesWrittenThisPlan++;

      const summary = `Applied ${applied}/${patches.length} patches` +
        (notFound.length ? `. Not found: ${notFound.join('; ')}` : '');
      return { file: filePath, output: summary };
    }

    // -----------------------------------------------------------------
    // Read file: return content for AI context
    // -----------------------------------------------------------------
    case 'read-file': {
      if (!file) {
        return { output: '' };
      }
      assertSafePath(file, projectDir);
      const filePath = path.resolve(projectDir, file);
      if (!fs.existsSync(filePath)) {
        return { output: `File not found: ${file}` };
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      return { file: filePath, output: content };
    }

    // -----------------------------------------------------------------
    // Shell command: run arbitrary command with safety guards
    // -----------------------------------------------------------------
    case 'run-shell': {
      const command = (args.command as string) ?? '';
      if (!command.trim()) {
        return { blocked: true, blockReason: 'run-shell requires a "command" argument.' };
      }

      const shellGuard = checkShellSafety(command);
      if (!shellGuard.allowed) {
        return { blocked: true, blockReason: shellGuard.reason };
      }

      try {
        const output = execSync(command, {
          cwd: projectDir,
          encoding: 'utf-8',
          timeout: SHELL_TIMEOUT,
          maxBuffer: 1024 * 1024, // 1MB output cap
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return { output: output.trim() };
      } catch (err: unknown) {
        // Shell commands that exit non-zero still return useful output
        const execErr = err as { stdout?: string; stderr?: string; status?: number };
        const stdout = (execErr.stdout ?? '').trim();
        const stderr = (execErr.stderr ?? '').trim();
        const combined = [stdout, stderr].filter(Boolean).join('\n');
        return {
          output: combined || (err instanceof Error ? err.message : String(err)),
        };
      }
    }

    // -----------------------------------------------------------------
    // List files: glob-like directory listing
    // -----------------------------------------------------------------
    case 'list-files': {
      const dir = (args.directory as string) ?? (args.dir as string) ?? '.';
      const pattern = (args.pattern as string) ?? '';
      assertSafePath(dir, projectDir);
      const targetDir = path.resolve(projectDir, dir);

      if (!fs.existsSync(targetDir)) {
        return { output: `Directory not found: ${dir}` };
      }

      const entries = fs.readdirSync(targetDir, { recursive: true, encoding: 'utf-8' }) as string[];
      let files = entries
        .filter(e => {
          const full = path.join(targetDir, e);
          try { return fs.statSync(full).isFile(); } catch { return false; }
        })
        .sort();

      if (pattern) {
        const regex = new RegExp(pattern);
        files = files.filter(f => regex.test(f));
      }

      return { files: files.map(f => path.join(dir, f)), output: files.join('\n') };
    }

    // -----------------------------------------------------------------
    // Flow-weaver CLI commands (via programmatic API)
    // -----------------------------------------------------------------
    default: {
      const result = await runCommand(step.operation, { ...args, cwd: projectDir });
      return {
        file: result.files?.[0],
        files: result.files,
        output: result.output ?? (result.data ? JSON.stringify(result.data, null, 2) : undefined),
      };
    }
  }
}
