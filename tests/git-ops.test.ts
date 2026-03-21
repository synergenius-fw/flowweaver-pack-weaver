import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { weaverGitOps } from '../src/node-types/git-ops.js';

describe('weaverGitOps', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-git-ops-'));
    execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });
    // Create initial commit
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test\n');
    execSync('git add . && git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeContext(files: string[], gitEnabled = true) {
    return JSON.stringify({
      env: {
        projectDir: tmpDir,
        config: { git: { enabled: gitEnabled } },
        providerInfo: { type: 'claude-cli' },
      },
      filesModified: JSON.stringify(files),
    });
  }

  it('skips when git is disabled', () => {
    const result = weaverGitOps(makeContext(['file.ts'], false));
    const ctx = JSON.parse(result.ctx);
    const gitResult = JSON.parse(ctx.gitResultJson);
    expect(gitResult.skipped).toBe(true);
    expect(gitResult.reason).toBe('git disabled');
  });

  it('skips when no files modified', () => {
    const result = weaverGitOps(makeContext([]));
    const ctx = JSON.parse(result.ctx);
    const gitResult = JSON.parse(ctx.gitResultJson);
    expect(gitResult.skipped).toBe(true);
    expect(gitResult.reason).toBe('no files');
  });

  it('commits actually-changed files', () => {
    // Create a new file
    const filePath = path.join(tmpDir, 'new-file.ts');
    fs.writeFileSync(filePath, 'export const x = 1;\n');

    const result = weaverGitOps(makeContext([filePath]));
    const ctx = JSON.parse(result.ctx);
    const gitResult = JSON.parse(ctx.gitResultJson);
    expect(gitResult.skipped).toBe(false);
    expect(gitResult.results.some((r: string) => r.includes('Committed'))).toBe(true);

    // Verify the commit happened
    const log = execSync('git log --oneline -1', { cwd: tmpDir, encoding: 'utf-8' });
    expect(log).toContain('weaver:');
    expect(log).toContain('1 file');
  });

  it('skips files that were not actually changed', () => {
    // README.md exists but has not been modified since last commit
    const readmePath = path.join(tmpDir, 'README.md');

    const result = weaverGitOps(makeContext([readmePath]));
    const ctx = JSON.parse(result.ctx);
    const gitResult = JSON.parse(ctx.gitResultJson);
    // No actual changes → skip
    expect(gitResult.skipped).toBe(true);
    expect(gitResult.reason).toBe('no actual changes');
  });

  it('only stages changed files from the list', () => {
    // Create one new file, reference both new and unchanged
    const newFile = path.join(tmpDir, 'changed.ts');
    fs.writeFileSync(newFile, 'export const y = 2;\n');
    const unchangedFile = path.join(tmpDir, 'README.md');

    const result = weaverGitOps(makeContext([newFile, unchangedFile]));
    const ctx = JSON.parse(result.ctx);
    const gitResult = JSON.parse(ctx.gitResultJson);
    expect(gitResult.skipped).toBe(false);
    // Commit message should reflect 1 file, not 2
    const commitResult = gitResult.results.find((r: string) => r.startsWith('Committed'));
    expect(commitResult).toContain('1 file');
  });

  it('commits modified existing files', () => {
    // Modify an existing tracked file
    const readmePath = path.join(tmpDir, 'README.md');
    fs.writeFileSync(readmePath, '# Test\n\nUpdated content.\n');

    const result = weaverGitOps(makeContext([readmePath]));
    const ctx = JSON.parse(result.ctx);
    const gitResult = JSON.parse(ctx.gitResultJson);
    expect(gitResult.skipped).toBe(false);
  });

  it('uses custom commit prefix', () => {
    const newFile = path.join(tmpDir, 'feat.ts');
    fs.writeFileSync(newFile, 'export const z = 3;\n');

    const ctxStr = JSON.stringify({
      env: {
        projectDir: tmpDir,
        config: { git: { enabled: true, commitPrefix: 'bot:' } },
        providerInfo: { type: 'claude-cli' },
      },
      filesModified: JSON.stringify([newFile]),
    });

    weaverGitOps(ctxStr);
    const log = execSync('git log --oneline -1', { cwd: tmpDir, encoding: 'utf-8' });
    expect(log).toContain('bot:');
  });

  it('creates branch if specified', () => {
    const newFile = path.join(tmpDir, 'feat.ts');
    fs.writeFileSync(newFile, 'export const z = 3;\n');

    const ctxStr = JSON.stringify({
      env: {
        projectDir: tmpDir,
        config: { git: { enabled: true, branch: 'weaver/test' } },
        providerInfo: { type: 'claude-cli' },
      },
      filesModified: JSON.stringify([newFile]),
    });

    const result = weaverGitOps(ctxStr);
    const ctx = JSON.parse(result.ctx);
    const gitResult = JSON.parse(ctx.gitResultJson);
    expect(gitResult.results.some((r: string) => r.includes('weaver/test'))).toBe(true);

    const branch = execSync('git branch --show-current', { cwd: tmpDir, encoding: 'utf-8' }).trim();
    expect(branch).toBe('weaver/test');
  });

  it('switches to existing branch when checkout -b fails (branch already exists)', () => {
    // Create the branch without switching to it
    execSync('git branch weaver/existing', { cwd: tmpDir, stdio: 'pipe' });

    // Create a changed file so the function doesn't skip early
    const newFile = path.join(tmpDir, 'feat.ts');
    fs.writeFileSync(newFile, 'export const x = 1;\n');

    const ctxStr = JSON.stringify({
      env: {
        projectDir: tmpDir,
        config: { git: { enabled: true, branch: 'weaver/existing' } },
        providerInfo: { type: 'claude-cli' },
      },
      filesModified: JSON.stringify([newFile]),
    });

    const result = weaverGitOps(ctxStr);
    const ctx = JSON.parse(result.ctx);
    const gitResult = JSON.parse(ctx.gitResultJson);

    expect(gitResult.results.some((r: string) => r.includes('Switched to branch:'))).toBe(true);
    expect(gitResult.results.some((r: string) => r.includes('weaver/existing'))).toBe(true);

    const branch = execSync('git branch --show-current', { cwd: tmpDir, encoding: 'utf-8' }).trim();
    expect(branch).toBe('weaver/existing');
  });

  it('handles non-git directory gracefully', () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-no-git-'));
    try {
      const ctxStr = JSON.stringify({
        env: {
          projectDir: nonGitDir,
          config: { git: { enabled: true } },
          providerInfo: { type: 'claude-cli' },
        },
        filesModified: JSON.stringify(['file.ts']),
      });
      const result = weaverGitOps(ctxStr);
      const ctx = JSON.parse(result.ctx);
      const gitResult = JSON.parse(ctx.gitResultJson);
      expect(gitResult.skipped).toBe(true);
      expect(gitResult.reason).toBe('not a git repo');
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it('commit message uses plural when multiple files committed', () => {
    const file1 = path.join(tmpDir, 'a.ts');
    const file2 = path.join(tmpDir, 'b.ts');
    fs.writeFileSync(file1, 'export const a = 1;\n');
    fs.writeFileSync(file2, 'export const b = 2;\n');

    const result = weaverGitOps(makeContext([file1, file2]));
    const ctx = JSON.parse(result.ctx);
    const gitResult = JSON.parse(ctx.gitResultJson);

    expect(gitResult.skipped).toBe(false);
    const commitResult = gitResult.results.find((r: string) => r.startsWith('Committed'));
    expect(commitResult).toContain('2 files');
  });

  it('gitResultJson is valid JSON on successful commit', () => {
    const filePath = path.join(tmpDir, 'new.ts');
    fs.writeFileSync(filePath, 'export const x = 1;\n');

    const result = weaverGitOps(makeContext([filePath]));
    const ctx = JSON.parse(result.ctx);

    expect(() => JSON.parse(ctx.gitResultJson)).not.toThrow();
  });

  it('return value has only ctx key', () => {
    const result = weaverGitOps(makeContext([]));
    expect(Object.keys(result)).toEqual(['ctx']);
  });

  it('reviewStagedDiff blocks large deletion (>50 lines deleted, <5 added)', () => {
    // Create a file with 60 lines and commit it
    const filePath = path.join(tmpDir, 'big.ts');
    fs.writeFileSync(filePath, Array(61).fill('// line of code').join('\n') + '\n');
    execSync('git add . && git commit -m "add big file"', { cwd: tmpDir, stdio: 'pipe' });

    // Replace with 2 lines (large deletion)
    fs.writeFileSync(filePath, '// tiny\n// file\n');

    const result = weaverGitOps(makeContext([filePath]));
    const ctx = JSON.parse(result.ctx);
    const gitResult = JSON.parse(ctx.gitResultJson);

    expect(gitResult.skipped).toBe(true);
    expect(gitResult.reason).toBe('diff review failed');
  });

  it('reviewStagedDiff blocks file emptied (0 additions, >10 deletions)', () => {
    const filePath = path.join(tmpDir, 'filled.ts');
    fs.writeFileSync(filePath, Array(15).fill('// content line').join('\n') + '\n');
    execSync('git add . && git commit -m "add filled file"', { cwd: tmpDir, stdio: 'pipe' });

    // Empty the file
    fs.writeFileSync(filePath, '');

    const result = weaverGitOps(makeContext([filePath]));
    const ctx = JSON.parse(result.ctx);
    const gitResult = JSON.parse(ctx.gitResultJson);

    expect(gitResult.skipped).toBe(true);
    expect(gitResult.reason).toBe('diff review failed');
    expect(gitResult.issues.some((i: string) => i.includes('file emptied'))).toBe(true);
  });

  it('reviewStagedDiff blocks sensitive secret pattern in added lines', () => {
    const filePath = path.join(tmpDir, 'config.ts');
    fs.writeFileSync(filePath, 'export const secret = "my_super_secret_value_here";\n');

    const result = weaverGitOps(makeContext([filePath]));
    const ctx = JSON.parse(result.ctx);
    const gitResult = JSON.parse(ctx.gitResultJson);

    expect(gitResult.skipped).toBe(true);
    expect(gitResult.reason).toBe('diff review failed');
    expect(gitResult.issues.some((i: string) => i.includes('credential'))).toBe(true);
  });

  it('reviewStagedDiff: blocked commit unstages the file (git reset HEAD called)', () => {
    const filePath = path.join(tmpDir, 'config2.ts');
    fs.writeFileSync(filePath, 'export const secret = "another_secret_value_here";\n');

    weaverGitOps(makeContext([filePath]));

    // After blocking, nothing should be staged
    const staged = execSync('git diff --cached --name-only', { cwd: tmpDir, encoding: 'utf-8' }).trim();
    expect(staged).toBe('');
  });

  it('reviewStagedDiff: gitResultJson.issues populated when commit blocked', () => {
    const filePath = path.join(tmpDir, 'filled2.ts');
    fs.writeFileSync(filePath, Array(15).fill('// content').join('\n') + '\n');
    execSync('git add . && git commit -m "baseline"', { cwd: tmpDir, stdio: 'pipe' });

    fs.writeFileSync(filePath, '');

    const result = weaverGitOps(makeContext([filePath]));
    const ctx = JSON.parse(result.ctx);
    const gitResult = JSON.parse(ctx.gitResultJson);

    expect(Array.isArray(gitResult.issues)).toBe(true);
    expect(gitResult.issues.length).toBeGreaterThan(0);
  });

  it('reviewStagedDiff: normal changes (small modification) commit fine', () => {
    const filePath = path.join(tmpDir, 'normal.ts');
    fs.writeFileSync(filePath, 'export const x = 1;\n');
    execSync('git add . && git commit -m "add normal"', { cwd: tmpDir, stdio: 'pipe' });

    // Change one line — not suspicious
    fs.writeFileSync(filePath, 'export const x = 2;\n');

    const result = weaverGitOps(makeContext([filePath]));
    const ctx = JSON.parse(result.ctx);
    const gitResult = JSON.parse(ctx.gitResultJson);

    expect(gitResult.skipped).toBe(false);
    expect(gitResult.results.some((r: string) => r.includes('Committed'))).toBe(true);
  });
});
