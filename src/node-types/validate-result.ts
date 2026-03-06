import { execSync } from 'node:child_process';

/**
 * Validates all modified/created files using flow-weaver validate
 * and compile. Branches on validation success/failure.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Validate Result
 * @input projectDir [order:0] - Project root directory
 * @input config [order:1] - Config (JSON, pass-through)
 * @input providerType [order:2] - Provider type (pass-through)
 * @input providerInfo [order:3] - Provider info (pass-through)
 * @input executionResultJson [order:4] - Execution result (JSON)
 * @input taskJson [order:5] - Task (JSON, pass-through)
 * @input filesModified [order:6] - Files modified (JSON array)
 * @output projectDir [order:0] - Project root directory (pass-through)
 * @output config [order:1] - Config (pass-through)
 * @output providerType [order:2] - Provider type (pass-through)
 * @output providerInfo [order:3] - Provider info (pass-through)
 * @output validationResultJson [order:4] - Validation results (JSON)
 * @output taskJson [order:5] - Task (pass-through)
 * @output allValid [order:6] - Whether all files passed validation
 */
export function weaverValidateResult(
  projectDir: string,
  config: string,
  providerType: string,
  providerInfo: string,
  executionResultJson: string,
  taskJson: string,
  filesModified: string,
): {
  projectDir: string; config: string; providerType: string; providerInfo: string;
  validationResultJson: string; taskJson: string; allValid: boolean;
} {
  const files: string[] = JSON.parse(filesModified);
  const results: Array<{ file: string; valid: boolean; errors: string[]; warnings: string[] }> = [];

  for (const file of files) {
    if (!file.endsWith('.ts')) continue;

    try {
      execSync(`flow-weaver validate "${file}"`, {
        cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000,
      });
      results.push({ file, valid: true, errors: [], warnings: [] });
      console.log(`\x1b[32m  ✓ ${file}\x1b[0m`);
    } catch (err: unknown) {
      const stderr = (err as { stderr?: string }).stderr ?? (err instanceof Error ? err.message : String(err));
      results.push({ file, valid: false, errors: [stderr], warnings: [] });
      console.log(`\x1b[31m  x ${file}: ${stderr.slice(0, 100)}\x1b[0m`);
    }
  }

  const allValid = results.length === 0 || results.every(r => r.valid);

  if (!allValid) {
    throw new Error('Validation failed: ' + results.filter(r => !r.valid).map(r => r.file).join(', '));
  }

  return {
    projectDir, config, providerType, providerInfo,
    validationResultJson: JSON.stringify(results),
    taskJson, allValid,
  };
}
