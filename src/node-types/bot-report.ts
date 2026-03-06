/**
 * Generates the final bot session report. Designed to receive input
 * from any of the three paths: read-only, main execution, or abort.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Bot Report
 * @executeWhen DISJUNCTION
 * @input [readResult] [order:0] - From read-only path (JSON, optional)
 * @input [mainResult] [order:1] - From main execution path (JSON, optional)
 * @input [abortResult] [order:2] - From abort path (JSON, optional)
 * @input [taskJson] [order:3] - Task (JSON, optional)
 * @input [filesModified] [order:4] - Files modified (JSON array, optional)
 * @input [gitResultJson] [order:5] - Git result (JSON, optional)
 * @output summary [order:0] - Summary text
 * @output reportJson [order:1] - Full report (JSON)
 */
export function weaverBotReport(
  readResult?: string,
  mainResult?: string,
  abortResult?: string,
  taskJson?: string,
  filesModified?: string,
  gitResultJson?: string,
): { summary: string; reportJson: string } {
  const task = taskJson ? JSON.parse(taskJson) as { instruction?: string; mode?: string } : {};
  const files: string[] = filesModified ? JSON.parse(filesModified) : [];
  const gitResult = gitResultJson ? JSON.parse(gitResultJson) : null;

  let result: { success?: boolean; summary?: string; outcome?: string; results?: unknown[] } | null = null;
  let path = 'unknown';

  if (readResult) {
    result = JSON.parse(readResult);
    path = 'read';
  } else if (mainResult) {
    result = JSON.parse(mainResult);
    path = 'main';
  } else if (abortResult) {
    result = JSON.parse(abortResult);
    path = 'abort';
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
    path,
    result,
    filesModified: files,
    gitResult,
    timestamp: Date.now(),
  };

  console.log(`\n\x1b[1m${result?.success !== false ? '\x1b[32m' : '\x1b[31m'}Bot Report: ${summary}\x1b[0m\n`);

  return { summary, reportJson: JSON.stringify(report) };
}
