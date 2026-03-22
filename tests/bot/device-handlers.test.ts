import { describe, test, expect } from 'vitest';

describe('device-handlers hook', () => {
  test('register() adds capabilities and request handlers', async () => {
    const { register } = await import('../../src/bot/device-handlers.js');
    const capabilities: string[] = [];
    const handlers = new Map<string, Function>();
    const mockConn = {
      addCapability: (cap: string) => capabilities.push(cap),
      onRequest: (method: string, handler: Function) => handlers.set(method, handler),
    };
    await register(mockConn as any, { projectDir: process.cwd() });
    expect(capabilities).toContain('health');
    expect(capabilities).toContain('insights');
    expect(capabilities).toContain('improve');
    expect(handlers.has('health')).toBe(true);
    expect(handlers.has('insights')).toBe(true);
    expect(handlers.has('improve:status')).toBe(true);
  });
});
