import { execFileSync } from 'node:child_process';
import type { WeaverEnv } from '../bot/types.js';

/**
 * Git operations on created/modified files: stage, commit, branch.
 * Runs in parallel with notifications after execution.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Git Operations
 * @input env [order:0] - Weaver environment bundle
 * @input filesModified [order:1] - Files modified (JSON array)
 * @output env [order:0] - Weaver environment bundle (pass-through)
 * @output gitResultJson [order:1] - Git operation result (JSON)
 */
export function weaverGitOps(
  env: WeaverEnv,
  filesModified: string,
): { env: WeaverEnv; gitResultJson: string } {
  const { projectDir, config } = env;
  const files: string[] = JSON.parse(filesModified);
  const gitConfig = (config as unknown as { git?: { enabled?: boolean; branch?: string; commitPrefix?: string } }).git ?? {};

  if (gitConfig.enabled === false || files.length === 0) {
    return { env, gitResultJson: JSON.stringify({ skipped: true, reason: files.length === 0 ? 'no files' : 'git disabled' }) };
  }

  // Check if we're in a git repo
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return { env, gitResultJson: JSON.stringify({ skipped: true, reason: 'not a git repo' }) };
  }

  const results: string[] = [];

  // Create branch if specified
  if (gitConfig.branch) {
    try {
      execFileSync('git', ['checkout', '-b', gitConfig.branch], { cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      results.push(`Created branch: ${gitConfig.branch}`);
    } catch {
      // Branch may already exist
      try {
        execFileSync('git', ['checkout', gitConfig.branch], { cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        results.push(`Switched to branch: ${gitConfig.branch}`);
      } catch { /* ignore */ }
    }
  }

  // Stage files
  for (const file of files) {
    try {
      execFileSync('git', ['add', file], { cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { /* ignore unstaged files */ }
  }

  // Commit
  const prefix = gitConfig.commitPrefix ?? 'weaver:';
  const commitMsg = `${prefix} bot task (${files.length} file${files.length === 1 ? '' : 's'})`;
  try {
    execFileSync('git', ['commit', '-m', commitMsg], { cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    results.push(`Committed: ${commitMsg}`);
    console.log(`\x1b[36m→ Git: ${commitMsg}\x1b[0m`);
  } catch {
    results.push('Nothing to commit');
  }

  return { env, gitResultJson: JSON.stringify({ skipped: false, results }) };
}
