/**
 * Assistant tool definitions and executor.
 * These are the tools the AI assistant uses to manage bots,
 * queues, and the flow-weaver ecosystem.
 */

import type { ToolDefinition, ToolExecutor } from '@synergenius/flow-weaver/agent';
import { BotManager } from './bot-manager.js';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Shared bot manager instance
let manager: BotManager | null = null;
function getManager(): BotManager {
  if (!manager) manager = new BotManager();
  return manager;
}

export const ASSISTANT_TOOLS: ToolDefinition[] = [
  // Bot management
  {
    name: 'bot_spawn',
    description: 'Start a new bot session. Returns the bot name and status.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique name for this bot (e.g. "fix-templates")' },
        project_dir: { type: 'string', description: 'Project directory for the bot to work in' },
        parallel: { type: 'number', description: 'Number of parallel tasks (1-5, default 1)' },
        deadline: { type: 'string', description: 'Stop time in HH:MM format (optional)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'bot_list',
    description: 'List all bot sessions with their status, task counts, and cost.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'bot_status',
    description: 'Get detailed status of a specific bot including queue and recent activity.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Bot name' } },
      required: ['name'],
    },
  },
  {
    name: 'bot_pause',
    description: 'Pause a running bot. It will finish its current task then wait.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Bot name' } },
      required: ['name'],
    },
  },
  {
    name: 'bot_resume',
    description: 'Resume a paused bot.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Bot name' } },
      required: ['name'],
    },
  },
  {
    name: 'bot_stop',
    description: 'Gracefully stop a bot (finishes current task, then exits).',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Bot name' } },
      required: ['name'],
    },
  },
  {
    name: 'bot_logs',
    description: 'Get recent output log from a bot.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Bot name' },
        lines: { type: 'number', description: 'Number of lines to return (default 30)' },
      },
      required: ['name'],
    },
  },

  // Queue management
  {
    name: 'queue_add',
    description: 'Add a task to a bot\'s queue.',
    inputSchema: {
      type: 'object',
      properties: {
        bot: { type: 'string', description: 'Bot name' },
        instruction: { type: 'string', description: 'Task instruction' },
        targets: { type: 'array', items: { type: 'string' }, description: 'Target files (optional)' },
      },
      required: ['bot', 'instruction'],
    },
  },
  {
    name: 'queue_add_batch',
    description: 'Add multiple tasks to a bot\'s queue at once.',
    inputSchema: {
      type: 'object',
      properties: {
        bot: { type: 'string', description: 'Bot name' },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              instruction: { type: 'string' },
              targets: { type: 'array', items: { type: 'string' } },
            },
            required: ['instruction'],
          },
          description: 'Array of tasks to add',
        },
      },
      required: ['bot', 'tasks'],
    },
  },
  {
    name: 'queue_list',
    description: 'List all tasks in a bot\'s queue with their status.',
    inputSchema: {
      type: 'object',
      properties: { bot: { type: 'string', description: 'Bot name' } },
      required: ['bot'],
    },
  },
  {
    name: 'queue_retry',
    description: 'Reset all failed tasks in a bot\'s queue to pending.',
    inputSchema: {
      type: 'object',
      properties: { bot: { type: 'string', description: 'Bot name' } },
      required: ['bot'],
    },
  },

  // Flow-weaver tools
  {
    name: 'fw_validate',
    description: 'Validate a workflow or directory of workflows. Returns errors and warnings.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File or directory path' } },
      required: ['path'],
    },
  },
  {
    name: 'fw_diagram',
    description: 'Generate a text diagram of a workflow.',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string', description: 'Workflow file path' } },
      required: ['file'],
    },
  },
  {
    name: 'fw_describe',
    description: 'Get a natural language description of a workflow.',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string', description: 'Workflow file path' } },
      required: ['file'],
    },
  },

  // Project tools
  {
    name: 'read_file',
    description: 'Read a file and return its contents.',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string', description: 'File path' } },
      required: ['file'],
    },
  },
  {
    name: 'list_files',
    description: 'List files in a directory.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Directory path' },
        pattern: { type: 'string', description: 'Filter pattern (regex, optional)' },
      },
      required: ['directory'],
    },
  },
  {
    name: 'run_shell',
    description: 'Run a shell command (read-only operations recommended).',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Shell command to execute' } },
      required: ['command'],
    },
  },

  // Conversation management
  {
    name: 'conversation_list',
    description: 'List saved assistant conversations with message counts and timestamps.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'conversation_delete',
    description: 'Delete a saved conversation by ID.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Conversation ID to delete' } },
      required: ['id'],
    },
  },
  {
    name: 'conversation_summary',
    description: 'Get a summary of the current conversation (message count, tokens, bots spawned).',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

export function createAssistantExecutor(projectDir: string): ToolExecutor {
  const mgr = getManager();

  return async (name: string, args: Record<string, unknown>) => {
    try {
      switch (name) {
        // Bot management
        case 'bot_spawn': {
          const botName = String(args.name ?? `bot-${Date.now()}`);
          const dir = String(args.project_dir ?? projectDir);
          const bot = mgr.spawn(botName, {
            projectDir: dir,
            parallel: args.parallel as number | undefined,
            deadline: args.deadline as string | undefined,
          });
          return { result: JSON.stringify(bot), isError: false };
        }
        case 'bot_list': {
          const bots = mgr.list();
          if (bots.length === 0) return { result: 'No bots running.', isError: false };
          const lines = bots.map(b => {
            const uptime = Math.round((Date.now() - b.startedAt) / 1000);
            return `${b.name}: ${b.status} (pid ${b.pid}, ${uptime}s uptime)`;
          });
          return { result: lines.join('\n'), isError: false };
        }
        case 'bot_status': {
          const botName = String(args.name);
          const bot = mgr.get(botName);
          if (!bot) return { result: `Bot "${botName}" not found.`, isError: true };
          const queue = mgr.getQueue(botName);
          const tasks = await queue.list();
          const pending = tasks.filter(t => t.status === 'pending').length;
          const running = tasks.filter(t => t.status === 'running').length;
          const completed = tasks.filter(t => t.status === 'completed').length;
          const failed = tasks.filter(t => t.status === 'failed').length;
          const failedTasks = tasks.filter(t => t.status === 'failed');
          let result = `Bot "${botName}": ${bot.status}\n`;
          result += `Tasks: ${completed} completed, ${failed} failed, ${running} running, ${pending} pending\n`;
          if (failedTasks.length > 0) {
            result += `\nFailed tasks:\n`;
            for (const t of failedTasks) {
              result += `  - ${t.instruction.slice(0, 80)}\n`;
            }
          }
          return { result, isError: false };
        }
        case 'bot_pause': {
          await mgr.steer(String(args.name), 'pause');
          return { result: `Paused bot "${args.name}".`, isError: false };
        }
        case 'bot_resume': {
          await mgr.steer(String(args.name), 'resume');
          return { result: `Resumed bot "${args.name}".`, isError: false };
        }
        case 'bot_stop': {
          mgr.stop(String(args.name));
          return { result: `Stopping bot "${args.name}" (will finish current task).`, isError: false };
        }
        case 'bot_logs': {
          const logs = mgr.logs(String(args.name), (args.lines as number) ?? 30);
          return { result: logs || '(no output yet)', isError: false };
        }

        // Queue management
        case 'queue_add': {
          const queue = mgr.getQueue(String(args.bot));
          const id = await queue.add({
            instruction: String(args.instruction),
            targets: args.targets as string[] | undefined,
            priority: 0,
          });
          return { result: `Added task ${id} to "${args.bot}" queue.`, isError: false };
        }
        case 'queue_add_batch': {
          const queue = mgr.getQueue(String(args.bot));
          const tasks = args.tasks as Array<{ instruction: string; targets?: string[] }>;
          const ids: string[] = [];
          for (const t of tasks) {
            const id = await queue.add({ instruction: t.instruction, targets: t.targets, priority: 0 });
            ids.push(id);
          }
          return { result: `Added ${ids.length} tasks to "${args.bot}" queue.`, isError: false };
        }
        case 'queue_list': {
          const queue = mgr.getQueue(String(args.bot));
          const tasks = await queue.list();
          if (tasks.length === 0) return { result: 'Queue is empty.', isError: false };
          const lines = tasks.map(t => `[${t.status}] ${t.instruction.slice(0, 70)}`);
          return { result: lines.join('\n'), isError: false };
        }
        case 'queue_retry': {
          const queue = mgr.getQueue(String(args.bot));
          const count = await queue.retryAll();
          return { result: `Reset ${count} failed task(s) to pending.`, isError: false };
        }

        // Flow-weaver tools
        case 'fw_validate': {
          const output = execFileSync('npx', ['flow-weaver', 'validate', String(args.path)], {
            encoding: 'utf-8', cwd: projectDir, timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'],
          });
          return { result: output.trim() || 'Validation complete.', isError: false };
        }
        case 'fw_diagram': {
          const output = execFileSync('npx', ['flow-weaver', 'diagram', String(args.file)], {
            encoding: 'utf-8', cwd: projectDir, timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'],
          });
          return { result: output.trim(), isError: false };
        }
        case 'fw_describe': {
          const output = execFileSync('npx', ['flow-weaver', 'describe', String(args.file)], {
            encoding: 'utf-8', cwd: projectDir, timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'],
          });
          return { result: output.trim(), isError: false };
        }

        // Project tools
        case 'read_file': {
          const filePath = path.isAbsolute(String(args.file)) ? String(args.file) : path.resolve(projectDir, String(args.file));
          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) {
            const entries = fs.readdirSync(filePath).slice(0, 100);
            return { result: `Directory listing (${entries.length} entries):\n${entries.join('\n')}`, isError: false };
          }
          if (stat.size > 1_048_576) return { result: 'File too large (>1MB).', isError: true };
          return { result: fs.readFileSync(filePath, 'utf-8'), isError: false };
        }
        case 'list_files': {
          const dir = path.isAbsolute(String(args.directory)) ? String(args.directory) : path.resolve(projectDir, String(args.directory));
          if (!fs.existsSync(dir)) return { result: `Directory not found: ${dir}`, isError: true };
          let entries = fs.readdirSync(dir, { recursive: false }) as string[];
          if (args.pattern) {
            const re = new RegExp(String(args.pattern));
            entries = entries.filter(e => re.test(e));
          }
          return { result: entries.slice(0, 200).join('\n') || '(empty)', isError: false };
        }
        case 'run_shell': {
          const cmd = String(args.command);
          // Safety: block destructive commands
          const blocked = ['rm -rf', 'git push', 'npm publish', 'sudo', 'curl|sh', 'wget|sh'];
          if (blocked.some(b => cmd.includes(b))) {
            return { result: `Blocked: "${cmd}" is not allowed.`, isError: true };
          }
          const output = execFileSync('sh', ['-c', cmd], {
            encoding: 'utf-8', cwd: projectDir, timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'],
          });
          return { result: output.trim().slice(0, 5000) || '(no output)', isError: false };
        }

        // Conversation management
        case 'conversation_list': {
          const { ConversationStore } = await import('./conversation-store.js');
          const cStore = new ConversationStore();
          const convos = cStore.list();
          if (convos.length === 0) return { result: 'No saved conversations.', isError: false };
          const lines = convos.map(cv => {
            const ago = Math.round((Date.now() - cv.lastMessageAt) / 60_000);
            const agoStr = ago < 60 ? `${ago}m ago` : ago < 1440 ? `${Math.round(ago / 60)}h ago` : `${Math.round(ago / 1440)}d ago`;
            const title = cv.title || '(untitled)';
            return `${cv.id}  "${title}"  ${cv.messageCount} msgs  ${agoStr}`;
          });
          return { result: `Conversations (${convos.length}):\n${lines.join('\n')}`, isError: false };
        }
        case 'conversation_delete': {
          const { ConversationStore } = await import('./conversation-store.js');
          const cStore = new ConversationStore();
          const existing = cStore.get(String(args.id));
          if (!existing) return { result: `Conversation "${args.id}" not found.`, isError: true };
          cStore.delete(String(args.id));
          return { result: `Deleted conversation "${args.id}" (${existing.title || 'untitled'}).`, isError: false };
        }
        case 'conversation_summary': {
          const { ConversationStore } = await import('./conversation-store.js');
          const cStore = new ConversationStore();
          const recent = cStore.getMostRecent();
          if (!recent) return { result: 'No active conversation.', isError: false };
          const elapsed = Math.round((Date.now() - recent.createdAt) / 60_000);
          return {
            result: `Current conversation: ${recent.id}\n  Title: ${recent.title || '(untitled)'}\n  Messages: ${recent.messageCount}\n  Tokens: ${recent.totalTokens}\n  Bots: ${recent.botIds.length > 0 ? recent.botIds.join(', ') : 'none'}\n  Duration: ${elapsed}m`,
            isError: false,
          };
        }

        default:
          return { result: `Unknown tool: ${name}`, isError: true };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: msg.slice(0, 500), isError: true };
    }
  };
}
