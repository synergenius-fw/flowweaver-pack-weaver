import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import type { WeaverContext } from '../bot/types.js';
import { auditEmit } from '../bot/audit-logger.js';

/**
 * Review staged diff for suspicious changes before committing.
 * Returns an array of issues found (empty = safe to commit).
 */
function reviewStagedDiff(cwd: string): string[] {
  const issues: string[] = [];

  try {
    const diff = execFileSync('git', ['diff', '--cached', '--stat'], { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (!diff) return issues;

    // Check for large deletions (file became empty or nearly empty)
    const numstat = execFileSync('git', ['diff', '--cached', '--numstat'], { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    for (const line of numstat.split('\n').filter(Boolean)) {
      const [added, deleted, file] = line.split('\t');
      if (!file || !added || !deleted) continue;
      const addedN = parseInt(added, 10) || 0;
      const deletedN = parseInt(deleted, 10) || 0;

      // Flag: file lost >80% of its content with minimal additions
      if (deletedN > 50 && addedN < 5 && deletedN > addedN * 10) {
        issues.push(`${file}: deleted ${deletedN} lines, added only ${addedN} (possible truncation)`);
      }

      // Flag: file became empty (0 additions, all deletions)
      if (addedN === 0 && deletedN > 10) {
        issues.push(`${file}: file emptied (${deletedN} lines deleted, 0 added)`);
      }
    }

    // Check for sensitive patterns in added lines
    const patchDiff = execFileSync('git', ['diff', '--cached', '-U0'], { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    const sensitivePatterns = [
      /api[_-]?key\s*[:=]\s*["'][^"']{20,}/i,
      /secret\s*[:=]\s*["'][^"']{10,}/i,
      /password\s*[:=]\s*["'][^"']{5,}/i,
    ];
    for (const line of patchDiff.split('\n')) {
      if (!line.startsWith('+') || line.startsWith('+++')) continue;
      for (const pattern of sensitivePatterns) {
        if (pattern.test(line)) {
          issues.push('Possible credential/secret in staged changes');
          return issues; // One is enough to block
        }
      }
    }
  } catch (err) {
    // If diff commands fail, don't block — let commit proceed
    if (process.env.WEAVER_VERBOSE) console.error('[git-ops] diff review failed:', err);
  }

  return issues;
}

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

  // Get actually-changed files from git (avoids phantom commits)
  let changedFiles: Set<string>;
  try {
    const diff = execFileSync('git', ['diff', '--name-only'], { cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    changedFiles = new Set([...diff.split('\n'), ...untracked.split('\n')].filter(Boolean));
  } catch (err) {
    if (process.env.WEAVER_VERBOSE) console.error('[git-ops] git diff failed, using filesModified fallback:', err);
    changedFiles = new Set(files); // fallback: trust filesModified
  }

  // Stage only files that are both in filesModified AND actually changed
  let staged = 0;
  for (const file of files) {
    // Resolve to relative path for comparison
    const relative = path.relative(projectDir, path.resolve(projectDir, file));
    if (!changedFiles.has(relative) && !changedFiles.has(file)) continue;
    try {
      execFileSync('git', ['add', file], { cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      staged++;
    } catch { /* ignore unstaged files */ }
  }

  if (staged === 0) {
    results.push('No actual changes to commit');
    auditEmit('git-operation', { branch: gitConfig.branch, filesCount: 0, results });
    context.gitResultJson = JSON.stringify({ skipped: true, reason: 'no actual changes', results });
    return { ctx: JSON.stringify(context) };
  }

  // Diff review: check for suspicious changes before committing
  const diffIssues = reviewStagedDiff(projectDir);
  if (diffIssues.length > 0) {
    // Unstage and skip commit — something looks wrong
    try { execFileSync('git', ['reset', 'HEAD'], { cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }); } catch (err) { if (process.env.WEAVER_VERBOSE) console.error('[git-ops] reset failed:', err); }
    results.push(`Commit blocked: ${diffIssues.join('; ')}`);
    auditEmit('git-operation', { branch: gitConfig.branch, filesCount: 0, results, blocked: true });
    context.gitResultJson = JSON.stringify({ skipped: true, reason: 'diff review failed', issues: diffIssues, results });
    return { ctx: JSON.stringify(context) };
  }

  // Commit
  const prefix = gitConfig.commitPrefix ?? 'weaver:';
  const commitMsg = `${prefix} bot task (${staged} file${staged === 1 ? '' : 's'})`;
  try {
    execFileSync('git', ['commit', '-m', commitMsg], { cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    results.push(`Committed: ${commitMsg}`);
    if (process.env.WEAVER_VERBOSE) process.stderr.write(`\x1b[2m  Git: ${commitMsg}\x1b[0m\n`);
  } catch {
    results.push('Nothing to commit');
  }

  auditEmit('git-operation', { branch: gitConfig.branch, filesCount: staged, results });
  context.gitResultJson = JSON.stringify({ skipped: false, results });
  return { ctx: JSON.stringify(context) };
}
