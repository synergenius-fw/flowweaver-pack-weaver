import type { WeaverEnv } from '../bot/types.js';
import { validateFiles } from '../bot/file-validator.js';

/**
 * Validates all modified/created files using flow-weaver validate
 * and compile. Branches on validation success/failure.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Validate Result
 * @input env [order:0] - Weaver environment bundle
 * @input executionResultJson [order:1] - Execution result (JSON)
 * @input taskJson [order:2] - Task (JSON, pass-through)
 * @input filesModified [order:3] - Files modified (JSON array)
 * @output env [order:0] - Weaver environment bundle (pass-through)
 * @output validationResultJson [order:1] - Validation results (JSON)
 * @output taskJson [order:2] - Task (pass-through)
 * @output allValid [order:3] - Whether all files passed validation
 */
export function weaverValidateResult(
  env: WeaverEnv,
  executionResultJson: string,
  taskJson: string,
  filesModified: string,
): {
  env: WeaverEnv;
  validationResultJson: string; taskJson: string; allValid: boolean;
} {
  const { projectDir } = env;
  const files: string[] = JSON.parse(filesModified);
  const results = validateFiles(files, projectDir);

  for (const r of results) {
    if (r.valid) console.log(`\x1b[32m  ✓ ${r.file}\x1b[0m`);
    else console.log(`\x1b[31m  x ${r.file}: ${r.errors[0]?.slice(0, 100)}\x1b[0m`);
  }

  const allValid = results.length === 0 || results.every(r => r.valid);

  if (!allValid) {
    throw new Error('Validation failed: ' + results.filter(r => !r.valid).map(r => r.file).join(', '));
  }

  return {
    env,
    validationResultJson: JSON.stringify(results),
    taskJson, allValid,
  };
}
