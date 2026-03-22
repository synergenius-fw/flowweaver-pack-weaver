import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

// ---------------------------------------------------------------------------
// We import the module under test. Because it uses module-level state
// (a Set and a boolean), we isolate via vi.resetModules() + dynamic import.
// ---------------------------------------------------------------------------

// Helper: create a minimal mock ChildProcess (EventEmitter with .kill())
function mockChild(opts?: { killThrows?: boolean }): ChildProcess {
  const emitter = new EventEmitter() as unknown as ChildProcess;
  emitter.kill = vi.fn(() => {
    if (opts?.killThrows) throw new Error('Process already dead');
    return true;
  });
  return emitter;
}

// Fresh import each test to reset module-level state
async function freshImport() {
  return import('../src/bot/child-process-tracker.js');
}

// ---------------------------------------------------------------------------
// trackChild — basic tracking
// ---------------------------------------------------------------------------

describe('child-process-tracker', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe('trackChild', () => {
    it('increments activeChildCount when a child is tracked', async () => {
      const { trackChild, activeChildCount } = await freshImport();
      const child = mockChild();
      expect(activeChildCount()).toBe(0);
      trackChild(child);
      expect(activeChildCount()).toBe(1);
    });

    it('tracks multiple children', async () => {
      const { trackChild, activeChildCount } = await freshImport();
      trackChild(mockChild());
      trackChild(mockChild());
      trackChild(mockChild());
      expect(activeChildCount()).toBe(3);
    });

    it('does not duplicate when same child is tracked twice', async () => {
      const { trackChild, activeChildCount } = await freshImport();
      const child = mockChild();
      trackChild(child);
      trackChild(child);
      // Set semantics: same reference only stored once
      expect(activeChildCount()).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Auto-removal on "exit" and "error" events
  // ---------------------------------------------------------------------------

  describe('auto-removal on child events', () => {
    it('removes child from set when "exit" event fires', async () => {
      const { trackChild, activeChildCount } = await freshImport();
      const child = mockChild();
      trackChild(child);
      expect(activeChildCount()).toBe(1);

      (child as unknown as EventEmitter).emit('exit', 0, null);
      expect(activeChildCount()).toBe(0);
    });

    it('removes child from set when "error" event fires', async () => {
      const { trackChild, activeChildCount } = await freshImport();
      const child = mockChild();
      trackChild(child);
      expect(activeChildCount()).toBe(1);

      (child as unknown as EventEmitter).emit('error', new Error('spawn fail'));
      expect(activeChildCount()).toBe(0);
    });

    it('only removes the child that exited, not others', async () => {
      const { trackChild, activeChildCount } = await freshImport();
      const child1 = mockChild();
      const child2 = mockChild();
      trackChild(child1);
      trackChild(child2);
      expect(activeChildCount()).toBe(2);

      (child1 as unknown as EventEmitter).emit('exit', 0, null);
      expect(activeChildCount()).toBe(1);
    });

    it('handles exit after error without crashing', async () => {
      const { trackChild, activeChildCount } = await freshImport();
      const child = mockChild();
      trackChild(child);

      (child as unknown as EventEmitter).emit('error', new Error('oops'));
      expect(activeChildCount()).toBe(0);
      // exit after error — delete on already-removed is a no-op
      (child as unknown as EventEmitter).emit('exit', 1, null);
      expect(activeChildCount()).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // activeChildCount
  // ---------------------------------------------------------------------------

  describe('activeChildCount', () => {
    it('returns 0 when no children tracked', async () => {
      const { activeChildCount } = await freshImport();
      expect(activeChildCount()).toBe(0);
    });

    it('reflects removals correctly', async () => {
      const { trackChild, activeChildCount } = await freshImport();
      const c1 = mockChild();
      const c2 = mockChild();
      trackChild(c1);
      trackChild(c2);
      expect(activeChildCount()).toBe(2);

      (c1 as unknown as EventEmitter).emit('exit', 0, null);
      expect(activeChildCount()).toBe(1);

      (c2 as unknown as EventEmitter).emit('exit', 0, null);
      expect(activeChildCount()).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Signal handler installation (idempotent)
  // ---------------------------------------------------------------------------

  describe('signal handler installation', () => {
    it('installs process signal handlers on first trackChild call', async () => {
      const onSpy = vi.spyOn(process, 'on');
      const { trackChild } = await freshImport();

      trackChild(mockChild());

      const registeredEvents = onSpy.mock.calls.map(c => c[0]);
      expect(registeredEvents).toContain('SIGINT');
      expect(registeredEvents).toContain('SIGTERM');
      expect(registeredEvents).toContain('exit');

      onSpy.mockRestore();
    });

    it('does not install handlers again on second trackChild call', async () => {
      const onSpy = vi.spyOn(process, 'on');
      const { trackChild } = await freshImport();

      trackChild(mockChild());
      const countAfterFirst = onSpy.mock.calls.filter(
        c => c[0] === 'SIGINT'
      ).length;

      trackChild(mockChild());
      const countAfterSecond = onSpy.mock.calls.filter(
        c => c[0] === 'SIGINT'
      ).length;

      expect(countAfterSecond).toBe(countAfterFirst);

      onSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // Cleanup handler behavior (simulated via process 'exit' event)
  // ---------------------------------------------------------------------------

  describe('cleanup on process exit', () => {
    it('calls kill(SIGTERM) on all tracked children during cleanup', async () => {
      // We capture the cleanup handler registered on process 'exit'
      let exitHandler: (() => void) | undefined;
      const onSpy = vi.spyOn(process, 'on').mockImplementation(
        ((event: string, handler: () => void) => {
          if (event === 'exit') exitHandler = handler;
          return process;
        }) as typeof process.on
      );

      const { trackChild } = await freshImport();
      const c1 = mockChild();
      const c2 = mockChild();
      trackChild(c1);
      trackChild(c2);

      expect(exitHandler).toBeDefined();
      exitHandler!();

      expect(c1.kill).toHaveBeenCalledWith('SIGTERM');
      expect(c2.kill).toHaveBeenCalledWith('SIGTERM');

      onSpy.mockRestore();
    });

    it('survives kill() throwing on already-dead process', async () => {
      let exitHandler: (() => void) | undefined;
      const onSpy = vi.spyOn(process, 'on').mockImplementation(
        ((event: string, handler: () => void) => {
          if (event === 'exit') exitHandler = handler;
          return process;
        }) as typeof process.on
      );

      const { trackChild } = await freshImport();
      const deadChild = mockChild({ killThrows: true });
      const liveChild = mockChild();
      trackChild(deadChild);
      trackChild(liveChild);

      // Should not throw
      expect(() => exitHandler!()).not.toThrow();

      // Live child still got killed
      expect(liveChild.kill).toHaveBeenCalledWith('SIGTERM');

      onSpy.mockRestore();
    });

    it('clears the tracked set after cleanup', async () => {
      let exitHandler: (() => void) | undefined;
      const onSpy = vi.spyOn(process, 'on').mockImplementation(
        ((event: string, handler: () => void) => {
          if (event === 'exit') exitHandler = handler;
          return process;
        }) as typeof process.on
      );

      const { trackChild, activeChildCount } = await freshImport();
      trackChild(mockChild());
      trackChild(mockChild());
      expect(activeChildCount()).toBe(2);

      exitHandler!();
      expect(activeChildCount()).toBe(0);

      onSpy.mockRestore();
    });
  });
});
