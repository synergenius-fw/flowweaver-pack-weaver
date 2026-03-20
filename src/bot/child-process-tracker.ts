import type { ChildProcess } from 'node:child_process';

/**
 * Tracks spawned child processes and kills them on SIGINT/SIGTERM.
 * Prevents zombie `claude` processes when user hits Ctrl+C.
 */

const activeChildren = new Set<ChildProcess>();
let signalHandlersInstalled = false;

function installSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;

  const cleanup = () => {
    for (const child of activeChildren) {
      try {
        child.kill('SIGTERM');
      } catch { /* already dead */ }
    }
    activeChildren.clear();
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', cleanup);
}

/** Register a child process for cleanup on signal. */
export function trackChild(child: ChildProcess): void {
  installSignalHandlers();
  activeChildren.add(child);
  child.on('exit', () => activeChildren.delete(child));
  child.on('error', () => activeChildren.delete(child));
}

/** Get the count of active tracked children. */
export function activeChildCount(): number {
  return activeChildren.size;
}
