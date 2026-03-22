import type { ToolExecutor } from '@synergenius/flow-weaver/agent';
import { c } from './ansi.js';

export interface SlashContext {
  executor: ToolExecutor;
  out: (s: string) => void;
  projectDir: string;
  conversationId?: string;
  onClear?: () => void;
  onExit?: () => void;
  onNew?: () => void;
  onVerbose?: () => void;
}

export interface SlashCommand {
  name: string;
  description: string;
  handler: (ctx: SlashContext, args: string) => Promise<void>;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: '/help',
    description: 'Show available commands and capabilities',
    handler: async (ctx) => {
      // Check if this is a new project (no workflows)
      let hasWorkflows = false;
      try {
        const fsMod = await import('node:fs');
        const pathMod = await import('node:path');
        const srcDir = pathMod.join(ctx.projectDir, 'src');
        if (fsMod.existsSync(srcDir)) {
          const files = fsMod.readdirSync(srcDir, { recursive: true }) as string[];
          hasWorkflows = files.some(f => f.endsWith('.ts'));
        }
      } catch { /* scan failed */ }

      ctx.out(`\n  ${c.bold('Weaver Assistant')}\n`);
      ctx.out(`  Tell me what to build, fix, or explore. I use tools to do the work.\n\n`);

      if (!hasWorkflows) {
        ctx.out(`  ${c.bold('Getting Started:')}\n`);
        ctx.out(`    ${c.cyan('1.')} "create a hello world workflow"\n`);
        ctx.out(`    ${c.cyan('2.')} "create a data pipeline that reads an API and transforms the result"\n`);
        ctx.out(`    ${c.cyan('3.')} "what is Flow Weaver and how does it work?"\n\n`);
      }

      ctx.out(`  ${c.bold('Capabilities:')}\n`);
      ctx.out(`    Workflows    Create, validate, compile, diagram, describe, and modify\n`);
      ctx.out(`    Bots         Spawn background workers that execute tasks autonomously\n`);
      ctx.out(`    Code         Read, write, and patch files in your project\n`);
      ctx.out(`    Health       Track project health, insights, cost, and trust level\n`);
      ctx.out(`    Evolution    Propose and apply genesis improvements to bot workflows\n`);
      ctx.out(`    Shell        Run commands, check TypeScript, run tests\n\n`);
      ctx.out(`  ${c.bold('Commands:')}\n`);
      for (const cmd of SLASH_COMMANDS) {
        if (cmd.name === '/help') continue;
        ctx.out(`    ${c.cyan(cmd.name.padEnd(12))} ${c.dim(cmd.description)}\n`);
      }
      ctx.out('\n');
    },
  },
  {
    name: '/status',
    description: 'Show bots, queue, and conversation summary',
    handler: async (ctx) => {
      const bots = await ctx.executor('bot_list', {});
      const summary = await ctx.executor('conversation_summary', {});
      ctx.out(`\n  Bots:\n  ${bots.result}\n\n  Conversation:\n  ${summary.result}\n\n`);
    },
  },
  {
    name: '/bots',
    description: 'List running bots',
    handler: async (ctx) => {
      const result = await ctx.executor('bot_list', {});
      ctx.out(`\n  ${result.result}\n\n`);
    },
  },
  {
    name: '/clear',
    description: 'Clear screen and start new conversation',
    handler: async (ctx) => {
      process.stderr.write('\x1b[2J\x1b[H');
      ctx.onClear?.();
      ctx.out(`  ${c.dim('Screen cleared. New conversation started.')}\n\n`);
    },
  },
  {
    name: '/exit',
    description: 'Exit the assistant',
    handler: async (ctx) => {
      ctx.onExit?.();
    },
  },
  {
    name: '/new',
    description: 'Start a new conversation',
    handler: async (ctx) => {
      ctx.onNew?.();
      ctx.out(`\n  ${c.dim('New conversation started.')}\n\n`);
    },
  },
  {
    name: '/list',
    description: 'List saved conversations',
    handler: async (ctx) => {
      const result = await ctx.executor('conversation_list', {});
      ctx.out(`\n  ${result.result}\n\n`);
    },
  },
  {
    name: '/verbose',
    description: 'Toggle verbose mode (show AI thinking)',
    handler: async (ctx) => {
      ctx.onVerbose?.();
    },
  },
  {
    name: '/insights',
    description: 'Show project insights and recommendations',
    handler: async (ctx: SlashContext) => {
      const result = await ctx.executor('project_insights', {});
      ctx.out(`\n${result.result}\n\n`);
    },
  },
  {
    name: '/health',
    description: 'Show project health summary',
    handler: async (ctx: SlashContext) => {
      const result = await ctx.executor('project_health', {});
      ctx.out(`\n${result.result}\n\n`);
    },
  },
  {
    name: '/history',
    description: 'Show conversation history summary',
    handler: async (ctx) => {
      const result = await ctx.executor('conversation_summary', {});
      ctx.out(`\n  ${result.result}\n\n`);
    },
  },
  {
    name: '/improve',
    description: 'Show status of the current or last improve run',
    handler: async (ctx) => {
      try {
        const fsMod = await import('node:fs');
        const pathMod = await import('node:path');
        const osMod = await import('node:os');
        const summaryDir = pathMod.join(osMod.homedir(), '.weaver', 'improve');
        if (!fsMod.existsSync(summaryDir)) {
          ctx.out(`\n  No improve runs found. Start one with: weaver improve\n\n`);
          return;
        }
        const files = fsMod.readdirSync(summaryDir).filter((f: string) => f.endsWith('.json')).sort().reverse();
        if (files.length === 0) {
          ctx.out(`\n  No improve runs found.\n\n`);
          return;
        }
        const latest = JSON.parse(fsMod.readFileSync(pathMod.join(summaryDir, files[0]!), 'utf-8'));
        const duration = Math.round((new Date(latest.finishedAt).getTime() - new Date(latest.startedAt).getTime()) / 1000);

        ctx.out(`\n  Improve Run (${latest.reason})\n`);
        ctx.out(`  Branch: ${latest.branch}\n`);
        ctx.out(`  Duration: ${duration}s\n`);
        ctx.out(`  Successes: ${latest.successes}  Failures: ${latest.failures}  Skips: ${latest.skips}  Blocked: ${latest.blocked}\n\n`);
        for (const cy of latest.cycles) {
          const icon = cy.outcome === 'success' ? '✓' : cy.outcome === 'failure' ? '✗' : '○';
          ctx.out(`  ${icon} Cycle ${cy.cycle}: [${cy.outcome}] ${cy.description.slice(0, 70)}\n`);
        }

        // Check if a run is currently active
        try {
          const { execFileSync } = await import('node:child_process');
          const worktrees = execFileSync('git', ['worktree', 'list'], { encoding: 'utf-8', cwd: ctx.projectDir });
          if (worktrees.includes('weaver-improve')) {
            ctx.out(`\n  LIVE: improve worktree active — run is in progress\n`);
          }
        } catch { /* git not available */ }

        ctx.out('\n');
      } catch (err) {
        ctx.out(`\n  Error reading improve status: ${err instanceof Error ? err.message : err}\n\n`);
      }
    },
  },
  {
    name: '/genesis',
    description: 'Propose a workflow evolution based on project insights',
    handler: async (ctx: SlashContext) => {
      const result = await ctx.executor('genesis_propose', {});
      ctx.out(`\n${result.result}\n\n`);
    },
  },
  {
    name: '/trust',
    description: 'Show current trust level and factors',
    handler: async (ctx: SlashContext) => {
      const result = await ctx.executor('project_health', {});
      ctx.out(`\n${result.result}\n\n`);
    },
  },
];

export function getSlashCompletions(partial: string): string[] {
  if (!partial.startsWith('/')) return [];
  return SLASH_COMMANDS
    .filter(cmd => cmd.name.startsWith(partial))
    .map(cmd => cmd.name);
}

export async function handleSlashCommand(
  input: string,
  ctx: SlashContext,
): Promise<boolean> {
  const [name, ...rest] = input.split(' ');
  const cmd = SLASH_COMMANDS.find(c => c.name === name);
  if (!cmd) return false;
  await cmd.handler(ctx, rest.join(' '));
  return true;
}
