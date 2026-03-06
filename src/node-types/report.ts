import * as path from 'node:path';

/**
 * Format the result summary, suitable for display or further processing.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Report
 * @input projectDir [order:0] - Project root directory
 * @input targetPath [order:1] - Target workflow path
 * @input resultJson [order:2] - Result (JSON)
 * @output summary [order:0] - Summary string
 */
export function weaverReport(projectDir: string, targetPath: string, resultJson: string): { summary: string } {
  const result = JSON.parse(resultJson);
  const relPath = path.relative(projectDir, targetPath);
  const lines = [
    `Weaver: ${result.outcome} (${relPath})`,
    result.summary,
  ];
  if (result.executionTime) lines.push(`Time: ${result.executionTime}s`);
  console.log(`\x1b[32m✓ ${lines[0]}\x1b[0m`);
  return { summary: lines.join('\n') };
}
