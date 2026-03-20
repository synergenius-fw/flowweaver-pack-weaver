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
});
