import { execFileSync } from 'node:child_process';
import type { WeaverContext } from '../bot/types.js';
import { auditEmit } from '../bot/audit-logger.js';

/**
 * Git operations on created/modified files: stage, commit, branch.
 * Runs in parallel with notifications after execution.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Git Operations
 * @input ctx [order:0] - Weaver context (JSON)
 * @output ctx [order:0] - Weaver context with gitResultJson (JSON)
 * @output onFailure [hidden]
 */
export function weaverGitOps(ctx: string): { ctx: string } {
  const context = JSON.parse(ctx) as WeaverContext;
  const { projectDir, config } = context.env;
  const files: string[] = context.filesModified ? JSON.parse(context.filesModified) : [];
  const gitConfig = (config as unknown as { git?: { enabled?: boolean; branch?: string; commitPrefix?: string } }).git ?? {};

  if (gitConfig.enabled === false || files.length === 0) {
    context.gitResultJson = JSON.stringify({ skipped: true, reason: files.length === 0 ? 'no files' : 'git disabled' });
    return { ctx: JSON.stringify(context) };
  }

  // Check if we're in a git repo
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    context.gitResultJson = JSON.stringify({ skipped: true, reason: 'not a git repo' });
    return { ctx: JSON.stringify(context) };
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

  auditEmit('git-operation', { branch: gitConfig.branch, filesCount: files.length, results });
  context.gitResultJson = JSON.stringify({ skipped: false, results });
  return { ctx: JSON.stringify(context) };
}
