/**
 * Improve Loop — autonomous codebase improvement via git worktree.
 *
 * Creates an isolated worktree, runs the insight engine to find issues,
 * generates tasks, executes them through the assistant, verifies with tests,
 * and commits or rolls back. The user's working directory is never touched.
 *
 * Usage: `weaver improve [--max-cycles 20] [--max-failures 3] [--protected "*.config.*"]`
 *
 * General-purpose: works on any project. We dogfood it on ourselves.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { c } from './ansi.js';

export interface ImproveConfig {
  maxCycles: number;  // 0 = unlimited, runs until stopped or nothing left to improve
  maxConsecutiveFailures: number;
  protectedPatterns: string[];
  testCommand: string;
  buildCommand?: string;
  projectDir: string;
}

export interface ImproveCycleResult {
  cycle: number;
  outcome: 'success' | 'failure' | 'skip' | 'blocked';
  description: string;
  filesChanged: string[];
  commitHash?: string;
  error?: string;
}

export interface ImproveResult {
  totalCycles: number;
  successes: number;
  failures: number;
  skips: number;
  blocked: number;
  cycles: ImproveCycleResult[];
  startedAt: string;
  finishedAt: string;
  branch: string;
  worktreePath: string;
  reason: 'complete' | 'max-cycles' | 'max-failures' | 'nothing-to-improve';
}

const DEFAULT_PROTECTED = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  '*.config.*',
  '.weaver.json',
  '.genesis/**',
];

export async function runImproveLoop(config: ImproveConfig): Promise<ImproveResult> {
  const { maxCycles, maxConsecutiveFailures, protectedPatterns, testCommand, buildCommand, projectDir } = config;
  const out = (s: string) => process.stderr.write(s);
  const cycles: ImproveCycleResult[] = [];
  let consecutiveFailures = 0;
  let conversationId = '';
  const startedAt = new Date().toISOString();
  const branchName = `weaver/improve-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
  const worktreeDir = path.join(projectDir, '.weaver-improve', branchName.replace(/\//g, '-'));

  // Prevent sleep on macOS
  let caffeinate: import('node:child_process').ChildProcess | null = null;
  try {
    if (process.platform === 'darwin') {
      const { spawn } = await import('node:child_process');
      caffeinate = spawn('caffeinate', ['-i', '-s'], { stdio: 'ignore', detached: true });
      caffeinate.unref();
    }
  } catch { /* caffeinate not available */ }

  out(`\n  ${c.bold('weaver improve')}\n`);
  out(`  ${c.dim(`Project: ${path.basename(projectDir)}`)}\n`);
  out(`  ${c.dim(`Branch: ${branchName}`)}\n`);
  out(`  ${c.dim(`Worktree: ${path.relative(projectDir, worktreeDir)}`)}\n`);
  out(`  ${c.dim(`Max cycles: ${maxCycles === 0 ? 'unlimited' : maxCycles}, stop after ${maxConsecutiveFailures} consecutive failures`)}\n`);
  out(`  ${c.dim(`Test: ${testCommand}`)}\n`);
  if (caffeinate) out(`  ${c.dim('Sleep inhibited (caffeinate)')}\n`);
  out('\n');

  // Check clean working tree
  try {
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: projectDir, encoding: 'utf-8' }).trim();
    if (status) {
      out(`  ${c.red('✗')} Working tree has uncommitted changes. Commit or stash first.\n`);
      return emptyResult(startedAt, branchName, worktreeDir, 'complete');
    }
  } catch {
    out(`  ${c.red('✗')} Not a git repository.\n`);
    return emptyResult(startedAt, branchName, worktreeDir, 'complete');
  }

  // Create worktree
  out(`  ${c.dim('Creating worktree...')}\n`);
  try {
    fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });
    execFileSync('git', ['worktree', 'add', worktreeDir, '-b', branchName], { cwd: projectDir, stdio: 'pipe' });
  } catch {
    // Branch might already exist — try without -b
    try {
      execFileSync('git', ['worktree', 'add', worktreeDir, branchName], { cwd: projectDir, stdio: 'pipe' });
    } catch (err) {
      out(`  ${c.red('✗')} Failed to create worktree: ${err instanceof Error ? err.message : err}\n`);
      return emptyResult(startedAt, branchName, worktreeDir, 'complete');
    }
  }

  // Install deps in worktree if needed
  const worktreeNodeModules = path.join(worktreeDir, 'node_modules');
  if (!fs.existsSync(worktreeNodeModules)) {
    // Symlink node_modules from main tree for speed
    try {
      const mainNodeModules = path.join(projectDir, 'node_modules');
      if (fs.existsSync(mainNodeModules)) {
        fs.symlinkSync(mainNodeModules, worktreeNodeModules);
        out(`  ${c.dim('Linked node_modules from main tree')}\n`);
      }
    } catch { /* will need npm install */ }
  }

  // Build in worktree if needed
  if (buildCommand) {
    out(`  ${c.dim('Building in worktree...')}\n`);
    try {
      execFileSync('sh', ['-c', buildCommand], { cwd: worktreeDir, stdio: 'pipe', timeout: 120_000 });
    } catch {
      out(`  ${c.red('✗')} Build failed in worktree — aborting.\n`);
      cleanup(projectDir, worktreeDir);
      return emptyResult(startedAt, branchName, worktreeDir, 'complete');
    }
  }

  // Baseline test in worktree
  out(`  ${c.dim('Running baseline tests in worktree...')}\n`);
  try {
    execFileSync('sh', ['-c', testCommand], { cwd: worktreeDir, stdio: 'pipe', timeout: 300_000 });
    out(`  ${c.green('✓')} Baseline tests pass\n\n`);
  } catch {
    out(`  ${c.red('✗')} Baseline tests FAIL in worktree — fix them first.\n`);
    cleanup(projectDir, worktreeDir);
    return emptyResult(startedAt, branchName, worktreeDir, 'complete');
  }

  // Main loop
  for (let cycle = 1; maxCycles === 0 || cycle <= maxCycles; cycle++) {
    if (consecutiveFailures >= maxConsecutiveFailures) {
      out(`  ${c.yellow('⚠')} Stopping: ${maxConsecutiveFailures} consecutive failures.\n`);
      break;
    }

    out(`  ${c.bold(`--- Cycle ${cycle}/${maxCycles} ---`)}\n`);

    // Step 1: Discover — guided by .weaver-plan.md if it exists
    let planContext = '';
    try {
      const planPath = path.join(worktreeDir, '.weaver-plan.md');
      if (fs.existsSync(planPath)) {
        planContext = `\n\nIMPORTANT: All improvements MUST align with the project plan in .weaver-plan.md. Do NOT work on things outside the plan's scope. If the plan specifies priorities, follow them.`;
      }
    } catch { /* no plan */ }

    const discoverMsg = `Look at this project and find ONE specific, small improvement. Focus on: untested code, missing error handling, reliability gaps, or code quality issues. Pick something concrete (1-3 files max). Tell me what you found and which files — do NOT fix it yet.${planContext}`;

    let discovery = '';
    try {
      const raw = await withTimeout(runAssistantInDir(worktreeDir, discoverMsg, conversationId), 180_000);
      const parsed = JSON.parse(raw);
      conversationId = String(parsed.conversationId ?? conversationId);
      discovery = String(parsed.response ?? '');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      out(`    ${c.dim(`Skip: ${msg.includes('timeout') ? 'timed out (3min)' : 'assistant did not respond'}`)}\n`);
      cycles.push({ cycle, outcome: 'skip', description: msg.includes('timeout') ? 'Timed out' : 'No response', filesChanged: [] });
      consecutiveFailures++;
      continue;
    }

    out(`    ${c.dim('Found:')} ${discovery.split('\n')[0]?.slice(0, 80)}\n`);

    if (/nothing|no issues|all good|can.t find|couldn.t find|clean bill|no .* to improve/i.test(discovery)) {
      out(`    ${c.green('✓')} Nothing more to improve.\n`);
      cycles.push({ cycle, outcome: 'skip', description: 'Nothing to improve', filesChanged: [] });
      break;
    }

    // Step 2: Fix
    const fixMsg = 'Fix it now. Use write_file to create the test file and patch_file to modify existing code. Write failing tests first, then implement the minimal fix. Run the tests with run_tests to verify. Keep changes small — 1-3 files max.';
    try {
      const fixRaw = await withTimeout(runAssistantInDir(worktreeDir, fixMsg, conversationId), 180_000);
      const fixParsed = JSON.parse(fixRaw);
      conversationId = String(fixParsed.conversationId ?? conversationId);
    } catch {
      out(`    ${c.dim('Skip: fix failed or timed out')}\n`);
      rollback(worktreeDir);
      cycles.push({ cycle, outcome: 'skip', description: 'Fix failed', filesChanged: [] });
      consecutiveFailures++;
      continue;
    }

    // Step 3: Check changes
    const changedFiles = getChangedFiles(worktreeDir);
    if (changedFiles.length === 0) {
      out(`    ${c.dim('Skip: no files changed')}\n`);
      cycles.push({ cycle, outcome: 'skip', description: 'No changes', filesChanged: [] });
      continue;
    }

    // Step 4: Protected files
    const blocked = changedFiles.find(f => isProtected(f, protectedPatterns));
    if (blocked) {
      out(`    ${c.yellow('⚠')} Blocked: modified protected file ${blocked}\n`);
      rollback(worktreeDir);
      cycles.push({ cycle, outcome: 'blocked', description: `Protected file: ${blocked}`, filesChanged: changedFiles });
      continue;
    }

    // Step 5: Build
    if (buildCommand) {
      try {
        execFileSync('sh', ['-c', buildCommand], { cwd: worktreeDir, stdio: 'pipe', timeout: 120_000 });
      } catch {
        out(`    ${c.red('✗')} Build failed — rollback\n`);
        rollback(worktreeDir);
        cycles.push({ cycle, outcome: 'failure', description: 'Build failed', filesChanged: changedFiles });
        consecutiveFailures++;
        continue;
      }
    }

    // Step 6: Test
    out(`    ${c.dim('Testing...')}\n`);
    try {
      execFileSync('sh', ['-c', testCommand], { cwd: worktreeDir, stdio: 'pipe', timeout: 300_000 });
    } catch {
      out(`    ${c.red('✗')} Tests failed — rollback\n`);
      rollback(worktreeDir);
      cycles.push({ cycle, outcome: 'failure', description: 'Tests failed', filesChanged: changedFiles });
      consecutiveFailures++;
      continue;
    }

    // Step 7: Commit in worktree (exclude symlinks and node_modules)
    // Filter staged files to only include actual code changes
    // Extract a meaningful commit message from the discovery response
    const commitDescription = discovery
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !/^(here'?s|let me|i found|i'?ll|looking|checking|reading|good|now)/i.test(l))
      .map(l => l.replace(/^\*\*|^\d+\.\s*|\*\*$/g, '').trim()) // strip markdown bold, numbered lists
      .filter(l => l.length > 10) // skip short fragments
      .slice(0, 1)
      .join('')
      .slice(0, 70) || 'code improvement';
    const commitMsg = `[improve] ${commitDescription}`;
    try {
      // Stage only tracked/changed files, exclude node_modules and symlinks
      execFileSync('git', ['add', '-A', '--', '.', ':!node_modules'], { cwd: worktreeDir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', `${commitMsg}\n\nCo-authored-by: Weaver Assistant <weaver@synergenius.dev>`], { cwd: worktreeDir, stdio: 'pipe' });
      const hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: worktreeDir, encoding: 'utf-8' }).trim();
      out(`    ${c.green('✓')} ${c.dim(hash)} ${commitMsg}\n\n`);
      cycles.push({ cycle, outcome: 'success', description: discovery.split('\n')[0]!, filesChanged: changedFiles, commitHash: hash });
      consecutiveFailures = 0;
    } catch {
      out(`    ${c.red('✗')} Commit failed\n`);
      rollback(worktreeDir);
      cycles.push({ cycle, outcome: 'failure', description: 'Commit failed', filesChanged: changedFiles });
      consecutiveFailures++;
    }
  }

  const result: ImproveResult = {
    totalCycles: cycles.length,
    successes: cycles.filter(cy => cy.outcome === 'success').length,
    failures: cycles.filter(cy => cy.outcome === 'failure').length,
    skips: cycles.filter(cy => cy.outcome === 'skip').length,
    blocked: cycles.filter(cy => cy.outcome === 'blocked').length,
    cycles,
    startedAt,
    finishedAt: new Date().toISOString(),
    branch: branchName,
    worktreePath: worktreeDir,
    reason: consecutiveFailures >= maxConsecutiveFailures ? 'max-failures'
      : cycles.some(cy => cy.description === 'Nothing to improve') ? 'nothing-to-improve'
      : 'max-cycles',
  };

  // Release sleep inhibitor
  if (caffeinate) {
    try { caffeinate.kill(); } catch { /* already dead */ }
  }

  // Summary
  out(`\n  ${c.bold('=== Improve Complete ===')}\n`);
  out(`  ${result.successes} committed, ${result.failures} rolled back, ${result.skips} skipped, ${result.blocked} blocked\n`);
  out(`  Branch: ${c.cyan(branchName)}\n`);
  if (result.successes > 0) {
    out(`\n  ${c.bold('Commits:')}\n`);
    for (const cy of cycles.filter(cy => cy.outcome === 'success')) {
      out(`    ${c.green(cy.commitHash!)} ${cy.description}\n`);
    }
    out(`\n  Review: ${c.cyan(`git log main..${branchName}`)}\n`);
    out(`  Merge:  ${c.cyan(`git merge ${branchName}`)}\n`);
  }
  if (result.successes === 0) {
    out(`\n  No changes made. Cleaning up worktree.\n`);
    cleanup(projectDir, worktreeDir);
  } else {
    out(`\n  ${c.dim(`Worktree kept at: ${path.relative(projectDir, worktreeDir)}`)}\n`);
    out(`  ${c.dim(`Clean up: git worktree remove ${path.relative(projectDir, worktreeDir)}`)}\n`);
  }
  out('\n');

  // Persist summary
  try {
    const summaryDir = path.join(os.homedir(), '.weaver', 'improve');
    fs.mkdirSync(summaryDir, { recursive: true });
    fs.writeFileSync(
      path.join(summaryDir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
      JSON.stringify(result, null, 2), 'utf-8',
    );
  } catch { /* non-fatal */ }

  return result;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

function emptyResult(startedAt: string, branch: string, worktreePath: string, reason: ImproveResult['reason']): ImproveResult {
  return { totalCycles: 0, successes: 0, failures: 0, skips: 0, blocked: 0, cycles: [], startedAt, finishedAt: new Date().toISOString(), branch, worktreePath, reason };
}

// --- Helpers ---

async function runAssistantInDir(worktreeDir: string, message: string, conversationId: string): Promise<string> {
  const args = ['--debug', '--project-dir', worktreeDir];
  if (conversationId) args.push('--resume', conversationId);
  args.push('-m', message);

  const { handleCommand } = await import('../cli-bridge.js');

  // Change cwd to worktree so the Claude CLI provider's subprocess
  // runs in the right directory (its built-in tools use cwd)
  const originalCwd = process.cwd();
  process.chdir(worktreeDir);

  // Capture stdout (debug JSON) but let it also pass through for visibility
  let output = '';
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Buffer) => {
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    output += str;
    // Pass through so the user sees what's happening
    process.stderr.write(`    ${str}`);
    return true;
  }) as typeof process.stdout.write;

  try {
    await handleCommand('assistant', args);
  } finally {
    process.stdout.write = originalWrite;
    process.chdir(originalCwd);
  }

  const lines = output.trim().split('\n').filter(Boolean);
  return lines[lines.length - 1] ?? '{}';
}

