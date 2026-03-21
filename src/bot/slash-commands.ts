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
      ctx.out(`\n  ${c.bold('Weaver Assistant')}\n`);
      ctx.out(`  Tell me what to build, fix, or explore. I use tools to do the work.\n\n`);
      ctx.out(`  ${c.bold('Capabilities:')}\n`);
      ctx.out(`    Workflows    Validate, compile, diagram, describe, and modify\n`);
      ctx.out(`    Bots         Spawn background workers that execute tasks autonomously\n`);
      ctx.out(`    Code         Read, write, and patch files in your project\n`);
      ctx.out(`    Shell        Run commands, check TypeScript, run tests\n`);
      ctx.out(`    Knowledge    Store and recall project-specific notes\n`);
      ctx.out(`    Cloud        Sync conversations, check CI status\n\n`);
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
    name: '/history',
    description: 'Show conversation history summary',
    handler: async (ctx) => {
      const result = await ctx.executor('conversation_summary', {});
      ctx.out(`\n  ${result.result}\n\n`);
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
