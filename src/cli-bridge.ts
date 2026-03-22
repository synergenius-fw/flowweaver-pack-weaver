import type { ParsedArgs } from './cli-handlers.js';
import {
  handleRun, handleHistory, handleCosts, handleWatch,
  handleCron, handlePipeline, handleDashboard, handleProviders,
  handleEject, handleBot, handleSession, handleSteer, handleQueue,
  handleStatus, handleGenesis, handleAudit, handleInit, handleAssistant,
  handleExamples, handleDoctor, handleImprove, handleConnect,
  printHelp,
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
  bot: handleBot,
  session: handleSession,
  steer: handleSteer,
  queue: handleQueue,
  status: handleStatus,
  genesis: handleGenesis,
  audit: handleAudit,
  init: handleInit,
  assistant: handleAssistant,
  examples: handleExamples,
  doctor: handleDoctor,
  improve: handleImprove,
  connect: handleConnect,
};

export { printHelp };

export async function handleCommand(
  name: string,
  args: string[],
): Promise<void> {
  const handler = handlers[name];
  if (!handler) {
    throw new Error(`Unknown weaver command: ${name}`);
  }

  const { parseArgs } = await import('./cli-handlers.js');
  const opts = parseArgs(['node', 'weaver', name, ...args]);

  if (opts.showHelp) {
    printHelp(name);
    return;
  }

  await handler(opts);
}