function getChangedFiles(dir: string): string[] {
  try {
    const modified = execFileSync('git', ['diff', '--name-only'], { cwd: dir, encoding: 'utf-8' }).trim();
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: dir, encoding: 'utf-8' }).trim();
    return [...modified.split('\n'), ...untracked.split('\n')]
      .filter(Boolean)
      .filter(f => !f.startsWith('node_modules') && !f.includes('/node_modules/'));
  } catch { return []; }
}

function rollback(dir: string): void {
  try {
    execFileSync('git', ['checkout', '.'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['clean', '-fd'], { cwd: dir, stdio: 'pipe' });
  } catch { /* best effort */ }
}

function cleanup(projectDir: string, worktreeDir: string): void {
  try {
    execFileSync('git', ['worktree', 'remove', worktreeDir, '--force'], { cwd: projectDir, stdio: 'pipe' });
  } catch { /* best effort */ }
  try {
    // Remove empty parent dir
    const parent = path.dirname(worktreeDir);
    if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
      fs.rmdirSync(parent);
    }
  } catch { /* best effort */ }
}

function isProtected(file: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    const regex = new RegExp(
      '^' + pattern
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '{{DS}}')
        .replace(/\*/g, '[^/]*')
        .replace(/\{\{DS\}\}/g, '.*')
      + '$',
    );
    if (regex.test(file)) return true;
  }
  return false;
}

export { DEFAULT_PROTECTED };
