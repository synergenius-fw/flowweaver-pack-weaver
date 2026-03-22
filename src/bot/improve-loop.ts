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
  /** Optional device connection for streaming events to Studio */
  deviceConnection?: import('@synergenius/flow-weaver/agent').DeviceConnection;
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
  const { maxCycles, maxConsecutiveFailures, protectedPatterns, testCommand, buildCommand, projectDir, deviceConnection } = config;
  const out = (s: string) => process.stderr.write(s);
  const emitEvent = (type: string, data: Record<string, unknown> = {}) => {
    deviceConnection?.emit({ type, data, timestamp: Date.now() });
  };
  const cycles: ImproveCycleResult[] = [];
  let consecutiveFailures = 0;
  const completedWork: string[] = []; // track what's been done so it doesn't repeat
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

  // Verify this is a git repo (worktree requires it)
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: projectDir, stdio: 'pipe' });
  } catch {
    out(`  ${c.red('✗')} Not a git repository.\n`);
    return emptyResult(startedAt, branchName, worktreeDir, 'complete');
  }

  // Create worktree (clean up stale ones first)
  out(`  ${c.dim('Creating worktree...')}\n`);
  try {
    // Remove stale worktree/branch from previous runs
    if (fs.existsSync(worktreeDir)) {
      try { execFileSync('git', ['worktree', 'remove', worktreeDir, '--force'], { cwd: projectDir, stdio: 'pipe' }); } catch { /* best effort */ }
      if (fs.existsSync(worktreeDir)) fs.rmSync(worktreeDir, { recursive: true, force: true });
    }
    try { execFileSync('git', ['branch', '-D', branchName], { cwd: projectDir, stdio: 'pipe' }); } catch { /* branch may not exist */ }
    execFileSync('git', ['worktree', 'prune'], { cwd: projectDir, stdio: 'pipe' });

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

  // Ensure node_modules is gitignored in worktree (symlink shouldn't be committed)
  try {
    const wtGitignore = path.join(worktreeDir, '.gitignore');
    const existing = fs.existsSync(wtGitignore) ? fs.readFileSync(wtGitignore, 'utf-8') : '';
    if (!existing.includes('node_modules')) {
      fs.appendFileSync(wtGitignore, '\nnode_modules/\n');
    }
  } catch { /* non-fatal */ }

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

  // Baseline test — run in worktree to establish the failure count
  // Some projects have flaky tests or env-dependent failures in worktrees
  out(`  ${c.dim('Running baseline tests...')}\n`);
  let baselineFailCount = 0;
  try {
    execFileSync('sh', ['-c', testCommand], { cwd: worktreeDir, stdio: 'pipe', timeout: 300_000 });
    out(`  ${c.green('✓')} Baseline tests pass\n\n`);
  } catch (err) {
    // Count failures and extract names from vitest output
    const output = (err as { stderr?: Buffer; stdout?: Buffer }).stdout?.toString() ?? '';
    const stderrOutput = (err as { stderr?: Buffer }).stderr?.toString() ?? '';
    const failMatch = output.match(/(\d+) failed/);
    baselineFailCount = failMatch ? parseInt(failMatch[1]!, 10) : 0;

    // Extract failing test file names for diagnostics
    const failedFiles = (output + stderrOutput).match(/FAIL\s+\S+/g)?.slice(0, 10) ?? [];

    if (baselineFailCount <= 5) {
      out(`  ${c.yellow('⚠')} Baseline: ${baselineFailCount} pre-existing failure(s) — will tolerate these\n`);
      if (failedFiles.length > 0) {
        for (const f of failedFiles) out(`    ${c.dim(f)}\n`);
      }
      out('\n');
    } else {
      out(`  ${c.red('✗')} Baseline: ${baselineFailCount} failures — too many, fix them first.\n`);
      if (failedFiles.length > 0) {
        for (const f of failedFiles) out(`    ${c.dim(f)}\n`);
      }
      cleanup(projectDir, worktreeDir);
      return emptyResult(startedAt, branchName, worktreeDir, 'complete');
    }
  }

  // Load steering configuration
  const { SteeringEngine, loadSteers, IMPROVE_STEERS } = await import('./steering-engine.js');
  const steers = loadSteers(projectDir, IMPROVE_STEERS);

  // Main loop
  for (let cycle = 1; maxCycles === 0 || cycle <= maxCycles; cycle++) {
    if (consecutiveFailures >= maxConsecutiveFailures) {
      out(`  ${c.yellow('⚠')} Stopping: ${maxConsecutiveFailures} consecutive failures.\n`);
      break;
    }

    out(`  ${c.bold(`--- Cycle ${cycle}/${maxCycles === 0 ? '∞' : maxCycles} ---`)}\n`);
    emitEvent('improve:cycle_start', { cycle, maxCycles });

    const cycleEngine = new SteeringEngine(steers);

    // Record HEAD at cycle start to detect if assistant commits during its turn
    let headAtCycleStart = '';
    try {
      headAtCycleStart = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreeDir, encoding: 'utf-8' }).trim();
    } catch { /* not a git repo? */ }

    // Build context: read the plan and extract top priority
    let planContext = '';
    try {
      const planPath = path.join(worktreeDir, '.weaver-plan.md');
      if (fs.existsSync(planPath)) {
        const planContent = fs.readFileSync(planPath, 'utf-8');
        // Extract the first priority section (### 0. or ### 1.)
        const priorityMatch = planContent.match(/### 0\.[^\n]*\n([\s\S]*?)(?=\n### \d|$)/);
        if (priorityMatch) {
          planContext = `\n\nTOP PRIORITY FROM PROJECT PLAN — you MUST work on this:\n${priorityMatch[0].trim()}\n\nDo NOT work on anything else until the top priority is complete.`;
        } else {
          // Fall back to the full priorities section
          const prioritiesMatch = planContent.match(/## Current Priorities[\s\S]*?(?=\n## [A-Z]|$)/);
          if (prioritiesMatch) {
            planContext = `\n\nPROJECT PLAN PRIORITIES:\n${prioritiesMatch[0].slice(0, 1500)}`;
          }
        }
      }
    } catch { /* no plan */ }

    const workLog = completedWork.length > 0
      ? `\nALREADY DONE (do NOT repeat): ${completedWork.join('; ')}`
      : '';

    // Step 1: Find and fix in one turn
    const improveMsg = `You are working in: ${worktreeDir}

Work on the TOP PRIORITY from the project plan. If no specific priority, find ONE small improvement. Steps:
1. Recall what you know: knowledge_search "project"
2. Read .weaver-plan.md to understand the top priority
3. Do exactly what the top priority says — one handler migration, one fix, one concrete step
4. Write a failing test first, then implement
5. Run tests to verify
4. Run tests with run_tests to verify
5. Store any insights with learn()

Keep changes to 1-3 files. All paths relative to ${worktreeDir}.${planContext}${workLog}`;

    let conversationId = '';
    let discovery = '';
    try {
      const raw = await runAssistantInDir(worktreeDir, improveMsg, '', cycleEngine);
      const parsed = JSON.parse(raw);
      conversationId = String(parsed.conversationId ?? '');
      discovery = String(parsed.response ?? '');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      out(`    ${c.dim(`Skip: ${msg.includes('timeout') ? 'timed out' : 'no response'}`)}\n`);
      rollback(worktreeDir);
      cycles.push({ cycle, outcome: 'skip', description: msg.includes('timeout') ? 'Timed out' : 'No response', filesChanged: [] });
      continue;
    }

    out(`    ${c.dim('Done:')} ${discovery.split('\n')[0]?.slice(0, 80)}\n`);

    // Check steering engine after initial assistant call
    {
      const steerMsg = cycleEngine.check();
      if (steerMsg) {
        out(`    ${c.dim(steerMsg.replace(/\[.*?\]\s*/g, ''))}\n`);
      }
      if (cycleEngine.hasHardStop()) {
        cycles.push({ cycle, outcome: 'skip', description: 'Hard stop from steering engine', filesChanged: [] });
        break;
      }
    }

    if (/^(nothing to improve|no issues found|all good|clean bill of health|i can.t find any|couldn.t find any|no improvements needed)/im.test(discovery)) {
      out(`    ${c.green('✓')} Nothing more to improve.\n`);
      cycles.push({ cycle, outcome: 'skip', description: 'Nothing to improve', filesChanged: [] });
      break;
    }

    // Step 2: Iterative test-fix loop (like a developer would)
    // Steering engine controls cycle duration — hard stop is the safety valve
    const cycleStart = Date.now();
    let testsPassing = false;
    let attempt = 0;

    while (!cycleEngine.hasHardStop()) {
      attempt++;
      const changedFiles = getChangedFiles(worktreeDir);
      if (changedFiles.length === 0) {
        out(`    ${c.dim('Skip: no files changed')}\n`);
        break;
      }

      // Check protected files
      const blocked = changedFiles.find(f => isProtected(f, protectedPatterns));
      if (blocked) {
        out(`    ${c.yellow('⚠')} Blocked: modified protected file ${blocked}\n`);
        break;
      }

      // Build if needed
      if (buildCommand) {
        try {
          execFileSync('sh', ['-c', buildCommand], { cwd: worktreeDir, stdio: 'pipe', timeout: 120_000 });
        } catch {
          out(`    ${c.red('✗')} Build failed (attempt ${attempt})\n`);
          if (cycleEngine.hasHardStop()) break;
          // Ask assistant to fix build errors
          try {
            const fixRaw = await runAssistantInDir(worktreeDir, `Build failed. Fix the build errors. You are working in: ${worktreeDir}`, conversationId, cycleEngine);
            const fixParsed = JSON.parse(fixRaw);
            conversationId = String(fixParsed.conversationId ?? conversationId);
          } catch { break; }
          continue;
        }
      }

      // Run tests
      out(`    ${c.dim(`Testing (attempt ${attempt})...`)}\n`);
      try {
        execFileSync('sh', ['-c', testCommand], { cwd: worktreeDir, stdio: 'pipe', timeout: 300_000 });
        cycleEngine.recordEvent('test_pass');
        testsPassing = true;
        break;
      } catch (testErr) {
        cycleEngine.recordEvent('test_fail');
        const testOutput = ((testErr as { stdout?: Buffer }).stdout?.toString() ?? '');
        const failMatch = testOutput.match(/(\d+) failed/);
        const newFailCount = failMatch ? parseInt(failMatch[1]!, 10) : 999;

        if (newFailCount <= baselineFailCount) {
          out(`    ${c.yellow('⚠')} Same pre-existing failures (${newFailCount}) — accepting\n`);
          testsPassing = true;
          break;
        }

        out(`    ${c.red('✗')} ${newFailCount} failures (${newFailCount - baselineFailCount} new)\n`);

        // Check steering engine for nudges
        {
          const steerMsg = cycleEngine.check();
          if (steerMsg) {
            out(`    ${c.dim(steerMsg.replace(/\[.*?\]\s*/g, ''))}\n`);
          }
        }

        const elapsed = Math.round((Date.now() - cycleStart) / 1000);
        if (cycleEngine.hasHardStop()) {
          out(`    ${c.red('✗')} Steering engine hard stop (${elapsed}s) — rollback\n`);
          break;
        }

        // Extract failing test names for the assistant
        const failedTests = testOutput.match(/FAIL .+/g)?.slice(0, 5).join('\n') ?? 'unknown failures';

        // Ask assistant to fix the test failures — same conversation, it has context
        out(`    ${c.dim(`Fixing failures (attempt ${attempt + 1})...`)}\n`);
        try {
          const fixMsg = `Tests failed with ${newFailCount - baselineFailCount} new failures. Fix them. You are working in: ${worktreeDir}

Failing tests:
${failedTests}

Fix the failures without reverting your improvement. If you can't fix them, revert only the parts that broke tests.`;
          const fixRaw = await runAssistantInDir(worktreeDir, fixMsg, conversationId, cycleEngine);
          const fixParsed = JSON.parse(fixRaw);
          conversationId = String(fixParsed.conversationId ?? conversationId);
        } catch {
          out(`    ${c.dim('Fix attempt timed out')}\n`);
          break;
        }
      }
    }

    // Check if the assistant already committed (the test_pass steer tells it to commit immediately)
    try {
      const headNow = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreeDir, encoding: 'utf-8' }).trim();
      if (headAtCycleStart && headNow !== headAtCycleStart) {
        // HEAD moved — assistant committed during its turn
        const newCommits = execFileSync('git', ['log', '--oneline', `${headAtCycleStart}..HEAD`], { cwd: worktreeDir, encoding: 'utf-8' }).trim();
        const commitHash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: worktreeDir, encoding: 'utf-8' }).trim();
        const commitMsg = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: worktreeDir, encoding: 'utf-8' }).trim();
        const commitCount = newCommits.split('\n').filter(Boolean).length;
        out(`    ${c.green('✓')} ${c.dim(commitHash)} (${commitCount} commit${commitCount > 1 ? 's' : ''} by assistant)\n\n`);
        emitEvent('improve:commit', { cycle, commitHash, description: commitMsg.slice(0, 70) });
        cycles.push({ cycle, outcome: 'success', description: commitMsg.slice(0, 70), filesChanged: [], commitHash });
        completedWork.push(commitMsg.slice(0, 80));
        consecutiveFailures = 0;
        continue;
      }
    } catch { /* git check failed — fall through to normal flow */ }

    if (!testsPassing) {
      // Record what was attempted so next cycle can learn from it
      const failSummary = discovery.split('\n').filter(l => l.trim()).slice(0, 2).join(' ').slice(0, 100);
      completedWork.push(`FAILED: ${failSummary} (tests broke, rolled back — try a different approach)`);
      rollback(worktreeDir);
      const elapsed = Math.round((Date.now() - cycleStart) / 1000);
      cycles.push({ cycle, outcome: 'failure', description: `Tests failed after ${attempt} attempts (${elapsed}s)`, filesChanged: getChangedFiles(worktreeDir) });
      consecutiveFailures++;
      continue;
    }

    // Step 7: Commit in worktree (exclude symlinks and node_modules)
    try {
      // Stage all changes
      execFileSync('git', ['add', '--all'], { cwd: worktreeDir, stdio: 'pipe' });

      // Check if there's actually anything staged
      const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: worktreeDir, encoding: 'utf-8' }).trim();
      if (!staged) {
        out(`    ${c.dim('Skip: assistant made no file changes')}\n\n`);
        cycles.push({ cycle, outcome: 'skip', description: 'No staged changes after fix', filesChanged: [] });
        continue;
      }

      // Build commit message from staged files + discovery text
      const stagedFiles = staged.split('\n').filter(Boolean);
      const srcFiles = stagedFiles.filter(f => f.startsWith('src/')).map(f => path.basename(f, '.ts'));
      const testFiles = stagedFiles.filter(f => f.startsWith('tests/') || f.includes('.test.'));
      const fileNames = srcFiles.length > 0 ? srcFiles.join(', ') : stagedFiles.map(f => path.basename(f, '.ts')).join(', ');

      const descLine = discovery
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 15)
        .filter(l => !/^(here|let me|i found|i'll|looking|checking|reading|good$|now |you are|step \d|important|first|use )/i.test(l))
        .map(l => l.replace(/^\*\*|^\d+\.\s*|\*\*$|^[-•]\s*/g, '').trim())
        .find(l => /test|cover|fix|add|miss|error|handl|improv|bug|reliab|word.bound/i.test(l)) ?? '';

      const commitDescription = descLine
        ? descLine.slice(0, 60)
        : testFiles.length > 0
          ? `add tests for ${fileNames}`.slice(0, 60)
          : `improve ${fileNames}`.slice(0, 60);
      const commitMsg = `[improve] ${commitDescription}`;

      execFileSync('git', ['commit', '-m', `${commitMsg}\n\nCo-authored-by: Weaver Assistant <weaver@synergenius.dev>`], { cwd: worktreeDir, stdio: 'pipe' });
      const hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: worktreeDir, encoding: 'utf-8' }).trim();
      out(`    ${c.green('✓')} ${c.dim(hash)} ${commitMsg}\n\n`);
      emitEvent('improve:commit', { cycle, commitHash: hash, description: commitDescription });
      cycles.push({ cycle, outcome: 'success', description: commitDescription, filesChanged: stagedFiles, commitHash: hash });
      completedWork.push(`${commitDescription} (${stagedFiles.join(', ')})`);
      consecutiveFailures = 0;
    } catch (err) {
      out(`    ${c.red('✗')} Commit failed: ${err instanceof Error ? err.message.split('\n')[0] : 'unknown'}\n`);
      rollback(worktreeDir);
      cycles.push({ cycle, outcome: 'failure', description: 'Commit failed', filesChanged: getChangedFiles(worktreeDir), error: String(err) });
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

  // Emit completion event
  emitEvent('improve:complete', { successes: cycles.filter(cy => cy.outcome === 'success').length, failures: cycles.filter(cy => cy.outcome === 'failure').length, totalCycles: cycles.length });

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

function emptyResult(startedAt: string, branch: string, worktreePath: string, reason: ImproveResult['reason']): ImproveResult {
  return { totalCycles: 0, successes: 0, failures: 0, skips: 0, blocked: 0, cycles: [], startedAt, finishedAt: new Date().toISOString(), branch, worktreePath, reason };
}

// --- Helpers ---

let cachedProvider: unknown = null;
let cachedTools: unknown[] = [];
let cachedExecutor: unknown = null;

async function runAssistantInDir(worktreeDir: string, message: string, _conversationId: string, steeringEngine?: import('./steering-engine.js').SteeringEngine): Promise<string> {
  const originalCwd = process.cwd();
  process.chdir(worktreeDir);

  try {
    // Reuse provider across cycles (keeps Claude CLI subprocess alive)
    if (!cachedProvider) {
      const agentMod = await import('@synergenius/flow-weaver/agent');
      const { ASSISTANT_TOOLS, createAssistantExecutor } = await import('./assistant-tools.js');
      cachedTools = ASSISTANT_TOOLS;
      cachedExecutor = createAssistantExecutor(worktreeDir, steeringEngine);

      if (process.env.ANTHROPIC_API_KEY) {
        cachedProvider = agentMod.createAnthropicProvider({
          apiKey: process.env.ANTHROPIC_API_KEY,
        });
      } else {
        // Disable Claude CLI's built-in file tools so it uses our MCP-bridged
        // tools which respect projectDir (critical for worktree isolation)
        cachedProvider = agentMod.createClaudeCliProvider({
          cwd: worktreeDir,
          disallowedTools: ['Read', 'Edit', 'Write', 'MultiEdit'],
        });
      }
    }

    const { runAgentLoop } = await import('@synergenius/flow-weaver/agent');

    let responseText = '';
    const toolCalls: Array<{ name: string; isError: boolean }> = [];

    const result = await runAgentLoop(
      cachedProvider as any,
      cachedTools as any,
      cachedExecutor as any,
      [{ role: 'user' as const, content: message }],
      {
        maxIterations: 20,
        onStreamEvent: (e: any) => {
          if (e.type === 'text_delta') {
            responseText += e.text;
            process.stderr.write(e.text);
          }
        },
        onToolEvent: (e: any) => {
          if (e.type === 'tool_call_start') {
            process.stderr.write(`\n    ${e.name} `);
          }
          if (e.type === 'tool_call_result') {
            toolCalls.push({ name: e.name ?? '', isError: !!e.isError });
            process.stderr.write(e.isError ? '✗ ' : '✓ ');
          }
        },
      },
    );

    return JSON.stringify({
      response: responseText,
      toolCalls,
      tokensUsed: result.usage.promptTokens + result.usage.completionTokens,
    });
  } finally {
    process.chdir(originalCwd);
  }
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
