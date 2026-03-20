/**
 * Weaver-specific tool definitions and executor.
 *
 * These are the tools the weaver bot uses: validate, read_file, patch_file,
 * run_shell, list_files, write_file. Tool execution delegates to step-executor
 * with all safety guards (path traversal, shrink detection, blocked commands).
 */

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
