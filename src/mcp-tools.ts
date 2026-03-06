import { z } from 'zod';
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
}
