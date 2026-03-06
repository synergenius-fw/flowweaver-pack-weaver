import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { runWorkflow } from './bot/runner.js';
import { RunStore } from './bot/run-store.js';
import { CostStore } from './bot/cost-store.js';
import { defaultRegistry, discoverProviders } from './bot/provider-registry.js';

// McpServer type from the SDK, kept loose to avoid hard dependency
type McpServer = {
  tool(
    name: string,
    description: string,
    schema: Record<string, unknown>,
    handler: (args: { [key: string]: unknown }) => Promise<{ content: Array<{ type: string; text: string }> }>,
  ): void;
};

export async function registerMcpTools(mcp: McpServer): Promise<void> {
  mcp.tool(
    'fw_weaver_run',
    'Execute a Flow Weaver workflow with the AI runner. Returns the result summary, outcome, and cost.',
    {
      file: z.string().describe('Path to the workflow file'),
      params: z.record(z.unknown()).optional().describe('Input parameters as key-value pairs'),
      verbose: z.boolean().optional().describe('Show detailed execution info'),
      dryRun: z.boolean().optional().describe('Preview without executing'),
    },
    async (args) => {
      const result = await runWorkflow(args.file as string, {
        params: args.params as Record<string, unknown> | undefined,
        verbose: args.verbose as boolean | undefined,
        dryRun: args.dryRun as boolean | undefined,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  mcp.tool(
    'fw_weaver_history',
    'Query weaver run history. Returns recent workflow executions with outcome, duration, and summary.',
    {
      id: z.string().optional().describe('Specific run ID to look up'),
      limit: z.number().optional().describe('Max number of entries (default 20)'),
      outcome: z.enum(['completed', 'failed', 'error', 'skipped']).optional().describe('Filter by outcome'),
      workflowFile: z.string().optional().describe('Filter by workflow file path'),
    },
    async (args) => {
      const store = new RunStore();

      if (args.id) {
        const record = store.get(args.id as string);
        if (!record) {
          return { content: [{ type: 'text', text: `No run found matching "${args.id}"` }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(record, null, 2) }] };
      }

      const records = store.list({
        outcome: args.outcome as 'completed' | 'failed' | 'error' | 'skipped' | undefined,
        workflowFile: args.workflowFile as string | undefined,
        limit: (args.limit as number | undefined) ?? 20,
      });

      if (records.length === 0) {
        return { content: [{ type: 'text', text: 'No runs recorded yet.' }] };
      }

      return { content: [{ type: 'text', text: JSON.stringify(records, null, 2) }] };
    },
  );

  mcp.tool(
    'fw_weaver_costs',
    'Get AI cost summary across weaver runs. Shows total tokens, estimated cost, and breakdown by model.',
    {
      since: z.string().optional().describe('Filter: duration like "7d", "30d", or ISO-8601 date'),
      model: z.string().optional().describe('Filter by model name'),
    },
    async (args) => {
      const store = new CostStore();
      let sinceTs: number | undefined;

      if (args.since) {
        const spec = args.since as string;
        const match = spec.match(/^(\d+)([dhm])$/);
        if (match) {
          const n = parseInt(match[1]!, 10);
          const unit = match[2];
          const ms = unit === 'd' ? n * 86_400_000 : unit === 'h' ? n * 3_600_000 : n * 60_000;
          sinceTs = Date.now() - ms;
        } else {
          const ts = new Date(spec).getTime();
          if (!isNaN(ts)) sinceTs = ts;
        }
      }

      const summary = store.summarize({ since: sinceTs, model: args.model as string | undefined });
      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
    },
  );

  mcp.tool(
    'fw_weaver_providers',
    'List available AI providers for weaver workflow execution.',
    {},
    async () => {
      await discoverProviders(defaultRegistry);
      const providers = defaultRegistry.list();

      const result = providers.map(({ name, metadata }) => ({
        name,
        source: metadata.source,
        description: metadata.description,
        requiredEnvVars: metadata.requiredEnvVars,
        envVarsSet: metadata.requiredEnvVars?.every((v) => process.env[v]) ?? false,
        detectCliCommand: metadata.detectCliCommand,
      }));

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // --- Bot Tools ---

  mcp.tool(
    'fw_weaver_bot',
    'Run the autonomous bot to create or modify a Flow Weaver workflow. Provide a natural language task description.',
    {
      task: z.string().describe('Natural language task description'),
      projectDir: z.string().optional().describe('Project directory'),
      mode: z.enum(['create', 'modify', 'read', 'batch']).optional().describe('Task mode'),
      targets: z.array(z.string()).optional().describe('Target files for modify/read'),
      template: z.string().optional().describe('Template to use for scaffolding'),
      dryRun: z.boolean().optional().describe('Preview without executing'),
      autoApprove: z.boolean().optional().describe('Skip approval gate'),
    },
    async (args) => {
      const task = {
        instruction: args.task as string,
        mode: (args.mode as string) ?? 'create',
        targets: args.targets as string[] | undefined,
        options: {
          template: args.template as string | undefined,
          dryRun: args.dryRun as boolean | undefined,
          autoApprove: (args.autoApprove as boolean | undefined) ?? true,
        },
      };

      const packRoot = new URL('..', import.meta.url);
      let workflowPath: string;
      try {
        const { existsSync } = await import('node:fs');
        workflowPath = fileURLToPath(new URL('src/workflows/weaver-bot.ts', packRoot));
        if (!existsSync(workflowPath)) {
          workflowPath = fileURLToPath(new URL('dist/workflows/weaver-bot.js', packRoot));
        }
      } catch {
        workflowPath = fileURLToPath(new URL('dist/workflows/weaver-bot.js', packRoot));
      }

      const result = await runWorkflow(
        workflowPath,
        {
          params: { taskJson: JSON.stringify(task), projectDir: (args.projectDir as string) ?? process.cwd() },
          dryRun: args.dryRun as boolean | undefined,
        },
      );

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  mcp.tool(
    'fw_weaver_steer',
    'Send a steering command to a running bot (pause, resume, cancel, redirect, queue).',
    {
      command: z.enum(['pause', 'resume', 'cancel', 'redirect', 'queue']).describe('Steering command'),
      payload: z.string().optional().describe('Payload for redirect/queue commands'),
    },
    async (args) => {
      const { SteeringController } = await import('./bot/steering.js');
      const controller = new SteeringController();
      await controller.write({
        command: args.command as 'pause' | 'resume' | 'cancel' | 'redirect' | 'queue',
        payload: args.payload as string | undefined,
        timestamp: Date.now(),
      });
      return { content: [{ type: 'text', text: `Steering command sent: ${args.command}` }] };
    },
  );

  mcp.tool(
    'fw_weaver_queue',
    'Manage the bot task queue (add, list, clear, remove tasks).',
    {
      action: z.enum(['add', 'list', 'clear', 'remove']).describe('Queue action'),
      task: z.string().optional().describe('Task instruction (for add)'),
      id: z.string().optional().describe('Task ID (for remove)'),
    },
    async (args) => {
      const { TaskQueue } = await import('./bot/task-queue.js');
      const queue = new TaskQueue();

      switch (args.action) {
        case 'add': {
          if (!args.task) return { content: [{ type: 'text', text: 'Error: task instruction required' }] };
          const id = await queue.add({ instruction: args.task as string, priority: 0 });
          return { content: [{ type: 'text', text: `Task added: ${id}` }] };
        }
        case 'list':
          return { content: [{ type: 'text', text: JSON.stringify(await queue.list(), null, 2) }] };
        case 'clear': {
          const count = await queue.clear();
          return { content: [{ type: 'text', text: `Cleared ${count} task(s)` }] };
        }
        case 'remove': {
          if (!args.id) return { content: [{ type: 'text', text: 'Error: task ID required' }] };
          const removed = await queue.remove(args.id as string);
          return { content: [{ type: 'text', text: removed ? `Removed ${args.id}` : `Not found: ${args.id}` }] };
        }
        default:
          return { content: [{ type: 'text', text: `Unknown action: ${args.action}` }] };
      }
    },
  );

  mcp.tool(
    'fw_weaver_status',
    'Get current bot session status (idle/planning/executing/etc), current task, completed count.',
    {},
    async () => {
      const { SessionStore } = await import('./bot/session-state.js');
      const store = new SessionStore();
      const state = store.load();

      if (!state) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'no active session' }, null, 2) }] };
      }

      return { content: [{ type: 'text', text: JSON.stringify(state, null, 2) }] };
    },
  );

  mcp.tool(
    'fw_weaver_genesis',
    'Run a single Genesis self-evolution cycle on a target workflow. Genesis observes the project, proposes changes within a budget, validates, and commits or rolls back.',
    {
      projectDir: z.string().optional().describe('Project directory (defaults to cwd)'),
      dryRun: z.boolean().optional().describe('Preview without executing'),
    },
    async (args) => {
      const packRoot = new URL('..', import.meta.url);
      let workflowPath: string;
      try {
        const { existsSync } = await import('node:fs');
        workflowPath = fileURLToPath(new URL('src/workflows/genesis-task.ts', packRoot));
        if (!existsSync(workflowPath)) {
          workflowPath = fileURLToPath(new URL('dist/workflows/genesis-task.js', packRoot));
        }
      } catch {
        workflowPath = fileURLToPath(new URL('dist/workflows/genesis-task.js', packRoot));
      }

      const result = await runWorkflow(workflowPath, {
        params: { projectDir: (args.projectDir as string) ?? process.cwd() },
        dryRun: args.dryRun as boolean | undefined,
      });

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
