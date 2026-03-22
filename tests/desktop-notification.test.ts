import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as child_process from 'node:child_process';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

describe('sendDesktopNotification', () => {
  const mockExecFileSync = vi.mocked(child_process.execFileSync);

  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  // Helper: import fresh to pick up platform stubs
  async function importFresh() {
    vi.resetModules();
    const mod = await import('../src/bot/bot-manager.js');
    return mod.sendDesktopNotification;
  }

  describe('special character escaping (reliability)', () => {
    it('does not embed raw double-quotes in osascript command on macOS', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

      try {
        const sendDesktopNotification = await importFresh();
        sendDesktopNotification('Bot "alpha"', 'Task completed: "fix bug"');

        expect(mockExecFileSync).toHaveBeenCalledTimes(1);
        const [cmd, args] = mockExecFileSync.mock.calls[0];
        expect(cmd).toBe('osascript');

        // The AppleScript string must not contain unescaped double-quotes
        // from the user input — they must be escaped as \" for AppleScript
        const script = args![1] as string;
        // Extract the parts between the outer quotes of the AppleScript string literals
        // The raw " from user input must NOT appear unescaped inside the AppleScript string
        expect(script).not.toMatch(/display notification ".*[^\\]".*" with title ".*[^\\]".*"/);
        // But the escaped content should be present
        expect(script).toContain('fix bug');
        expect(script).toContain('alpha');
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });

    it('does not embed raw single-quotes in PowerShell command on Windows', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      try {
        const sendDesktopNotification = await importFresh();
        sendDesktopNotification("Bot's status", "It's done");

        expect(mockExecFileSync).toHaveBeenCalledTimes(1);
        const [cmd, args] = mockExecFileSync.mock.calls[0];
        expect(cmd).toBe('powershell');

        // The PowerShell command string must have single-quotes doubled for escaping
        const psCommand = args![1] as string;
        // "Bot's status" should become "Bot''s status" in the PS string
        expect(psCommand).toContain("Bot''s status");
        expect(psCommand).toContain("It''s done");
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });

    it('handles backslashes in notification text on macOS', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

      try {
        const sendDesktopNotification = await importFresh();
        sendDesktopNotification('Test\\Path', 'C:\\Users\\bot');

        expect(mockExecFileSync).toHaveBeenCalledTimes(1);
        const [, args] = mockExecFileSync.mock.calls[0];
        const script = args![1] as string;
        // Backslashes must be escaped for AppleScript
        expect(script).toContain('\\\\');
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });

    it('is non-fatal when execFileSync throws', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

      try {
        mockExecFileSync.mockImplementation(() => { throw new Error('osascript not found'); });
        const sendDesktopNotification = await importFresh();
        // Should not throw
        expect(() => sendDesktopNotification('Title', 'Message')).not.toThrow();
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });
  });
});
