import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock os.homedir() so KnowledgeStore writes to a temp directory
let tmpDir: string;

// Track fs.writeFileSync and fs.renameSync calls for atomicity tests
let fsWritePaths: string[] = [];
let fsRenamePairs: Array<[string, string]> = [];

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => tmpDir,
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    writeFileSync: (...args: any[]) => {
      fsWritePaths.push(String(args[0]));
      return (actual.writeFileSync as any)(...args);
    },
    renameSync: (...args: any[]) => {
      fsRenamePairs.push([String(args[0]), String(args[1])]);
      return (actual.renameSync as any)(...args);
    },
  };
});

import { KnowledgeStore, type KnowledgeEntry } from '../src/bot/knowledge-store.js';

describe('KnowledgeStore', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-'));
    fsWritePaths = [];
    fsRenamePairs = [];
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Constructor / path resolution
  // -----------------------------------------------------------------------

  describe('constructor', () => {
    it('uses .weaver/knowledge.ndjson when no projectDir given', () => {
      const store = new KnowledgeStore();
      // learn something so the file is created
      store.learn('k', 'v', 'test');
      const expectedDir = path.join(tmpDir, '.weaver');
      expect(fs.existsSync(path.join(expectedDir, 'knowledge.ndjson'))).toBe(true);
    });

    it('uses hashed project subdir when projectDir given', () => {
      const store = new KnowledgeStore('/some/project');
      store.learn('k', 'v', 'test');
      // Should be under .weaver/projects/<hash>/knowledge.ndjson
      const projectsDir = path.join(tmpDir, '.weaver', 'projects');
      expect(fs.existsSync(projectsDir)).toBe(true);
      const subdirs = fs.readdirSync(projectsDir);
      expect(subdirs).toHaveLength(1);
      expect(subdirs[0]).toHaveLength(8); // 8-char hex hash
      expect(fs.existsSync(path.join(projectsDir, subdirs[0], 'knowledge.ndjson'))).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // learn()
  // -----------------------------------------------------------------------

  describe('learn', () => {
    it('stores a new entry', () => {
      const store = new KnowledgeStore();
      store.learn('api-url', 'https://example.com', 'user');
      const entries = store.list();
      expect(entries).toHaveLength(1);
      expect(entries[0].key).toBe('api-url');
      expect(entries[0].value).toBe('https://example.com');
      expect(entries[0].source).toBe('user');
      expect(entries[0].createdAt).toBeTypeOf('number');
    });

    it('stores multiple entries with different keys', () => {
      const store = new KnowledgeStore();
      store.learn('a', 'val-a', 's');
      store.learn('b', 'val-b', 's');
      store.learn('c', 'val-c', 's');
      expect(store.list()).toHaveLength(3);
    });

    it('overwrites existing key (dedup)', () => {
      const store = new KnowledgeStore();
      store.learn('color', 'red', 'v1');
      store.learn('color', 'blue', 'v2');
      const entries = store.list();
      expect(entries).toHaveLength(1);
      expect(entries[0].value).toBe('blue');
      expect(entries[0].source).toBe('v2');
    });
  });

  // -----------------------------------------------------------------------
  // recall()
  // -----------------------------------------------------------------------

  describe('recall', () => {
    it('returns entries matching key (case-insensitive)', () => {
      const store = new KnowledgeStore();
      store.learn('API_URL', 'https://api.com', 's');
      store.learn('db-host', 'localhost', 's');
      const results = store.recall('api');
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('API_URL');
    });

    it('returns entries matching value (case-insensitive)', () => {
      const store = new KnowledgeStore();
      store.learn('endpoint', 'https://STAGING.example.com', 's');
      store.learn('other', 'nothing here', 's');
      const results = store.recall('staging');
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('endpoint');
    });

    it('returns multiple matches', () => {
      const store = new KnowledgeStore();
      store.learn('db-host', 'prod-db', 's');
      store.learn('db-port', '5432', 's');
      store.learn('api-key', 'secret', 's');
      const results = store.recall('db');
      expect(results).toHaveLength(2);
    });

    it('returns empty array when nothing matches', () => {
      const store = new KnowledgeStore();
      store.learn('a', 'b', 's');
      expect(store.recall('zzz')).toEqual([]);
    });

    it('returns empty array on empty store', () => {
      const store = new KnowledgeStore();
      expect(store.recall('anything')).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // forget()
  // -----------------------------------------------------------------------

  describe('forget', () => {
    it('removes entry by exact key', () => {
      const store = new KnowledgeStore();
      store.learn('keep', 'yes', 's');
      store.learn('remove', 'no', 's');
      store.forget('remove');
      const entries = store.list();
      expect(entries).toHaveLength(1);
      expect(entries[0].key).toBe('keep');
    });

    it('is a no-op when key does not exist', () => {
      const store = new KnowledgeStore();
      store.learn('a', 'b', 's');
      store.forget('nonexistent');
      expect(store.list()).toHaveLength(1);
    });

    it('is a no-op on empty store', () => {
      const store = new KnowledgeStore();
      store.forget('anything');
      expect(store.list()).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // list()
  // -----------------------------------------------------------------------

  describe('list', () => {
    it('returns empty array when no entries', () => {
      const store = new KnowledgeStore();
      expect(store.list()).toEqual([]);
    });

    it('returns all entries', () => {
      const store = new KnowledgeStore();
      store.learn('x', '1', 's');
      store.learn('y', '2', 's');
      const entries = store.list();
      expect(entries).toHaveLength(2);
      const keys = entries.map(e => e.key);
      expect(keys).toContain('x');
      expect(keys).toContain('y');
    });
  });

  // -----------------------------------------------------------------------
  // readAll() resilience (private, tested via public API)
  // -----------------------------------------------------------------------

  describe('file resilience', () => {
    it('handles missing file gracefully', () => {
      const store = new KnowledgeStore();
      // No file exists yet
      expect(store.list()).toEqual([]);
    });

    it('handles empty file gracefully', () => {
      const store = new KnowledgeStore();
      // Create the dir and an empty file
      const dir = path.join(tmpDir, '.weaver');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'knowledge.ndjson'), '');
      expect(store.list()).toEqual([]);
    });

    it('handles file with only whitespace', () => {
      const store = new KnowledgeStore();
      const dir = path.join(tmpDir, '.weaver');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'knowledge.ndjson'), '  \n\n  \n');
      expect(store.list()).toEqual([]);
    });

    it('skips corrupted JSON lines without crashing', () => {
      const store = new KnowledgeStore();
      const dir = path.join(tmpDir, '.weaver');
      fs.mkdirSync(dir, { recursive: true });
      const good = JSON.stringify({ key: 'valid', value: 'data', source: 's', createdAt: 1 });
      const bad = '{broken json!!!';
      const good2 = JSON.stringify({ key: 'also-valid', value: 'more', source: 's', createdAt: 2 });
      fs.writeFileSync(path.join(dir, 'knowledge.ndjson'), `${good}\n${bad}\n${good2}\n`);
      const entries = store.list();
      expect(entries).toHaveLength(2);
      expect(entries[0].key).toBe('valid');
      expect(entries[1].key).toBe('also-valid');
    });

    it('skips empty lines between valid entries', () => {
      const store = new KnowledgeStore();
      const dir = path.join(tmpDir, '.weaver');
      fs.mkdirSync(dir, { recursive: true });
      const e1 = JSON.stringify({ key: 'a', value: '1', source: 's', createdAt: 1 });
      const e2 = JSON.stringify({ key: 'b', value: '2', source: 's', createdAt: 2 });
      fs.writeFileSync(path.join(dir, 'knowledge.ndjson'), `${e1}\n\n\n${e2}\n`);
      const entries = store.list();
      expect(entries).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------------
  // writeAll() -- directory creation
  // -----------------------------------------------------------------------

  describe('writeAll (directory creation)', () => {
    it('creates parent directories if they do not exist', () => {
      const store = new KnowledgeStore('/deep/nested/project');
      store.learn('test', 'value', 'src');
      // If we got here without error, directory was created
      expect(store.list()).toHaveLength(1);
    });

    it('writes correct NDJSON format', () => {
      const store = new KnowledgeStore();
      store.learn('k1', 'v1', 's1');
      store.learn('k2', 'v2', 's2');
      const filePath = path.join(tmpDir, '.weaver', 'knowledge.ndjson');
      const raw = fs.readFileSync(filePath, 'utf-8');
      const lines = raw.trim().split('\n');
      expect(lines).toHaveLength(2);
      // Each line is valid JSON
      const parsed = lines.map(l => JSON.parse(l));
      expect(parsed[0].key).toBe('k1');
      expect(parsed[1].key).toBe('k2');
    });

    it('writes empty string for empty entries (no trailing newline)', () => {
      const store = new KnowledgeStore();
      store.learn('temp', 'val', 's');
      store.forget('temp');
      const filePath = path.join(tmpDir, '.weaver', 'knowledge.ndjson');
      const raw = fs.readFileSync(filePath, 'utf-8');
      expect(raw).toBe('');
    });
  });

  // -----------------------------------------------------------------------
  // Cross-instance consistency
  // -----------------------------------------------------------------------

  describe('cross-instance consistency', () => {
    it('data persists across separate store instances', () => {
      const store1 = new KnowledgeStore();
      store1.learn('persistent', 'data', 'test');
      const store2 = new KnowledgeStore();
      const entries = store2.list();
      expect(entries).toHaveLength(1);
      expect(entries[0].key).toBe('persistent');
    });
  });

  // -----------------------------------------------------------------------
  // Atomic write (crash safety)
  // -----------------------------------------------------------------------

  describe('atomic write', () => {
    it('writes to a temp file then renames, never directly to knowledge.ndjson', () => {
      const store = new KnowledgeStore();
      fsWritePaths = [];
      fsRenamePairs = [];

      store.learn('key1', 'val1', 'src');

      // writeFileSync should target a .tmp file, NOT knowledge.ndjson directly
      const directWrites = fsWritePaths.filter(p => p.endsWith('knowledge.ndjson'));
      expect(directWrites).toHaveLength(0);

      // renameSync should move the .tmp file to knowledge.ndjson
      const renames = fsRenamePairs.filter(([, to]) => to.endsWith('knowledge.ndjson'));
      expect(renames.length).toBeGreaterThan(0);
      expect(renames[0][0]).toContain('.tmp.');
    });

    it('does not leave orphaned temp files after successful write', () => {
      const store = new KnowledgeStore();
      store.learn('a', '1', 's');
      store.learn('b', '2', 's');
      store.learn('c', '3', 's');

      const dir = path.join(tmpDir, '.weaver');
      const files = fs.readdirSync(dir);
      const tmpFiles = files.filter(f => f.includes('.tmp.'));
      expect(tmpFiles).toHaveLength(0);
    });
  });
});
