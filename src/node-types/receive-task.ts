import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { WeaverEnv, WeaverContext } from '../bot/types.js';
import { withFileLock } from '../bot/file-lock.js';

interface QueuedTask {
  id: string;
  instruction: string;
  mode?: 'create' | 'modify' | 'read' | 'batch';
  targets?: string[];
  options?: Record<string, unknown>;
  priority: number;
  addedAt: number;
  status: string;
}

/**
 * Receives a task from CLI args, MCP tool call, or the task queue.
 * Parses the instruction into a structured BotTask. Creates the
 * WeaverContext that threads through the bot pipeline.
 *
 * @flowWeaver nodeType
 * @label Receive Task
 * @input env [order:0] - Weaver environment bundle
 * @input [taskJson] [order:1] - Pre-supplied task (JSON, optional)
 * @output ctx [order:0] - Weaver context (JSON)
 * @output onSuccess [order:-2] - On Success
 * @output onFailure [order:-1] [hidden] - On Failure
 */
export async function weaverReceiveTask(
  execute: boolean,
  env: WeaverEnv,
  taskJson?: string,
): Promise<{
  onSuccess: boolean; onFailure: boolean;
  ctx: string;
}> {
  const context: WeaverContext = { env, taskJson: '{}', hasTask: false };

  if (!execute) {
    return { onSuccess: true, onFailure: false, ctx: JSON.stringify(context) };
  }

  // If taskJson is pre-supplied, use it directly
  if (taskJson) {
    try {
      const parsed = JSON.parse(taskJson);
      if (parsed.instruction) {
        console.log(`\x1b[36m→ Task received: ${parsed.instruction.slice(0, 80)}\x1b[0m`);
        context.taskJson = taskJson;
        context.hasTask = true;
        return { onSuccess: true, onFailure: false, ctx: JSON.stringify(context) };
      }
    } catch { /* fall through to queue check */ }
  }

  // Check task queue (with file locking to prevent race conditions)
  const queuePath = path.join(os.homedir(), '.weaver', 'task-queue.ndjson');
  try {
    const claimed = await withFileLock(queuePath, () => {
      if (!fs.existsSync(queuePath)) return null;
      const content = fs.readFileSync(queuePath, 'utf-8').trim();
      if (!content) return null;

      const tasks: QueuedTask[] = content.split('\n').filter(Boolean).map(l => JSON.parse(l));
      const pending = tasks
        .filter(t => t.status === 'pending')
        .sort((a, b) => b.priority - a.priority || a.addedAt - b.addedAt);

      if (pending.length === 0) return null;

      const task = pending[0]!;
      // Atomically mark as running inside the lock
      const updated = tasks.map(t => t.id === task.id ? { ...t, status: 'running' } : t);
      fs.writeFileSync(queuePath, updated.map(t => JSON.stringify(t)).join('\n') + '\n', 'utf-8');
      return task;
    });

    if (claimed) {
      const botTask = {
        instruction: claimed.instruction,
        mode: claimed.mode ?? 'create',
        targets: claimed.targets,
        options: claimed.options,
        queueId: claimed.id,
      };
      console.log(`\x1b[36m→ Task from queue [${claimed.id}]: ${claimed.instruction.slice(0, 80)}\x1b[0m`);
      context.taskJson = JSON.stringify(botTask);
      context.hasTask = true;
      return { onSuccess: true, onFailure: false, ctx: JSON.stringify(context) };
    }
  } catch (err) { if (process.env.WEAVER_VERBOSE) console.error('[receive-task] queue error:', err); }

  console.log('\x1b[33m→ No task found\x1b[0m');
  return { onSuccess: false, onFailure: true, ctx: JSON.stringify(context) };
}
