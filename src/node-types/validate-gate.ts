import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import type { WeaverContext } from '../bot/types.js';

/**
 * Post-agent validation gate. Runs `flow-weaver validate` on all modified files
 * and fails the task if any have errors. Don't trust the AI's self-assessment.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Validate Gate
 * @input ctx [order:0] - Weaver context (JSON)
 * @output ctx [order:0] - Weaver context with validation result (JSON)
 * @output onSuccess [order:-2] - All files valid
 * @output onFailure [order:-1] [hidden] - Validation failed
 */
export function weaverValidateGate(ctx: string): {
  ctx: string;
  onSuccess: boolean;
  onFailure: boolean;
} {
  const context = JSON.parse(ctx) as WeaverContext;
  const { projectDir } = context.env;
  const files: string[] = context.filesModified ? JSON.parse(context.filesModified) : [];

  if (files.length === 0) {
    context.validationResultJson = JSON.stringify({ skipped: true, reason: 'no files modified' });
    return { ctx: JSON.stringify(context), onSuccess: true, onFailure: false };
  }

  // Only validate .ts files that look like workflows or node types
  const toValidate = files.filter(f => f.endsWith('.ts'));
  if (toValidate.length === 0) {
    context.validationResultJson = JSON.stringify({ skipped: true, reason: 'no .ts files' });
    return { ctx: JSON.stringify(context), onSuccess: true, onFailure: false };
  }

  const errors: Array<{ file: string; errorCount: number; errors: string[] }> = [];
  let allValid = true;

  for (const file of toValidate) {
    const absPath = path.isAbsolute(file) ? file : path.resolve(projectDir, file);
    try {
      const output = execFileSync(
        'npx',
        ['flow-weaver', 'validate', absPath, '--json'],
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000, cwd: projectDir },
      ).trim();

      // Parse JSON output — look for errors (not warnings)
      let result: { errors?: Array<{ message: string }>; errorCount?: number };
      try {
        result = JSON.parse(output);
      } catch {
        // Non-JSON output — try to detect errors from text
        const hasErrors = output.includes('error') && !output.includes('0 error');
        if (hasErrors) {
          errors.push({ file, errorCount: 1, errors: [output.slice(0, 200)] });
          allValid = false;
        }
        continue;
      }

      const errorCount = result.errorCount ?? result.errors?.length ?? 0;
      if (errorCount > 0) {
        allValid = false;
        errors.push({
          file,
          errorCount,
          errors: (result.errors ?? []).map(e => e.message).slice(0, 5),
        });
      }
    } catch (err: unknown) {
      // validate command failed — could be a parse error, treat as validation failure
      const msg = err instanceof Error ? err.message : String(err);
      // But don't fail on "not a workflow" — only on actual errors
      if (!msg.includes('No @flowWeaver annotation') && !msg.includes('not a workflow')) {
        errors.push({ file, errorCount: 1, errors: [msg.slice(0, 200)] });
        allValid = false;
      }
    }
  }

  // Also run tsc --noEmit if any .ts files were modified (catches type errors FW validate misses)
  if (allValid && toValidate.length > 0) {
    try {
      execFileSync('npx', ['tsc', '--noEmit', '--pretty'], {
        cwd: projectDir, encoding: 'utf-8', timeout: 60_000, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err: unknown) {
      const tscOutput = (err as { stdout?: string }).stdout ?? (err instanceof Error ? err.message : '');
      if (tscOutput.includes('error TS')) {
        allValid = false;
        errors.push({ file: '(tsc)', errorCount: 1, errors: [tscOutput.slice(0, 500)] });
      }
    }
  }

  context.validationResultJson = JSON.stringify({ errors, allValid });
  context.allValid = allValid;

  if (!allValid && process.env.WEAVER_VERBOSE) {
    for (const e of errors) {
      process.stderr.write(`\x1b[31m  ✗ ${e.file}: ${e.errorCount} error(s)\x1b[0m\n`);
      for (const msg of e.errors) {
        process.stderr.write(`\x1b[31m    ${msg}\x1b[0m\n`);
      }
    }
  }

  return { ctx: JSON.stringify(context), onSuccess: allValid, onFailure: !allValid };
}
