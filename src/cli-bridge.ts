import type { ParsedArgs } from './cli-handlers.js';
import {
  handleRun, handleHistory, handleCosts, handleWatch,
  handleCron, handlePipeline, handleDashboard, handleProviders,
  handleEject,
} from './cli-handlers.js';

const handlers: Record<string, (opts: ParsedArgs) => Promise<void>> = {
  run: handleRun,
  history: handleHistory,
  costs: handleCosts,
  watch: handleWatch,
  cron: handleCron,
  pipeline: handlePipeline,
  dashboard: handleDashboard,
  providers: handleProviders,
  eject: handleEject,
};

export async function handleCommand(
  name: string,
  args: string[],
): Promise<void> {
  // Build a minimal ParsedArgs from the raw args.
  // The flow-weaver CLI already parsed the subcommand name,
  // we just get the remaining args.
  const handler = handlers[name];
  if (!handler) {
    throw new Error(`Unknown weaver command: ${name}`);
  }

  // Import parseArgs to handle the remaining flags
  const { parseArgs } = await import('./cli-handlers.js');
  // Prepend dummy entries so parseArgs skips argv[0] and argv[1]
  const opts = parseArgs(['node', 'weaver', name, ...args]);
  await handler(opts);
}
