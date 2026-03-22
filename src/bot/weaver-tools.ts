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
import { BOT_TOOLS as WEAVER_TOOLS } from './tool-registry.js';
import { isBlockedUrl } from './safety.js';

export { WEAVER_TOOLS };

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
        if (isBlockedUrl(url)) {
          return { result: 'Blocked: cannot fetch internal/localhost URLs.', isError: true };
        }
        try {
          const resp = await fetch(url, { method: (args.method as string) ?? 'GET', signal: AbortSignal.timeout(15_000) });
          const text = await resp.text();
          return { result: text.slice(0, 10_000), isError: !resp.ok };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return { result: `Fetch error: ${msg}`, isError: true };
        }
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
            // JSON parse failed — output is not structured, flag as error
            return { result: output.slice(0, 5000), isError: true };
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
