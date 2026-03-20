import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { WeaverContext } from '../bot/types.js';
import { withFileLock } from '../bot/file-lock.js';

/**
 * Generates the final bot session report. Receives context from any
 * of the three paths: read-only, main execution, or abort.
 * Also marks the queue task as completed or failed.
 *
 * @flowWeaver nodeType
 * @label Bot Report
 * @executeWhen DISJUNCTION
 * @input [mainCtx] [order:0] - Context from main path (JSON, optional)
 * @input [readCtx] [order:1] - Context from read-only path (JSON, optional)
 * @input [abortCtx] [order:2] - Context from abort path (JSON, optional)
 * @output summary [order:0] - Summary text
 * @output reportJson [order:1] [hidden] - Full report (JSON)
 * @output onFailure [hidden]
 */
export async function weaverBotReport(
  execute: boolean,
  mainCtx?: string,
  readCtx?: string,
  abortCtx?: string,
): Promise<{ onSuccess: boolean; onFailure: boolean; summary: string; reportJson: string }> {
  const ctxStr = mainCtx ?? readCtx ?? abortCtx;

  if (!execute || !ctxStr) {
    const report = { task: {}, path: 'unknown', result: null, filesModified: [], gitResult: null, timestamp: Date.now() };
    return { onSuccess: true, onFailure: false, summary: '', reportJson: JSON.stringify(report) };
  }

  const context = JSON.parse(ctxStr) as WeaverContext;
  const task = context.taskJson ? JSON.parse(context.taskJson) as { instruction?: string; mode?: string; queueId?: string } : {};
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

  const success = result?.success !== false && pathName !== 'abort';

  if (result) {
    parts.push(`Outcome: ${result.outcome ?? (success ? 'completed' : 'failed')}`);
    if (result.summary) parts.push(`Summary: ${result.summary}`);
  }

  if (files.length > 0) {
    parts.push(`Files: ${files.length} modified`);
  }

  if (gitResult && !gitResult.skipped) {
    parts.push('Git: committed');
  }

  const summary = parts.join(' | ');

  // Mark queue task as completed or failed
  if (task.queueId) {
    try {
      await markQueueTask(task.queueId, success ? 'completed' : 'failed');
    } catch { /* best-effort queue update */ }
  }

  const report = {
    task,
    path: pathName,
    result,
    filesModified: files,
    gitResult,
    timestamp: Date.now(),
  };

  console.log(`\n\x1b[1m${success ? '\x1b[32m' : '\x1b[31m'}Bot Report: ${summary}\x1b[0m\n`);

  return { onSuccess: success, onFailure: !success, summary, reportJson: JSON.stringify(report) };
}

async function markQueueTask(id: string, status: 'completed' | 'failed'): Promise<void> {
  const queuePath = path.join(os.homedir(), '.weaver', 'task-queue.ndjson');
  if (!fs.existsSync(queuePath)) return;

  await withFileLock(queuePath, () => {
    const content = fs.readFileSync(queuePath, 'utf-8').trim();
    if (!content) return;
    const tasks = content.split('\n').filter(Boolean).map(l => JSON.parse(l));
    const task = tasks.find((t: { id: string }) => t.id === id);
    if (task) {
      task.status = status;
      fs.writeFileSync(queuePath, tasks.map((t: unknown) => JSON.stringify(t)).join('\n') + '\n', 'utf-8');
      console.log(`\x1b[36m→ Queue task ${id}: ${status}\x1b[0m`);
    }
  });
}
