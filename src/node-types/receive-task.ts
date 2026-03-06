import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { WeaverEnv } from '../bot/types.js';

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
 * Parses the instruction into a structured BotTask.
 *
 * @flowWeaver nodeType
 * @label Receive Task
 * @input env [order:0] - Weaver environment bundle
 * @input [taskJson] [order:1] - Pre-supplied task (JSON, optional)
 * @output env [order:0] - Weaver environment bundle (pass-through)
 * @output taskJson [order:1] - Parsed task (JSON)
 * @output hasTask [order:2] - Whether a task was found
 * @output onSuccess [order:-2] - On Success
 * @output onFailure [order:-1] - On Failure
 */
export async function weaverReceiveTask(
  execute: boolean,
  env: WeaverEnv,
  taskJson?: string,
): Promise<{
  onSuccess: boolean; onFailure: boolean;
  env: WeaverEnv;
  taskJson: string; hasTask: boolean;
}> {
  if (!execute) {
    return { onSuccess: true, onFailure: false, env, taskJson: '{}', hasTask: false };
  }

  // If taskJson is pre-supplied, use it directly
  if (taskJson) {
    try {
      const parsed = JSON.parse(taskJson);
      if (parsed.instruction) {
        console.log(`\x1b[36m→ Task received: ${parsed.instruction.slice(0, 80)}\x1b[0m`);
        return { onSuccess: true, onFailure: false, env, taskJson, hasTask: true };
      }
    } catch { /* fall through to queue check */ }
  }

  // Check task queue
  const queuePath = path.join(os.homedir(), '.weaver', 'task-queue.ndjson');
  try {
    if (fs.existsSync(queuePath)) {
      const content = fs.readFileSync(queuePath, 'utf-8').trim();
      if (content) {
        const tasks: QueuedTask[] = content.split('\n').map(l => JSON.parse(l));
        const pending = tasks
          .filter(t => t.status === 'pending')
          .sort((a, b) => b.priority - a.priority || a.addedAt - b.addedAt);

        if (pending.length > 0) {
          const task = pending[0]!;
          // Mark as running
          const updated = tasks.map(t => t.id === task.id ? { ...t, status: 'running' } : t);
          fs.writeFileSync(queuePath, updated.map(t => JSON.stringify(t)).join('\n') + '\n', 'utf-8');

          const botTask = {
            instruction: task.instruction,
            mode: task.mode ?? 'create',
            targets: task.targets,
            options: task.options,
            queueId: task.id,
          };
          console.log(`\x1b[36m→ Task from queue [${task.id}]: ${task.instruction.slice(0, 80)}\x1b[0m`);
          return { onSuccess: true, onFailure: false, env, taskJson: JSON.stringify(botTask), hasTask: true };
        }
      }
    }
  } catch { /* ignore queue errors */ }

  console.log('\x1b[33m→ No task found\x1b[0m');
  return { onSuccess: false, onFailure: true, env, taskJson: '{}', hasTask: false };
}
