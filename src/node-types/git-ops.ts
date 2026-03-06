import { execFileSync, execSync } from 'node:child_process';

/**
 * Git operations on created/modified files: stage, commit, branch.
 * Runs in parallel with notifications after execution.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Git Operations
 * @input projectDir [order:0] - Project root directory
 * @input filesModified [order:1] - Files modified (JSON array)
 * @input config [order:2] - Config (JSON)
 * @output projectDir [order:0] - Project root directory (pass-through)
 * @output gitResultJson [order:1] - Git operation result (JSON)
 */
export function weaverGitOps(
  projectDir: string,
  filesModified: string,
  config: string,
): { projectDir: string; gitResultJson: string } {
  const files: string[] = JSON.parse(filesModified);
  const cfg = JSON.parse(config) as { git?: { enabled?: boolean; branch?: string; commitPrefix?: string } };
  const gitConfig = cfg.git ?? {};

  if (gitConfig.enabled === false || files.length === 0) {
    return { projectDir, gitResultJson: JSON.stringify({ skipped: true, reason: files.length === 0 ? 'no files' : 'git disabled' }) };
  }

  // Check if we're in a git repo
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return { projectDir, gitResultJson: JSON.stringify({ skipped: true, reason: 'not a git repo' }) };
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

  return { projectDir, gitResultJson: JSON.stringify({ skipped: false, results }) };
}
