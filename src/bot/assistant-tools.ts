/**
 * Assistant tool definitions and executor.
 * These are the tools the AI assistant uses to manage bots,
 * queues, and the flow-weaver ecosystem.
 */

import type { ToolDefinition, ToolExecutor } from '@synergenius/flow-weaver/agent';
import { BotManager } from './bot-manager.js';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ASSISTANT_TOOLS } from './tool-registry.js';
import { isBlockedCommand, isBlockedUrl } from './safety.js';

export { ASSISTANT_TOOLS };

// Shared bot manager instance
let manager: BotManager | null = null;
function getManager(): BotManager {
  if (!manager) manager = new BotManager();
  return manager;
}

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
            branch: args.branch as string | undefined,
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
          const { id, duplicate } = await queue.add({
            instruction: String(args.instruction),
            targets: args.targets as string[] | undefined,
            priority: 0,
          });
          if (duplicate) return { result: `Task already queued (${id}).`, isError: false };
          return { result: `Added task ${id} to "${args.bot}" queue.`, isError: false };
        }
        case 'queue_add_batch': {
          const queue = mgr.getQueue(String(args.bot));
          const tasks = args.tasks as Array<{ instruction: string; targets?: string[] }>;
          let added = 0, skipped = 0;
          for (const t of tasks) {
            const { duplicate } = await queue.add({ instruction: t.instruction, targets: t.targets, priority: 0 });
            if (duplicate) skipped++; else added++;
          }
          const msg = skipped > 0 ? `Added ${added} tasks, ${skipped} duplicates skipped.` : `Added ${added} tasks to "${args.bot}" queue.`;
          return { result: msg, isError: false };
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
          const output = execFileSync('npx', ['flow-weaver', 'diagram', String(args.file), '--format', 'ascii-compact'], {
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
        case 'fw_docs': {
          const output = execFileSync('npx', ['flow-weaver', 'docs', String(args.topic), '--compact'], {
            encoding: 'utf-8', cwd: projectDir, timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'],
          });
          return { result: output.trim().slice(0, 5000), isError: false };
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
          if (isBlockedCommand(cmd)) {
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

        case 'web_fetch': {
          const url = String(args.url);
          if (isBlockedUrl(url)) {
            return { result: 'Blocked: cannot fetch internal/localhost URLs.', isError: true };
          }
          const resp = await fetch(url, { method: (args.method as string) ?? 'GET', signal: AbortSignal.timeout(15_000) });
          const text = await resp.text();
          return { result: text.slice(0, 10_000), isError: !resp.ok };
        }

        case 'github_status': {
          const ghArgs = args.pr
            ? ['pr', 'checks', String(args.pr), '--json', 'name,state,conclusion']
            : ['run', 'list', '--branch', String(args.branch ?? ''), '--json', 'status,conclusion,name,headBranch', '--limit', '5'];
          try {
            const output = execFileSync('gh', ghArgs, { encoding: 'utf-8', cwd: projectDir, timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] });
            return { result: output.trim(), isError: false };
          } catch (err: any) {
            return { result: `gh CLI error: ${(err.message ?? '').slice(0, 300)}`, isError: true };
          }
        }

        case 'project_list': {
          const projectsDir = path.join(os.homedir(), '.weaver', 'projects');
          if (!fs.existsSync(projectsDir)) return { result: 'No projects found.', isError: false };
          const dirs = fs.readdirSync(projectsDir);
          // Each dir is a hash — try to find meta or queue files
          const projects = dirs.map(d => {
            const queuePath = path.join(projectsDir, d, 'task-queue.ndjson');
            const exists = fs.existsSync(queuePath);
            return `${d}: ${exists ? 'has queue' : 'empty'}`;
          });
          return { result: projects.join('\n') || 'No projects found.', isError: false };
        }

        case 'project_context': {
          const dir = String(args.directory);
          const parts: string[] = [];
          const pkgPath = path.join(dir, 'package.json');
          if (fs.existsSync(pkgPath)) {
            try {
              const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
              parts.push(`Package: ${pkg.name}@${pkg.version}`);
              parts.push(`Description: ${pkg.description ?? 'none'}`);
            } catch { parts.push('package.json: parse error'); }
          }
          const planPath = path.join(dir, '.weaver-plan.md');
          if (fs.existsSync(planPath)) {
            parts.push(`Plan:\n${fs.readFileSync(planPath, 'utf-8').slice(0, 2000)}`);
          }
          const configPath = path.join(dir, '.weaver.json');
          if (fs.existsSync(configPath)) {
            parts.push(`Weaver config: ${fs.readFileSync(configPath, 'utf-8').trim()}`);
          }
          return { result: parts.join('\n') || `No context found in ${dir}`, isError: false };
        }

        case 'fw_diagram_mermaid': {
          try {
            // Try mermaid format first, fall back to text
            let output: string;
            try {
              output = execFileSync('npx', ['flow-weaver', 'diagram', String(args.file), '--format', 'mermaid'], {
                encoding: 'utf-8', cwd: projectDir, timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'],
              }).trim();
            } catch {
              output = execFileSync('npx', ['flow-weaver', 'diagram', String(args.file)], {
                encoding: 'utf-8', cwd: projectDir, timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'],
              }).trim();
            }
            return { result: output, isError: false };
          } catch (err: any) {
            return { result: (err.message ?? '').slice(0, 500), isError: true };
          }
        }

        case 'knowledge_list': {
          const { KnowledgeStore } = await import('./knowledge-store.js');
          const kStore = new KnowledgeStore(projectDir);
          const entries = kStore.list();
          if (entries.length === 0) return { result: 'No stored knowledge.', isError: false };
          return { result: entries.map(e => `${e.key}: ${e.value}`).join('\n'), isError: false };
        }

        case 'knowledge_search': {
          const { KnowledgeStore } = await import('./knowledge-store.js');
          const kStore = new KnowledgeStore(projectDir);
          const entries = kStore.recall(String(args.query));
          if (entries.length === 0) return { result: 'No matching knowledge found.', isError: false };
          return { result: entries.map(e => `${e.key}: ${e.value}`).join('\n'), isError: false };
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
