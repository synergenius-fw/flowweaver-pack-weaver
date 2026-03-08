import { checkDesignQuality, type DesignReport } from './design-checker.js';
import { fwValidate } from './fw-api.js';

export interface FileValidationResult {
  file: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
  designReport?: DesignReport;
}

export async function validateFiles(
  files: string[],
  projectDir: string,
): Promise<FileValidationResult[]> {
  const results: FileValidationResult[] = [];

  for (const file of files) {
    if (!file.endsWith('.ts')) continue;
    try {
      const { valid, errors, warnings, ast } = await fwValidate(file);

      if (!valid) {
        results.push({ file, valid: false, errors, warnings });
        continue;
      }

      const designReport = checkDesignQuality(ast);
      const designWarnings = designReport.checks
        .filter((c) => c.severity === 'warning' || c.severity === 'error')
        .map((c) => `[${c.code}] ${c.message}`);

      results.push({ file, valid: true, errors: [], warnings: [...warnings, ...designWarnings], designReport });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ file, valid: false, errors: [msg], warnings: [] });
    }
  }

  return results;
}
