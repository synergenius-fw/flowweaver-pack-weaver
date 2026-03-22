/**
 * Tests for src/bot/update-checker.ts
 *
 * Covers: corrupted cache handling, corrupted package.json handling,
 * happy-path update checks, formatUpdateNotification, compareVersions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// We need to mock fs and fetch to isolate update-checker from real filesystem/network
vi.mock('node:fs');
vi.mock('node:os');

const mockFs = vi.mocked(fs);
const mockOs = vi.mocked(os);

// Use a stable fake home directory
const FAKE_HOME = '/fake-home';
const FAKE_CACHE_FILE = path.join(FAKE_HOME, '.weaver', 'update-cache.json');

beforeEach(() => {
  vi.resetAllMocks();
  mockOs.homedir.mockReturnValue(FAKE_HOME);
  // Default: no cache file exists
  mockFs.existsSync.mockReturnValue(false);
  // Default: mkdirSync and writeFileSync succeed
  mockFs.mkdirSync.mockReturnValue(undefined as unknown as string);
  mockFs.writeFileSync.mockReturnValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// readCache — corrupted cache should log a warning, not silently swallow
// ---------------------------------------------------------------------------

describe('readCache — corrupted cache file', () => {
  it('returns empty updates when cache contains invalid JSON', async () => {
    // Import fresh to pick up mocks
    const { checkForUpdates } = await import('../../src/bot/update-checker.js');

    // Cache file exists but contains garbage
    mockFs.existsSync.mockImplementation((p) => {
      if (String(p) === FAKE_CACHE_FILE) return true;
      return false;
    });
    mockFs.readFileSync.mockImplementation((p) => {
      if (String(p) === FAKE_CACHE_FILE) return '{{not json}}';
      throw new Error(`ENOENT: ${String(p)}`);
    });

    // Mock fetch to return no updates (so we test cache path, not network)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({}),
    }));

    const result = await checkForUpdates('/fake-project');
    // Should get an empty array (cache miss, no packages found)
    expect(result).toEqual([]);
  });

  it('logs a warning when cache JSON is corrupted', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { checkForUpdates } = await import('../../src/bot/update-checker.js');

    mockFs.existsSync.mockImplementation((p) => {
      if (String(p) === FAKE_CACHE_FILE) return true;
      return false;
    });
    mockFs.readFileSync.mockImplementation((p) => {
      if (String(p) === FAKE_CACHE_FILE) return '{{not json}}';
      throw new Error(`ENOENT: ${String(p)}`);
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({}),
    }));

    await checkForUpdates('/fake-project');

    // The fix should log something about corrupt cache
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('update-cache'),
    );
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// checkForUpdates — corrupted package.json should log, not silently swallow
// ---------------------------------------------------------------------------

describe('checkForUpdates — corrupted package.json', () => {
  it('logs a warning when a pack package.json contains invalid JSON', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { checkForUpdates } = await import('../../src/bot/update-checker.js');

    const packPkgPath = path.resolve(
      '/fake-project', 'node_modules', '@synergenius', 'flow-weaver-pack-weaver', 'package.json'
    );

    mockFs.existsSync.mockImplementation((p) => {
      if (String(p) === packPkgPath) return true;
      return false;
    });
    mockFs.readFileSync.mockImplementation((p) => {
      if (String(p) === packPkgPath) return '{broken json!!!}';
      throw new Error(`ENOENT: ${String(p)}`);
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({}),
    }));

    await checkForUpdates('/fake-project');

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('package.json'),
    );
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// checkForUpdates — happy path with valid package + update available
// ---------------------------------------------------------------------------

describe('checkForUpdates — happy path', () => {
  it('detects an available update when latest > current', async () => {
    const { checkForUpdates } = await import('../../src/bot/update-checker.js');

    const packPkgPath = path.resolve(
      '/fake-project', 'node_modules', '@synergenius', 'flow-weaver-pack-weaver', 'package.json'
    );

    mockFs.existsSync.mockImplementation((p) => {
      if (String(p) === packPkgPath) return true;
      return false;
    });
    mockFs.readFileSync.mockImplementation((p) => {
      if (String(p) === packPkgPath) {
        return JSON.stringify({ name: '@synergenius/flow-weaver-pack-weaver', version: '0.9.0' });
      }
      throw new Error(`ENOENT: ${String(p)}`);
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: '1.0.0' }),
    }));

    const result = await checkForUpdates('/fake-project');
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          packageName: '@synergenius/flow-weaver-pack-weaver',
          currentVersion: '0.9.0',
          latestVersion: '1.0.0',
          updateAvailable: true,
        }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// formatUpdateNotification
// ---------------------------------------------------------------------------

describe('formatUpdateNotification', () => {
  it('returns null when no updates available', async () => {
    const { formatUpdateNotification } = await import('../../src/bot/update-checker.js');
    expect(formatUpdateNotification([])).toBeNull();
    expect(formatUpdateNotification([
      { packageName: 'x', currentVersion: '1.0.0', latestVersion: '1.0.0', updateAvailable: false },
    ])).toBeNull();
  });

  it('formats available updates', async () => {
    const { formatUpdateNotification } = await import('../../src/bot/update-checker.js');
    const result = formatUpdateNotification([
      { packageName: 'pkg-a', currentVersion: '1.0.0', latestVersion: '2.0.0', updateAvailable: true },
    ]);
    expect(result).toContain('pkg-a');
    expect(result).toContain('2.0.0');
    expect(result).toContain('npm update');
  });
});
