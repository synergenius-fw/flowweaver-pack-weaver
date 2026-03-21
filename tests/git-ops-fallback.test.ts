import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/bot/audit-logger.js', () => ({ auditEmit: vi.fn() }));

const { mockExecFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFileSync: mockExecFileSync };
});

import { weaverGitOps } from '../src/node-types/git-ops.js';

function makeCtx(files: string[], gitConfig: Record<string, unknown> = {}): string {
  return JSON.stringify({
    env: {
      projectDir: '/fake/proj',
      config: { git: { enabled: true, ...gitConfig } },
      providerType: 'claude-cli',
      providerInfo: { type: 'claude-cli' },
    },
    filesModified: JSON.stringify(files),
  });
}

describe('weaverGitOps (mocked execFileSync)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('git diff --name-only throws → falls back to filesModified, file is staged and committed', () => {
    mockExecFileSync
      .mockReturnValueOnce('true' as any)                                     // git rev-parse → in git repo
      .mockImplementationOnce(() => { throw new Error('git diff failed'); })  // git diff --name-only → THROW (triggers fallback)
      .mockReturnValueOnce('' as any)                                         // git add changed.ts
      .mockReturnValueOnce('' as any)                                         // git diff --cached --stat (empty → reviewStagedDiff returns early)
      .mockReturnValueOnce('abc123 weaver: bot task\n' as any);               // git commit

    const result = weaverGitOps(makeCtx(['changed.ts']));
    const ctx = JSON.parse(result.ctx);
    const gitResult = JSON.parse(ctx.gitResultJson);

    // git add must have been called with the fallback file
    const addCall = mockExecFileSync.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('add'),
    );
    expect(addCall).toBeDefined();
    expect(addCall![1] as string[]).toContain('changed.ts');

    // commit should have proceeded (not skipped)
    expect(gitResult.skipped).toBe(false);
    expect(gitResult.results.some((r: string) => r.includes('Committed'))).toBe(true);
  });

  it('ls-files throws after diff succeeds → falls back, file staged and committed', () => {
    mockExecFileSync
      .mockReturnValueOnce('true' as any)                                            // rev-parse
      .mockReturnValueOnce('' as any)                                                // git diff --name-only (empty)
      .mockImplementationOnce(() => { throw new Error('ls-files failed'); })         // ls-files → THROW (triggers fallback)
      .mockReturnValueOnce('' as any)                                                // git add
      .mockReturnValueOnce('' as any)                                                // git diff --cached --stat (empty)
      .mockReturnValueOnce('abc123\n' as any);                                       // git commit

    const result = weaverGitOps(makeCtx(['src/foo.ts']));
    const ctx = JSON.parse(result.ctx);
    const gitResult = JSON.parse(ctx.gitResultJson);

    expect(gitResult.skipped).toBe(false);
    expect(gitResult.results.some((r: string) => r.includes('Committed'))).toBe(true);
    const addCall = mockExecFileSync.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('add'),
    );
    expect(addCall![1] as string[]).toContain('src/foo.ts');
  });

  it('fallback with multiple files → all staged, commit reports 2 files', () => {
    mockExecFileSync
      .mockReturnValueOnce('true' as any)                                            // rev-parse
      .mockImplementationOnce(() => { throw new Error('diff failed'); })             // diff → fallback
      .mockReturnValueOnce('' as any)                                                // git add a.ts
      .mockReturnValueOnce('' as any)                                                // git add b.ts
      .mockReturnValueOnce('' as any)                                                // git diff --cached --stat (empty)
      .mockReturnValueOnce('abc123\n' as any);                                       // git commit

    const result = weaverGitOps(makeCtx(['a.ts', 'b.ts']));
    const ctx = JSON.parse(result.ctx);
    const gitResult = JSON.parse(ctx.gitResultJson);

    expect(gitResult.skipped).toBe(false);
    const commitResult = gitResult.results.find((r: string) => r.startsWith('Committed'));
    expect(commitResult).toContain('2 files');
  });

  it('fallback: default commit prefix is "weaver:"', () => {
    mockExecFileSync
      .mockReturnValueOnce('true' as any)
      .mockImplementationOnce(() => { throw new Error('diff failed'); })
      .mockReturnValueOnce('' as any)   // git add
      .mockReturnValueOnce('' as any)   // git diff --cached --stat (empty)
      .mockReturnValueOnce('' as any);  // git commit

    const result = weaverGitOps(makeCtx(['file.ts']));
    const ctx = JSON.parse(result.ctx);
    const gitResult = JSON.parse(ctx.gitResultJson);

    const commitCall = mockExecFileSync.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('commit'),
    );
    expect(commitCall![1] as string[]).toContain('weaver: bot task (1 file)');
    expect(gitResult.skipped).toBe(false);
  });

  it('skips early when git.enabled=false — no execFileSync calls', () => {
    weaverGitOps(makeCtx(['file.ts'], { enabled: false }));
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('skips early when filesModified is empty — no execFileSync calls', () => {
    const result = weaverGitOps(makeCtx([]));
    const ctx = JSON.parse(result.ctx);
    const gitResult = JSON.parse(ctx.gitResultJson);

    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(gitResult.skipped).toBe(true);
    expect(gitResult.reason).toBe('no files');
  });

  it('fallback: rev-parse throws → skipped with reason "not a git repo"', () => {
    mockExecFileSync.mockImplementationOnce(() => { throw new Error('not a git repo'); });

    const result = weaverGitOps(makeCtx(['file.ts']));
    const ctx = JSON.parse(result.ctx);
    const gitResult = JSON.parse(ctx.gitResultJson);

    expect(gitResult.skipped).toBe(true);
    expect(gitResult.reason).toBe('not a git repo');
  });

  it('fallback: git add throws for all files → staged=0 → skipped with "no actual changes"', () => {
    mockExecFileSync
      .mockReturnValueOnce('true' as any)                                    // rev-parse
      .mockImplementationOnce(() => { throw new Error('diff failed'); })     // diff → fallback
      .mockImplementationOnce(() => { throw new Error('add failed'); });     // git add throws

    const result = weaverGitOps(makeCtx(['bad.ts']));
    const ctx = JSON.parse(result.ctx);
    const gitResult = JSON.parse(ctx.gitResultJson);

    expect(gitResult.skipped).toBe(true);
    expect(gitResult.reason).toBe('no actual changes');
  });

  it('fallback: commit throws → "Nothing to commit" in results', () => {
    mockExecFileSync
      .mockReturnValueOnce('true' as any)                                    // rev-parse
      .mockImplementationOnce(() => { throw new Error('diff failed'); })     // diff → fallback
      .mockReturnValueOnce('' as any)                                        // git add
      .mockReturnValueOnce('' as any)                                        // git diff --cached --stat (empty)
      .mockImplementationOnce(() => { throw new Error('nothing to commit'); }); // git commit → throws

    const result = weaverGitOps(makeCtx(['file.ts']));
    const ctx = JSON.parse(result.ctx);
    const gitResult = JSON.parse(ctx.gitResultJson);

    expect(gitResult.results.some((r: string) => r.includes('Nothing to commit'))).toBe(true);
  });

  it('fallback: gitResultJson is valid JSON and has skipped=false on successful commit', () => {
    mockExecFileSync
      .mockReturnValueOnce('true' as any)
      .mockImplementationOnce(() => { throw new Error('diff failed'); })
      .mockReturnValueOnce('' as any)
      .mockReturnValueOnce('' as any)
      .mockReturnValueOnce('' as any);

    const result = weaverGitOps(makeCtx(['file.ts']));
    const ctx = JSON.parse(result.ctx);

    expect(() => JSON.parse(ctx.gitResultJson)).not.toThrow();
    const gitResult = JSON.parse(ctx.gitResultJson);
    expect(gitResult.skipped).toBe(false);
    expect(Array.isArray(gitResult.results)).toBe(true);
  });
});
