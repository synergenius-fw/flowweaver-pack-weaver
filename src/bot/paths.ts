/**
 * Shared path resolution — single source of truth for .weaver directory layout.
 */
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

/**
 * Hash a directory path into a short filesystem-safe string.
 * Used for per-project isolation under ~/.weaver/projects/.
 */
export function hashDir(dir: string): string {
  return crypto.createHash('sha256').update(dir).digest('hex').slice(0, 8);
}

/**
 * Resolve the weaver working directory.
 * Priority: explicit > WEAVER_QUEUE_DIR > WEAVER_STEERING_DIR > project-scoped > global fallback.
 */
export function resolveWeaverDir(explicit?: string): string {
  return explicit
    ?? process.env.WEAVER_QUEUE_DIR
    ?? process.env.WEAVER_STEERING_DIR
    ?? (process.env.WEAVER_PROJECT_DIR
      ? path.join(os.homedir(), '.weaver', 'projects', hashDir(process.env.WEAVER_PROJECT_DIR))
      : path.join(os.homedir(), '.weaver'));
}
