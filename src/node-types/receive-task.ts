import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

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
 * @input projectDir [order:0] - Project root directory
 * @input config [order:1] - Weaver configuration (JSON)
 * @input providerType [order:2] - Provider type (pass-through)
 * @input providerInfo [order:3] - Provider info (JSON, pass-through)
 * @input [taskJson] [order:4] - Pre-supplied task (JSON, optional)
 * @output projectDir [order:0] - Project root directory (pass-through)
 * @output config [order:1] - Config (pass-through)
 * @output providerType [order:2] - Provider type (pass-through)
 * @output providerInfo [order:3] - Provider info (pass-through)
 * @output taskJson [order:4] - Parsed task (JSON)
 * @output hasTask [order:5] - Whether a task was found
 * @output onSuccess [order:-2] - On Success
 * @output onFailure [order:-1] - On Failure
 */
export async function weaverReceiveTask(
  execute: boolean,
  projectDir: string,
  config: string,
  providerType: string,
  providerInfo: string,
  taskJson?: string,
): Promise<{
  onSuccess: boolean; onFailure: boolean;
  projectDir: string; config: string; providerType: string; providerInfo: string;
  taskJson: string; hasTask: boolean;
}> {
  const passthrough = { projectDir, config, providerType, providerInfo };

  if (!execute) {
    return { onSuccess: true, onFailure: false, ...passthrough, taskJson: '{}', hasTask: false };
  }

  // If taskJson is pre-supplied, use it directly
  if (taskJson) {
    try {
      const parsed = JSON.parse(taskJson);
      if (parsed.instruction) {
        console.log(`\x1b[36m→ Task received: ${parsed.instruction.slice(0, 80)}\x1b[0m`);
        return { onSuccess: true, onFailure: false, ...passthrough, taskJson, hasTask: true };
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
          return { onSuccess: true, onFailure: false, ...passthrough, taskJson: JSON.stringify(botTask), hasTask: true };
        }
      }
    }
  } catch { /* ignore queue errors */ }

  console.log('\x1b[33m→ No task found\x1b[0m');
  return { onSuccess: false, onFailure: true, ...passthrough, taskJson: '{}', hasTask: false };
}
