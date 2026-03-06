import { handleCommand } from '../src/cli-bridge.js';

describe('cli-bridge handleCommand', () => {
  it('throws on unknown command', async () => {
    await expect(handleCommand('nonexistent', [])).rejects.toThrow(
      'Unknown weaver command: nonexistent',
    );
  });

  it('does not throw "Unknown" for any registered command', async () => {
    // These commands are safe to invoke: they either print output and return,
    // or fail with a missing-args error (not "Unknown weaver command").
    // We skip commands that start servers or call process.exit.
    const safeCommands = ['history', 'costs', 'providers'];

    for (const cmd of safeCommands) {
      try {
        await handleCommand(cmd, []);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).not.toContain('Unknown weaver command');
      }
    }
  });

  it('rejects commands not in the handler map', async () => {
    const bogus = ['foo', 'bar', 'deploy', 'init'];
    for (const cmd of bogus) {
      await expect(handleCommand(cmd, [])).rejects.toThrow('Unknown weaver command');
    }
  });
});
