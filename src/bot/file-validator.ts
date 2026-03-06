import { execFileSync } from 'node:child_process';

export function validateFiles(
  files: string[],
  projectDir: string,
): Array<{ file: string; valid: boolean; errors: string[]; warnings: string[] }> {
  const results: Array<{ file: string; valid: boolean; errors: string[]; warnings: string[] }> = [];

  for (const file of files) {
    if (!file.endsWith('.ts')) continue;
    try {
      execFileSync('flow-weaver', ['validate', file], {
        cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000,
      });
      results.push({ file, valid: true, errors: [], warnings: [] });
    } catch (err: unknown) {
      const msg = err instanceof Error ? (err as { stderr?: string }).stderr ?? err.message : String(err);
      results.push({ file, valid: false, errors: [msg], warnings: [] });
    }
  }

  return results;
}
