import type { WeaverContext } from '../bot/types.js';

/**
 * Generates the final bot session report. Receives context from any
 * of the three paths: read-only, main execution, or abort.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Bot Report
 * @executeWhen DISJUNCTION
 * @input [mainCtx] [order:0] - Context from main path (JSON, optional)
 * @input [readCtx] [order:1] - Context from read-only path (JSON, optional)
 * @input [abortCtx] [order:2] - Context from abort path (JSON, optional)
 * @output summary [order:0] - Summary text
 * @output reportJson [order:1] [hidden] - Full report (JSON)
 * @output onFailure [hidden]
 */
export function weaverBotReport(
  mainCtx?: string,
  readCtx?: string,
  abortCtx?: string,
): { summary: string; reportJson: string } {
  const ctxStr = mainCtx ?? readCtx ?? abortCtx;

  if (!ctxStr) {
    const report = { task: {}, path: 'unknown', result: null, filesModified: [], gitResult: null, timestamp: Date.now() };
    return { summary: '', reportJson: JSON.stringify(report) };
  }

  const context = JSON.parse(ctxStr) as WeaverContext;
  const task = context.taskJson ? JSON.parse(context.taskJson) as { instruction?: string; mode?: string } : {};
  const files: string[] = context.filesModified ? JSON.parse(context.filesModified) : [];
  const gitResult = context.gitResultJson ? JSON.parse(context.gitResultJson) : null;

  let result: { success?: boolean; summary?: string; outcome?: string; results?: unknown[] } | null = null;
  let pathName = 'unknown';

  if (readCtx) {
    result = context.resultJson ? JSON.parse(context.resultJson) : null;
    pathName = 'read';
  } else if (mainCtx) {
    result = context.resultJson ? JSON.parse(context.resultJson) : null;
    pathName = 'main';
  } else if (abortCtx) {
    result = context.resultJson ? JSON.parse(context.resultJson) : null;
    pathName = 'abort';
  }

  const parts: string[] = [];

  if (task.instruction) {
    parts.push(`Task: ${task.instruction}`);
  }

  if (result) {
    parts.push(`Outcome: ${result.outcome ?? (result.success ? 'completed' : 'failed')}`);
    if (result.summary) parts.push(`Summary: ${result.summary}`);
  }

  if (files.length > 0) {
    parts.push(`Files: ${files.length} modified`);
  }

  if (gitResult && !gitResult.skipped) {
    parts.push('Git: committed');
  }

  const summary = parts.join(' | ');

  const report = {
    task,
    path: pathName,
    result,
    filesModified: files,
    gitResult,
    timestamp: Date.now(),
  };

  console.log(`\n\x1b[1m${result?.success !== false ? '\x1b[32m' : '\x1b[31m'}Bot Report: ${summary}\x1b[0m\n`);

  return { summary, reportJson: JSON.stringify(report) };
}
