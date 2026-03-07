import * as path from 'node:path';
import type { WeaverContext } from '../bot/types.js';

/**
 * Format the result summary, suitable for display or further processing.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Report
 * @input ctx [order:0] - Weaver context (JSON)
 * @output summary [order:0] - Summary string
 * @output onFailure [hidden]
 */
export function weaverReport(ctx: string): { summary: string } {
  const context = JSON.parse(ctx) as WeaverContext;
  const result = JSON.parse(context.resultJson!);
  const relPath = path.relative(context.env.projectDir, context.targetPath!);
  const lines = [
    `Weaver: ${result.outcome} (${relPath})`,
    result.summary,
  ];
  if (result.executionTime) lines.push(`Time: ${result.executionTime}s`);
  console.log(`\x1b[32m✓ ${lines[0]}\x1b[0m`);
  return { summary: lines.join('\n') };
}
