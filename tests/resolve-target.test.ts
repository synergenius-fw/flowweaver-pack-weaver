import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WeaverEnv, WeaverContext } from '../src/bot/types.js';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

import * as fs from 'node:fs';
import { weaverResolveTarget } from '../src/node-types/resolve-target.js';

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReaddirSync = vi.mocked(fs.readdirSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);

function makeEnv(overrides: Partial<WeaverEnv['config']> = {}): WeaverEnv {
  return {
    projectDir: '/proj',
    config: { provider: 'auto' as const, ...overrides },
    providerType: 'anthropic' as const,
    providerInfo: { type: 'anthropic' as const, apiKey: 'key' },
  };
}

function makeDirent(name: string, isDir: boolean): fs.Dirent {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
    path: '/proj',
    parentPath: '/proj',
  } as fs.Dirent;
}

describe('weaverResolveTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  describe('explicit config.target', () => {
    it('returns ctx with targetPath set to resolved absolute path', () => {
      mockExistsSync.mockReturnValue(true);

      const result = weaverResolveTarget(makeEnv({ target: 'src/my-workflow.ts' }));
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(ctx.targetPath).toContain('my-workflow.ts');
    });

    it('throws when target file does not exist', () => {
      mockExistsSync.mockReturnValue(false);

      expect(() => weaverResolveTarget(makeEnv({ target: 'missing.ts' }))).toThrow('not found');
    });

    it('logs the resolved target path', () => {
      mockExistsSync.mockReturnValue(true);

      weaverResolveTarget(makeEnv({ target: 'workflow.ts' }));
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('workflow.ts'),
      );
    });

    it('preserves env in output ctx', () => {
      mockExistsSync.mockReturnValue(true);

      const env = makeEnv({ target: 'wf.ts' });
      const result = weaverResolveTarget(env);
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(ctx.env.projectDir).toBe('/proj');
    });
  });

  describe('auto-scan (no config.target)', () => {
    it('finds a workflow file and sets targetPath', () => {
      mockReaddirSync.mockReturnValue([makeDirent('workflow.ts', false)] as any);
      mockReadFileSync.mockReturnValue('/** @flowWeaver workflow */ export function myFlow() {}' as any);

      const result = weaverResolveTarget(makeEnv());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(ctx.targetPath).toContain('workflow.ts');
    });

    it('throws when no workflow files are found', () => {
      mockReaddirSync.mockReturnValue([] as any);

      expect(() => weaverResolveTarget(makeEnv())).toThrow('No workflow files found');
    });

    it('throws when multiple workflow files are found', () => {
      mockReaddirSync.mockReturnValue([
        makeDirent('wf-a.ts', false),
        makeDirent('wf-b.ts', false),
      ] as any);
      mockReadFileSync.mockReturnValue('/** @flowWeaver workflow */' as any);

      expect(() => weaverResolveTarget(makeEnv())).toThrow('Multiple workflows found');
    });

    it('error for multiple workflows lists file names', () => {
      mockReaddirSync.mockReturnValue([
        makeDirent('wf-a.ts', false),
        makeDirent('wf-b.ts', false),
      ] as any);
      mockReadFileSync.mockReturnValue('/** @flowWeaver workflow */' as any);

      let message = '';
      try { weaverResolveTarget(makeEnv()); } catch (e: any) { message = e.message; }
      expect(message).toContain('wf-a.ts');
      expect(message).toContain('wf-b.ts');
    });

    it('skips node_modules directories during scan', () => {
      mockReaddirSync
        .mockReturnValueOnce([
          makeDirent('node_modules', true),
          makeDirent('src', true),
        ] as any)
        .mockReturnValueOnce([makeDirent('workflow.ts', false)] as any);
      mockReadFileSync.mockReturnValue('/** @flowWeaver workflow */' as any);

      // Should not scan inside node_modules — only 2 readdirSync calls (root + src)
      const result = weaverResolveTarget(makeEnv());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(ctx.targetPath).toBeDefined();

      const calls = mockReaddirSync.mock.calls;
      const scannedPaths = calls.map(c => c[0] as string);
      expect(scannedPaths.every(p => !p.includes('node_modules'))).toBe(true);
    });

    it('skips dotfiles/dotfolders during scan', () => {
      mockReaddirSync
        .mockReturnValueOnce([
          makeDirent('.git', true),
          makeDirent('workflow.ts', false),
        ] as any);
      mockReadFileSync.mockReturnValue('/** @flowWeaver workflow */' as any);

      const result = weaverResolveTarget(makeEnv());
      const ctx = JSON.parse(result.ctx) as WeaverContext;
      expect(ctx.targetPath).toBeDefined();
    });

    it('skips .d.ts declaration files', () => {
      mockReaddirSync.mockReturnValue([
        makeDirent('workflow.d.ts', false),
      ] as any);

      expect(() => weaverResolveTarget(makeEnv())).toThrow('No workflow files found');
    });

    it('skips ts files whose content lacks @flowWeaver workflow', () => {
      mockReaddirSync.mockReturnValue([makeDirent('helper.ts', false)] as any);
      mockReadFileSync.mockReturnValue('export function helper() {}' as any);

      expect(() => weaverResolveTarget(makeEnv())).toThrow('No workflow files found');
    });

    it('logs the discovered target path', () => {
      mockReaddirSync.mockReturnValue([makeDirent('my-flow.ts', false)] as any);
      mockReadFileSync.mockReturnValue('/** @flowWeaver workflow */' as any);

      weaverResolveTarget(makeEnv());
      expect(vi.mocked(console.log)).toHaveBeenCalledWith(
        expect.stringContaining('my-flow.ts'),
      );
    });
  });
});
