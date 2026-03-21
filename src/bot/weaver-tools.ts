/**
 * Weaver-specific tool definitions and executor.
 *
 * These are the tools the weaver bot uses: validate, read_file, patch_file,
 * run_shell, list_files, write_file. Tool execution delegates to step-executor
 * with all safety guards (path traversal, shrink detection, blocked commands).
 */

import { execFileSync } from 'node:child_process';
import { executeStep } from './step-executor.js';
import type { ToolDefinition } from '@synergenius/flow-weaver/agent';

export const WEAVER_TOOLS: ToolDefinition[] = [
  {
    name: 'validate',
    description: 'Run flow-weaver validate on a workflow file. Returns JSON with errors and warnings. Use this FIRST to discover issues, and AFTER patching to confirm fixes.',
    inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'Path to the workflow file to validate' } }, required: ['file'] },
  },
  {
    name: 'read_file',
    description: 'Read a file and return its full contents. Use this to understand file structure before patching.',
    inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'Path to the file to read' } }, required: ['file'] },
  },
  {
    name: 'patch_file',
    description: 'Apply surgical find-and-replace patches to a file. Each patch must have exact "find" and "replace" strings. Preferred over write_file for modifications.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to the file to patch' },
        patches: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              find: { type: 'string', description: 'Exact string to find' },
              replace: { type: 'string', description: 'String to replace with' },
            },
            required: ['find', 'replace'],
          },
          description: 'Array of find/replace patches',
        },
      },
      required: ['file', 'patches'],
    },
  },
  {
    name: 'run_shell',
    description: 'Execute a shell command and return output. Use for: npx flow-weaver validate, git status, etc. Blocked: rm -rf, git push, sudo.',
    inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'Shell command to execute' } }, required: ['command'] },
  },
  {
    name: 'list_files',
    description: 'List files in a directory, optionally filtered by regex pattern.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Directory to list' },
        pattern: { type: 'string', description: 'Optional regex filter pattern' },
      },
      required: ['directory'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file (creates or overwrites). Use patch_file instead for modifications to existing files.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to the file to write' },
        content: { type: 'string', description: 'Complete file content' },
      },
      required: ['file', 'content'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch HTTP content. Returns text body (max 10KB).',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, method: { type: 'string', enum: ['GET', 'POST'] } }, required: ['url'] },
  },
  {
    name: 'tsc_check',
    description: 'Run TypeScript compiler check (no emit). Returns errors if any.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'run_tests',
    description: 'Run project tests. Returns structured results with pass/fail counts.',
    inputSchema: { type: 'object', properties: { pattern: { type: 'string', description: 'Test file pattern (optional)' } }, required: [] },
  },
  {
    name: 'ask_user',
    description: 'Ask the user a question and wait for response. Use when you need a decision.',
    inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
  },
  {
    name: 'learn',
    description: 'Store a fact for future tasks. Key should be descriptive (e.g. "file:src/agent.ts:port-issue").',
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] },
  },
  {
    name: 'recall',
    description: 'Look up stored knowledge. Returns matching entries.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
];

/** Map tool names to step-executor operations. */
const OPERATION_MAP: Record<string, string> = {
  validate: 'run-shell',
  read_file: 'read-file',
  patch_file: 'patch-file',
  run_shell: 'run-shell',
  list_files: 'list-files',
  write_file: 'write-file',
};

/**
 * Execute a weaver tool call. Delegates to step-executor with safety guards.
 * Bound to a specific project directory via closure.
 */
export function createWeaverExecutor(projectDir: string) {
  return async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ result: string; isError: boolean }> => {
    // Handle new tools that bypass step-executor
    switch (name) {
      case 'web_fetch': {
        const url = String(args.url);
        // Safety: block localhost, internal IPs
        if (/localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d|172\.(1[6-9]|2\d|3[01])\.|192\.168\./i.test(url)) {
          return { result: 'Blocked: cannot fetch internal/localhost URLs.', isError: true };
        }
        const resp = await fetch(url, { method: (args.method as string) ?? 'GET', signal: AbortSignal.timeout(15_000) });
        const text = await resp.text();
        return { result: text.slice(0, 10_000), isError: !resp.ok };
      }

      case 'tsc_check': {
        try {
          const output = execFileSync('npx', ['tsc', '--noEmit', '--pretty'], { cwd: projectDir, encoding: 'utf-8', timeout: 60_000, stdio: ['pipe', 'pipe', 'pipe'] });
          return { result: output.trim() || 'No TypeScript errors.', isError: false };
        } catch (err: any) {
          return { result: (err.stdout ?? err.message ?? '').slice(0, 5000), isError: true };
        }
      }

      case 'run_tests': {
        try {
          const pattern = args.pattern ? String(args.pattern) : '';
          const testArgs = ['vitest', 'run', '--reporter', 'json'];
          if (pattern) testArgs.push(pattern);
          const output = execFileSync('npx', testArgs, { cwd: projectDir, encoding: 'utf-8', timeout: 120_000, stdio: ['pipe', 'pipe', 'pipe'] });
          try {
            const json = JSON.parse(output);
            const passed = json.numPassedTests ?? 0;
            const failed = json.numFailedTests ?? 0;
            const failures = (json.testResults ?? []).filter((t: any) => t.status === 'failed').map((t: any) => t.name).slice(0, 10);
            return { result: JSON.stringify({ passed, failed, total: passed + failed, failures }), isError: failed > 0 };
          } catch {
            return { result: output.slice(0, 5000), isError: false };
          }
        } catch (err: any) {
          return { result: (err.stdout ?? err.stderr ?? err.message ?? '').slice(0, 5000), isError: true };
        }
      }

      case 'ask_user': {
        const question = String(args.question);
        if (process.env.WEAVER_AUTO_APPROVE) {
          return { result: '(Auto-approved — no user input available in autonomous mode)', isError: false };
        }
        // In interactive mode, prompt via readline
        const readline = await import('node:readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
        const answer = await new Promise<string>((resolve) => {
          rl.question(`\n  Bot asks: ${question}\n  > `, (ans) => { rl.close(); resolve(ans); });
        });
        return { result: answer || '(no answer)', isError: false };
      }

      case 'learn': {
        const { KnowledgeStore } = await import('./knowledge-store.js');
        const store = new KnowledgeStore(projectDir);
        store.learn(String(args.key), String(args.value), 'bot');
        return { result: `Learned: ${args.key}`, isError: false };
      }

      case 'recall': {
        const { KnowledgeStore } = await import('./knowledge-store.js');
        const store = new KnowledgeStore(projectDir);
        const entries = store.recall(String(args.query));
        if (entries.length === 0) return { result: 'No knowledge found.', isError: false };
        return { result: entries.map(e => `${e.key}: ${e.value}`).join('\n'), isError: false };
      }

      default:
        break;
    }

    // Existing step-executor-based tools
    const operation = OPERATION_MAP[name];
    if (!operation) {
      return { result: `Unknown tool: ${name}`, isError: true };
    }

    // Transform validate tool to run-shell with flow-weaver validate command
    let stepArgs = { ...args };
    if (name === 'validate') {
      stepArgs = { command: `npx flow-weaver validate ${args.file} --json` };
    }

    try {
      const result = await executeStep({ operation, args: stepArgs }, projectDir);
      if (result.blocked) {
        return { result: result.blockReason ?? 'Blocked by safety guard', isError: true };
      }
      return { result: result.output ?? 'Done', isError: false };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: msg, isError: true };
    }
  };
}
