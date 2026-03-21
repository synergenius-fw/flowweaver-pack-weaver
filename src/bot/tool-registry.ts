/**
 * Unified tool registry — single source of truth for all weaver tool definitions.
 * Merges assistant-tools.ts ASSISTANT_TOOLS and weaver-tools.ts WEAVER_TOOLS
 * into one registry with metadata (category, contexts, verboseOutput).
 */

import type { ToolDefinition } from '@synergenius/flow-weaver/agent';

export interface WeaverTool extends ToolDefinition {
  verboseOutput?: boolean;
  category: 'bot-management' | 'queue' | 'flow-weaver' | 'project' | 'knowledge' | 'conversation' | 'ci' | 'web' | 'overseer';
  contexts: Array<'bot' | 'assistant'>;
}

export const ALL_TOOLS: WeaverTool[] = [
  // ── Bot management (assistant only) ──────────────────────────────
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
        branch: { type: 'string', description: 'Git branch for commits (keeps main clean, good for overnight runs)' },
      },
      required: ['name'],
    },
    category: 'bot-management',
    contexts: ['assistant'],
  },
  {
    name: 'bot_list',
    description: 'List all bot sessions with their status, task counts, and cost.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    category: 'bot-management',
    contexts: ['assistant'],
  },
  {
    name: 'bot_status',
    description: 'Get detailed status of a specific bot including queue and recent activity.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Bot name' } },
      required: ['name'],
    },
    category: 'bot-management',
    contexts: ['assistant'],
  },
  {
    name: 'bot_pause',
    description: 'Pause a running bot. It will finish its current task then wait.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Bot name' } },
      required: ['name'],
    },
    category: 'bot-management',
    contexts: ['assistant'],
  },
  {
    name: 'bot_resume',
    description: 'Resume a paused bot.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Bot name' } },
      required: ['name'],
    },
    category: 'bot-management',
    contexts: ['assistant'],
  },
  {
    name: 'bot_stop',
    description: 'Gracefully stop a bot (finishes current task, then exits).',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Bot name' } },
      required: ['name'],
    },
    category: 'bot-management',
    contexts: ['assistant'],
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
    verboseOutput: true,
    category: 'bot-management',
    contexts: ['assistant'],
  },

  // ── Queue management (assistant only) ────────────────────────────
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
    category: 'queue',
    contexts: ['assistant'],
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
    category: 'queue',
    contexts: ['assistant'],
  },
  {
    name: 'queue_list',
    description: 'List all tasks in a bot\'s queue with their status.',
    inputSchema: {
      type: 'object',
      properties: { bot: { type: 'string', description: 'Bot name' } },
      required: ['bot'],
    },
    category: 'queue',
    contexts: ['assistant'],
  },
  {
    name: 'queue_retry',
    description: 'Reset all failed tasks in a bot\'s queue to pending.',
    inputSchema: {
      type: 'object',
      properties: { bot: { type: 'string', description: 'Bot name' } },
      required: ['bot'],
    },
    category: 'queue',
    contexts: ['assistant'],
  },

  // ── Flow-weaver tools ────────────────────────────────────────────
  {
    name: 'validate',
    description: 'Run flow-weaver validate on a workflow file. Returns JSON with errors and warnings. Use this FIRST to discover issues, and AFTER patching to confirm fixes.',
    inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'Path to the workflow file to validate' } }, required: ['file'] },
    category: 'flow-weaver',
    contexts: ['bot'],
  },
  {
    name: 'fw_validate',
    description: 'Validate a workflow or directory of workflows. Returns errors and warnings.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File or directory path' } },
      required: ['path'],
    },
    category: 'flow-weaver',
    contexts: ['assistant'],
  },
  {
    name: 'fw_diagram',
    description: 'Generate a text diagram of a workflow.',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string', description: 'Workflow file path' } },
      required: ['file'],
    },
    verboseOutput: true,
    category: 'flow-weaver',
    contexts: ['assistant'],
  },
  {
    name: 'fw_describe',
    description: 'Get a natural language description of a workflow.',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string', description: 'Workflow file path' } },
      required: ['file'],
    },
    verboseOutput: true,
    category: 'flow-weaver',
    contexts: ['assistant'],
  },
  {
    name: 'fw_docs',
    description: 'Look up Flow Weaver documentation by topic. Topics: concepts, jsdoc-grammar, advanced-annotations, built-in-nodes, scaffold, node-conversion, patterns, error-codes, debugging, export-interface.',
    inputSchema: {
      type: 'object',
      properties: { topic: { type: 'string', description: 'Documentation topic slug' } },
      required: ['topic'],
    },
    verboseOutput: true,
    category: 'flow-weaver',
    contexts: ['assistant'],
  },
  {
    name: 'fw_diagram_mermaid',
    description: 'Generate a Mermaid diagram of a workflow (can be rendered in any Mermaid viewer).',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string', description: 'Workflow file path' } },
      required: ['file'],
    },
    verboseOutput: true,
    category: 'flow-weaver',
    contexts: ['assistant'],
  },

  // ── Project tools (shared or context-specific) ───────────────────
  {
    name: 'read_file',
    description: 'Read a file and return its contents.',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string', description: 'File path' } },
      required: ['file'],
    },
    category: 'project',
    contexts: ['bot', 'assistant'],
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
    category: 'project',
    contexts: ['bot', 'assistant'],
  },
  {
    name: 'run_shell',
    description: 'Run a shell command (read-only operations recommended). Blocked: rm -rf, git push, sudo.',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Shell command to execute' } },
      required: ['command'],
    },
    category: 'project',
    contexts: ['bot', 'assistant'],
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
    category: 'project',
    contexts: ['bot'],
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
    category: 'project',
    contexts: ['bot'],
  },
  {
    name: 'tsc_check',
    description: 'Run TypeScript compiler check (no emit). Returns errors if any.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    verboseOutput: true,
    category: 'project',
    contexts: ['bot'],
  },
  {
    name: 'run_tests',
    description: 'Run project tests. Returns structured results with pass/fail counts.',
    inputSchema: { type: 'object', properties: { pattern: { type: 'string', description: 'Test file pattern (optional)' } }, required: [] },
    verboseOutput: true,
    category: 'project',
    contexts: ['bot'],
  },
  {
    name: 'project_list',
    description: 'List known project directories that have been used with weaver.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    category: 'project',
    contexts: ['assistant'],
  },
  {
    name: 'project_context',
    description: 'Read package.json and .weaver-plan.md from a project directory to understand its context.',
    inputSchema: {
      type: 'object',
      properties: { directory: { type: 'string', description: 'Absolute path to project directory' } },
      required: ['directory'],
    },
    category: 'project',
    contexts: ['assistant'],
  },

  // ── Knowledge tools ──────────────────────────────────────────────
  {
    name: 'knowledge_list',
    description: 'List all stored knowledge entries for the current project.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    category: 'knowledge',
    contexts: ['assistant'],
  },
  {
    name: 'knowledge_search',
    description: 'Search stored knowledge by keyword.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query' } },
      required: ['query'],
    },
    category: 'knowledge',
    contexts: ['assistant'],
  },
  {
    name: 'learn',
    description: 'Store a fact for future tasks. Key should be descriptive (e.g. "file:src/agent.ts:port-issue").',
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] },
    category: 'knowledge',
    contexts: ['bot'],
  },
  {
    name: 'recall',
    description: 'Look up stored knowledge. Returns matching entries.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    category: 'knowledge',
    contexts: ['bot'],
  },

  // ── Conversation management (assistant only) ─────────────────────
  {
    name: 'conversation_list',
    description: 'List saved assistant conversations with message counts and timestamps.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    category: 'conversation',
    contexts: ['assistant'],
  },
  {
    name: 'conversation_delete',
    description: 'Delete a saved conversation by ID.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Conversation ID to delete' } },
      required: ['id'],
    },
    category: 'conversation',
    contexts: ['assistant'],
  },
  {
    name: 'conversation_summary',
    description: 'Get a summary of the current conversation (message count, tokens, bots spawned).',
    inputSchema: { type: 'object', properties: {}, required: [] },
    category: 'conversation',
    contexts: ['assistant'],
  },

  // ── CI/CD (assistant only) ───────────────────────────────────────
  {
    name: 'github_status',
    description: 'Check GitHub Actions status for a branch or PR. Requires gh CLI installed.',
    inputSchema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Branch name (optional, defaults to current)' },
        pr: { type: 'number', description: 'PR number (optional, checks PR status instead of branch)' },
      },
      required: [],
    },
    category: 'ci',
    contexts: ['assistant'],
  },

  // ── Web access (shared) ──────────────────────────────────────────
  {
    name: 'web_fetch',
    description: 'Fetch HTTP content from a URL. Returns text body (max 10KB).',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
        method: { type: 'string', description: 'HTTP method (default GET)', enum: ['GET', 'POST'] },
      },
      required: ['url'],
    },
    category: 'web',
    contexts: ['bot', 'assistant'],
  },

  // ── Overseer tools (assistant only) ─────────────────────────────
  {
    name: 'project_health',
    description: 'Get project health: workflow scores, bot performance, failure patterns, cost trends, trust level.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    category: 'overseer',
    contexts: ['assistant'],
  },
  {
    name: 'project_insights',
    description: 'Get actionable insights: recurring failures, degrading workflows, cost optimizations, evolution opportunities.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max insights (default 5)' } },
      required: [],
    },
    category: 'overseer',
    contexts: ['assistant'],
  },
  {
    name: 'evolution_status',
    description: 'Get genesis evolution history: cycle outcomes, operation effectiveness, recent proposals.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    category: 'overseer',
    contexts: ['assistant'],
  },
  {
    name: 'genesis_propose',
    description: 'Generate a Genesis evolution proposal for a bot workflow based on project insights. Auto-ejects bot if needed.',
    inputSchema: {
      type: 'object',
      properties: {
        bot: { type: 'string', description: 'Bot name (default: weaver-bot)' },
        focus: { type: 'string', description: 'Optional focus area for the proposal' },
        budget: { type: 'number', description: 'Cost unit budget (default: from config)' },
      },
      required: [],
    },
    category: 'overseer',
    contexts: ['assistant'],
  },
  {
    name: 'genesis_apply',
    description: 'Apply an approved Genesis proposal to the bot workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        proposal_id: { type: 'string', description: 'Proposal ID from genesis_propose' },
      },
      required: ['proposal_id'],
    },
    category: 'overseer',
    contexts: ['assistant'],
  },

  // ── Bot-only interactive ─────────────────────────────────────────
  {
    name: 'ask_user',
    description: 'Ask the user a question and wait for response. Use when you need a decision.',
    inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
    category: 'project',
    contexts: ['bot'],
  },
];

// ── Derived exports ──────────────────────────────────────────────────

export const BOT_TOOLS: ToolDefinition[] = ALL_TOOLS.filter(t => t.contexts.includes('bot'));
export const ASSISTANT_TOOLS: ToolDefinition[] = ALL_TOOLS.filter(t => t.contexts.includes('assistant'));
export const VERBOSE_TOOL_NAMES = new Set(ALL_TOOLS.filter(t => t.verboseOutput).map(t => t.name));

/**
 * Generate a prompt section grouping assistant tools by category.
 */
export function generateToolPromptSection(): string {
  const groups = new Map<string, WeaverTool[]>();
  for (const t of ALL_TOOLS.filter(t => t.contexts.includes('assistant'))) {
    const list = groups.get(t.category) ?? [];
    list.push(t);
    groups.set(t.category, list);
  }
  const lines: string[] = [];
  for (const [cat, tools] of groups) {
    lines.push(`${cat}:`);
    for (const t of tools) lines.push(`  - ${t.name}: ${t.description}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Generate a comma-separated list of tools that produce verbose output.
 */
export function generateVerboseToolList(): string {
  return [...VERBOSE_TOOL_NAMES].join(', ');
}
