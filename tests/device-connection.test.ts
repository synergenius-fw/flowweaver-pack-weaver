import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { registerWeaverHandlers } from '../src/bot/device-connection.js';

// Minimal mock that captures registered handlers and capabilities
function createMockConnection() {
  const capabilities: string[] = [];
  const handlers = new Map<string, (method: string, params: Record<string, unknown>) => Promise<unknown>>();

  return {
    conn: {
      addCapability(cap: string) { capabilities.push(cap); },
      onRequest(method: string, handler: (method: string, params: Record<string, unknown>) => Promise<unknown>) {
        handlers.set(method, handler);
      },
    } as unknown as import('@synergenius/flow-weaver/agent').DeviceConnection,
    capabilities,
    handlers,
    invoke(method: string, params: Record<string, unknown> = {}) {
      const handler = handlers.get(method);
      if (!handler) throw new Error(`No handler for ${method}`);
      return handler(method, params);
    },
  };
}

describe('device-connection: registerWeaverHandlers', () => {
  let tmpDir: string;
  let mock: ReturnType<typeof createMockConnection>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-conn-test-'));
    mock = createMockConnection();
    registerWeaverHandlers(mock.conn, tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('capabilities', () => {
    it('registers all expected capabilities', () => {
      expect(mock.capabilities).toContain('file_read');
      expect(mock.capabilities).toContain('file_list');
      expect(mock.capabilities).toContain('health');
      expect(mock.capabilities).toContain('insights');
      expect(mock.capabilities).toContain('improve');
      expect(mock.capabilities).toContain('assistant');
      expect(mock.capabilities).toHaveLength(6);
    });
  });

  describe('file:read', () => {
    it('reads a file and returns its content', async () => {
      fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'world');
      const result = await mock.invoke('file:read', { path: 'hello.txt' });
      expect(result).toEqual({ type: 'file', content: 'world' });
    });

    it('reads a directory and returns entries', async () => {
      fs.mkdirSync(path.join(tmpDir, 'subdir'));
      fs.writeFileSync(path.join(tmpDir, 'subdir', 'a.txt'), '');
      fs.writeFileSync(path.join(tmpDir, 'subdir', 'b.txt'), '');
      const result = await mock.invoke('file:read', { path: 'subdir' }) as { type: string; entries: string[] };
      expect(result.type).toBe('directory');
      expect(result.entries.sort()).toEqual(['a.txt', 'b.txt']);
    });

    it('rejects path traversal outside project directory', async () => {
      await expect(mock.invoke('file:read', { path: '../../../etc/passwd' }))
        .rejects.toThrow('Path outside project directory');
    });

    it('rejects non-existent files', async () => {
      await expect(mock.invoke('file:read', { path: 'does-not-exist.txt' }))
        .rejects.toThrow('File not found');
    });

    it('rejects files larger than 1MB', async () => {
      const largePath = path.join(tmpDir, 'large.bin');
      // Create a file just over 1MB
      fs.writeFileSync(largePath, Buffer.alloc(1_048_577));
      await expect(mock.invoke('file:read', { path: 'large.bin' }))
        .rejects.toThrow('File too large (>1MB)');
    });

    it('handles missing path param by resolving to project root', async () => {
      // path defaults to '' via nullish coalescing, resolving to projectDir itself
      fs.writeFileSync(path.join(tmpDir, 'root-file.txt'), '');
      const result = await mock.invoke('file:read', {}) as { type: string; entries: string[] };
      expect(result.type).toBe('directory');
      expect(result.entries).toContain('root-file.txt');
    });
  });

  describe('file:list', () => {
    it('lists directory contents with type info', async () => {
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), '');
      fs.mkdirSync(path.join(tmpDir, 'subdir'));
      const result = await mock.invoke('file:list', { path: '.' }) as Array<{ name: string; type: string; path: string }>;
      const names = result.map((e: { name: string }) => e.name).sort();
      expect(names).toContain('file.txt');
      expect(names).toContain('subdir');
      const fileEntry = result.find((e: { name: string }) => e.name === 'file.txt');
      expect(fileEntry).toMatchObject({ type: 'file' });
      const dirEntry = result.find((e: { name: string }) => e.name === 'subdir');
      expect(dirEntry).toMatchObject({ type: 'directory' });
    });

    it('filters out dotfiles, node_modules, and dist', async () => {
      fs.writeFileSync(path.join(tmpDir, '.hidden'), '');
      fs.mkdirSync(path.join(tmpDir, 'node_modules'));
      fs.mkdirSync(path.join(tmpDir, 'dist'));
      fs.writeFileSync(path.join(tmpDir, 'visible.txt'), '');
      const result = await mock.invoke('file:list', { path: '.' }) as Array<{ name: string }>;
      const names = result.map((e: { name: string }) => e.name);
      expect(names).toEqual(['visible.txt']);
    });

    it('rejects path traversal outside project directory', async () => {
      await expect(mock.invoke('file:list', { path: '../../../' }))
        .rejects.toThrow('Path outside project directory');
    });

    it('rejects non-existent directory', async () => {
      await expect(mock.invoke('file:list', { path: 'no-such-dir' }))
        .rejects.toThrow('Directory not found');
    });

    it('returns relative paths from project root', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src'));
      fs.writeFileSync(path.join(tmpDir, 'src', 'main.ts'), '');
      const result = await mock.invoke('file:list', { path: 'src' }) as Array<{ path: string }>;
      expect(result[0]!.path).toBe(path.join('src', 'main.ts'));
    });
  });
});
