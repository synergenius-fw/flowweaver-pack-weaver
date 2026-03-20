import * as fs from 'node:fs';
import * as path from 'node:path';
import { runCommand } from '@synergenius/flow-weaver';

// ---------------------------------------------------------------------------
// Safety thresholds for write operations
// ---------------------------------------------------------------------------

/** Refuse writes that shrink an existing file by more than this ratio (0-1). */
const MAX_SHRINK_RATIO = 0.5;

/** Minimum file size (bytes) before shrink guard kicks in. Tiny files are exempt. */
const SHRINK_GUARD_MIN_SIZE = 100;

/** Maximum number of files that can be written in a single plan (prevents runaway). */
const MAX_FILES_PER_PLAN = 50;

/** Track files written in this process to enforce the per-plan cap. */
let filesWrittenThisPlan = 0;

/** Reset the per-plan counter between plans (called by exec-validate-retry). */
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

function checkWriteSafety(
  filePath: string,
  content: string,
): WriteGuardResult {
  // Guard 1: Empty content
  if (!content || content.trim().length === 0) {
    return {
      allowed: false,
      reason:
        `Refusing to write empty content to ${path.basename(filePath)}. ` +
        `Use read-file first to get the existing content, modify it, then write the complete file back.`,
    };
  }

  // Guard 2: Per-plan file cap
  if (filesWrittenThisPlan >= MAX_FILES_PER_PLAN) {
    return {
      allowed: false,
      reason:
        `File write limit reached (${MAX_FILES_PER_PLAN} files per plan). ` +
        `Split remaining work into a follow-up task.`,
    };
  }

  // Guard 3: Shrink detection (only for existing files above minimum size)
  if (fs.existsSync(filePath)) {
    const existingSize = fs.statSync(filePath).size;
    const newSize = Buffer.byteLength(content, 'utf-8');

    if (existingSize > SHRINK_GUARD_MIN_SIZE && newSize < existingSize * MAX_SHRINK_RATIO) {
      const shrinkPct = Math.round((1 - newSize / existingSize) * 100);
      return {
        allowed: false,
        reason:
          `Refusing to write ${path.basename(filePath)}: new content (${newSize} bytes) ` +
          `is ${shrinkPct}% smaller than existing file (${existingSize} bytes). ` +
          `This likely indicates truncated content. ` +
          `Use read-file to get the full content first, make targeted changes, ` +
          `then write the complete file back.`,
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
    case 'write-file':
    case 'create-workflow':
    case 'modify-source':
    case 'implement-node': {
      if (!file) {
        return {
          blocked: true,
          blockReason: `${step.operation} requires a "file" argument.`,
        };
      }

      // Path safety
      assertSafePath(file, projectDir);
      const filePath = path.resolve(projectDir, file);

      const content =
        (args.content as string) ?? (args.body as string) ?? '';

      // Write safety
      const guard = checkWriteSafety(filePath, content);
      if (!guard.allowed) {
        return {
          file: filePath,
          blocked: true,
          blockReason: guard.reason,
        };
      }

      // Safe to write
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const existed = fs.existsSync(filePath);
      fs.writeFileSync(filePath, content, 'utf-8');
      filesWrittenThisPlan++;

      return { file: filePath, created: !existed };
    }

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

    default: {
      const result = await runCommand(step.operation, {
        ...args,
        cwd: projectDir,
      });
      return {
        file: result.files?.[0],
        files: result.files,
        output:
          result.output ??
          (result.data ? JSON.stringify(result.data, null, 2) : undefined),
      };
    }
  }
}
