/**
 * Path safety utilities.
 *
 * Prevents path traversal attacks and ensures file operations stay within
 * expected boundaries. Critical for any code that constructs paths from
 * user input, AI output, or external configuration.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Validate that a relative path does not escape the base directory.
 * Returns the resolved absolute path if safe, or null if the path
 * attempts traversal. Also resolves symlinks to prevent bypass attacks.
 */
export function safePath(baseDir: string, relativePath: string): string | null {
  const normalized = path.normalize(relativePath);

  // Reject absolute paths and explicit traversal
  if (path.isAbsolute(normalized)) return null;
  if (normalized.startsWith('..')) return null;

  const resolved = path.resolve(baseDir, normalized);
  const resolvedBase = path.resolve(baseDir);

  // Ensure resolved path is within baseDir
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
    return null;
  }

  // Symlink protection: walk up to find deepest existing segment and
  // verify its real path stays within the base directory.
  let checkPath = resolved;
  while (!fs.existsSync(checkPath) && checkPath !== resolvedBase) {
    checkPath = path.dirname(checkPath);
  }
  if (fs.existsSync(checkPath)) {
    try {
      const realPath = fs.realpathSync(checkPath);
      const realBase = fs.realpathSync(resolvedBase);
      if (!realPath.startsWith(realBase + path.sep) && realPath !== realBase) {
        return null;
      }
    } catch {
      return null; // Can't verify safety, reject
    }
  }

  return resolved;
}

/**
 * Validate and resolve a path, throwing a descriptive error on traversal.
 */
export function safePathOrThrow(baseDir: string, relativePath: string, context?: string): string {
  const resolved = safePath(baseDir, relativePath);
  if (resolved === null) {
    const prefix = context ? `${context}: ` : '';
    throw new Error(`${prefix}Unsafe file path rejected: "${relativePath}"`);
  }
  return resolved;
}
