import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock audit-logger to avoid side effects ───────────────────────────────────

vi.mock('../src/bot/audit-logger.js', () => ({
  auditEmit: vi.fn(),
}));

// ── Mock execFileSync so we can simulate git diff output ──────────────────────

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFileSync: vi.fn() };
});

import { execFileSync } from 'node:child_process';
import { weaverGitOps } from '../src/node-types/git-ops.js';

const mockedExecFileSync = vi.mocked(execFileSync);

// ── helpers ───────────────────────────────────────────────────────────────────

function makeCtx(files: string[] = ['src/file.ts']): string {
  return JSON.stringify({
    env: {
      projectDir: '/test',
      config: { git: { enabled: true } },
      providerInfo: { type: 'anthropic' },
    },
    filesModified: JSON.stringify(files),
  });
}

/**
 * Prime the first four execFileSync calls that weaverGitOps makes before
 * it reaches reviewStagedDiff:
 *   1. git rev-parse  (is inside work tree)
 *   2. git diff --name-only  (returns the file as changed)
 *   3. git ls-files --others  (no untracked extras)
 *   4. git add <file>  (stage succeeds → staged=1)
 */
function setupPreReviewMocks(file = 'src/file.ts'): void {
  mockedExecFileSync
    .mockReturnValueOnce('' as any)              // git rev-parse
    .mockReturnValueOnce(`${file}\n` as any)     // git diff --name-only
    .mockReturnValueOnce('' as any)              // git ls-files
    .mockReturnValueOnce('' as any);             // git add
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('reviewStagedDiff (via weaverGitOps)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  // ── sensitive API key pattern ────────────────────────────────────────────────

  it('blocks commit and returns issues when API key pattern found in staged diff', () => {
    setupPreReviewMocks();
    mockedExecFileSync
      .mockReturnValueOnce('src/file.ts | 1 +' as any)      // diff --cached --stat (non-empty)
      .mockReturnValueOnce('1\t0\tsrc/file.ts\n' as any)    // diff --cached --numstat
      .mockReturnValueOnce('+api_key: "sk-test-12345678901234567890"\n' as any); // diff --cached -U0

    const result = weaverGitOps(makeCtx());
    const ctx = JSON.parse(result.ctx);
    const gitResult = JSON.parse(ctx.gitResultJson);

    expect(gitResult.skipped).toBe(true);
    expect(gitResult.reason).toBe('diff review failed');
    expect(gitResult.issues).toHaveLength(1);
    expect(gitResult.issues[0]).toContain('credential');
  });

  // ── sensitive password pattern ───────────────────────────────────────────────

  it('blocks commit when password pattern detected in added lines', () => {
    setupPreReviewMocks();
    mockedExecFileSync
      .mockReturnValueOnce('src/file.ts | 1 +' as any)      // diff --cached --stat
      .mockReturnValueOnce('1\t0\tsrc/file.ts\n' as any)    // diff --cached --numstat
      .mockReturnValueOnce('+password: "hunter2secret"\n' as any); // diff --cached -U0

    const result = weaverGitOps(makeCtx());
    const ctx = JSON.parse(result.ctx);
    const gitResult = JSON.parse(ctx.gitResultJson);

    expect(gitResult.skipped).toBe(true);
    expect(gitResult.reason).toBe('diff review failed');
    expect(gitResult.issues[0]).toContain('credential');
  });

  // ── large deletion flagged as truncation ─────────────────────────────────────

  it('flags large deletion (>50 deleted, <5 added, deleted > added×10) as possible truncation', () => {
    setupPreReviewMocks();
    mockedExecFileSync
      .mockReturnValueOnce('src/file.ts | 92 -' as any)     // diff --cached --stat
      .mockReturnValueOnce('2\t90\tsrc/file.ts\n' as any)   // numstat: 2 added, 90 deleted
      .mockReturnValueOnce('+// small change\n' as any);    // diff -U0: no secrets

    const result = weaverGitOps(makeCtx());
    const ctx = JSON.parse(result.ctx);
    const gitResult = JSON.parse(ctx.gitResultJson);

    expect(gitResult.skipped).toBe(true);
    expect(gitResult.issues[0]).toContain('possible truncation');
    expect(gitResult.issues[0]).toContain('90');
  });

  // ── file emptied ─────────────────────────────────────────────────────────────

  it('flags file emptied (0 additions, >10 deletions)', () => {
    setupPreReviewMocks();
    mockedExecFileSync
      .mockReturnValueOnce('src/file.ts | 15 -' as any)     // diff --cached --stat
      .mockReturnValueOnce('0\t15\tsrc/file.ts\n' as any)   // numstat: 0 added, 15 deleted
      .mockReturnValueOnce('' as any);                       // diff -U0: no secrets

    const result = weaverGitOps(makeCtx());
    const ctx = JSON.parse(result.ctx);
    const gitResult = JSON.parse(ctx.gitResultJson);

    expect(gitResult.skipped).toBe(true);
    expect(gitResult.issues[0]).toContain('file emptied');
    expect(gitResult.issues[0]).toContain('15');
  });

  // ── git diff commands fail ───────────────────────────────────────────────────

  it('does not block commit when git diff commands fail', () => {
    setupPreReviewMocks();
    // diff --cached --stat throws → reviewStagedDiff catches and returns []
    mockedExecFileSync.mockImplementationOnce(() => { throw new Error('git command failed'); });
    // git commit succeeds
    mockedExecFileSync.mockReturnValueOnce('' as any);

    const result = weaverGitOps(makeCtx());
    const ctx = JSON.parse(result.ctx);
    const gitResult = JSON.parse(ctx.gitResultJson);

    // Diff failure must not block — commit proceeds
    expect(gitResult.skipped).toBe(false);
    expect(gitResult.issues).toBeUndefined();
  });
});
