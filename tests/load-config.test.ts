import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';

// ── Mock node:fs before importing the module under test ───────────────────────

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import * as fs from 'node:fs';
import { weaverLoadConfig } from '../src/node-types/load-config.js';

const mockedExistsSync = vi.mocked(fs.existsSync);
const mockedReadFileSync = vi.mocked(fs.readFileSync);

// ── helpers ───────────────────────────────────────────────────────────────────

/** Make readFileSync return the given string (covers the utf-8 overload). */
function mockConfigFile(json: string): void {
  mockedReadFileSync.mockReturnValue(json as unknown as Buffer);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('weaverLoadConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Default: no config file present
    mockedExistsSync.mockReturnValue(false);
  });

  it('returns provider:auto when no .weaver.json exists', () => {
    const result = weaverLoadConfig('/my/project');
    expect(result.config.provider).toBe('auto');
  });

  it('returns the supplied projectDir when no .weaver.json exists', () => {
    const result = weaverLoadConfig('/my/project');
    expect(result.projectDir).toBe('/my/project');
  });

  it('defaults projectDir to cwd when not provided', () => {
    const result = weaverLoadConfig();
    expect(result.projectDir).toBe(process.cwd());
  });

  it('uses cwd in the existsSync call when no projectDir is given', () => {
    weaverLoadConfig();
    expect(mockedExistsSync).toHaveBeenCalledWith(
      path.join(process.cwd(), '.weaver.json'),
    );
  });

  it('probes the correct path when projectDir is supplied', () => {
    weaverLoadConfig('/some/dir');
    expect(mockedExistsSync).toHaveBeenCalledWith(
      path.join('/some/dir', '.weaver.json'),
    );
  });

  it('loads and merges provider from .weaver.json', () => {
    mockedExistsSync.mockReturnValue(true);
    mockConfigFile(JSON.stringify({ provider: 'anthropic' }));
    const result = weaverLoadConfig('/proj');
    expect(result.config.provider).toBe('anthropic');
  });

  it('loads target from .weaver.json alongside provider default', () => {
    mockedExistsSync.mockReturnValue(true);
    mockConfigFile(JSON.stringify({ target: 'wf.ts' }));
    const result = weaverLoadConfig('/proj');
    expect(result.config.provider).toBe('auto'); // default preserved
    expect(result.config.target).toBe('wf.ts');
  });

  it('merges multiple fields from .weaver.json with defaults', () => {
    mockedExistsSync.mockReturnValue(true);
    mockConfigFile(JSON.stringify({ provider: 'anthropic', target: 'my-wf.ts' }));
    const result = weaverLoadConfig('/proj');
    expect(result.config.provider).toBe('anthropic');
    expect(result.config.target).toBe('my-wf.ts');
    expect(result.projectDir).toBe('/proj');
  });

  it('throws when .weaver.json contains malformed JSON', () => {
    mockedExistsSync.mockReturnValue(true);
    mockConfigFile('not { valid json >>>');
    expect(() => weaverLoadConfig('/proj')).toThrow();
  });

  it('does not call readFileSync when no config file exists', () => {
    weaverLoadConfig('/proj');
    expect(mockedReadFileSync).not.toHaveBeenCalled();
  });
});
