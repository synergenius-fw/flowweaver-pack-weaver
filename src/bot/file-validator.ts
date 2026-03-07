import { execFileSync } from 'node:child_process';
import { checkDesignQuality, type DesignReport } from './design-checker.js';

export interface FileValidationResult {
  file: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
  designReport?: DesignReport;
}

export function validateFiles(
  files: string[],
  projectDir: string,
): FileValidationResult[] {
  const results: FileValidationResult[] = [];

  for (const file of files) {
    if (!file.endsWith('.ts')) continue;
    try {
      execFileSync('flow-weaver', ['validate', file], {
        cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000,
      });
      // Run design quality check on the AST
      const designReport = runDesignCheck(file, projectDir);
      const designWarnings = designReport
        ? designReport.checks
            .filter((c) => c.severity === 'warning' || c.severity === 'error')
            .map((c) => `[${c.code}] ${c.message}`)
        : [];
      results.push({ file, valid: true, errors: [], warnings: designWarnings, designReport: designReport ?? undefined });
    } catch (err: unknown) {
      const msg = err instanceof Error ? (err as { stderr?: string }).stderr ?? err.message : String(err);
      results.push({ file, valid: false, errors: [msg], warnings: [] });
    }
  }

  return results;
}

function runDesignCheck(file: string, projectDir: string): DesignReport | null {
  try {
    const astJson = execFileSync('flow-weaver', ['parse', file, '--format', 'json'], {
      cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000,
    });
    const ast = JSON.parse(astJson);
    return checkDesignQuality(ast);
  } catch {
    // If parse fails, skip design checks (validation already caught the error)
    return null;
  }
}
