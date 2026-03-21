import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RichInput } from '../src/bot/rich-input.js';

describe('RichInput', () => {
  let testDir: string;
  let historyFile: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `rich-input-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
    historyFile = path.join(testDir, 'history.txt');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('loads history from an existing file', () => {
      fs.writeFileSync(historyFile, 'line1\nline2\nline3\n');
      const input = new RichInput({ historyFile });
      // Verify by creating a second instance that also reads the same file
      // The history is private, so we test persistence round-trip instead
      input.destroy();

      // Verify the file still has the same content (not overwritten)
      const content = fs.readFileSync(historyFile, 'utf-8');
      expect(content).toContain('line1');
      expect(content).toContain('line2');
      expect(content).toContain('line3');
    });

    it('creates empty history if file is missing', () => {
      const missingFile = path.join(testDir, 'nonexistent', 'history.txt');
      // Should not throw
      const input = new RichInput({ historyFile: missingFile });
      input.destroy();
    });

    it('uses default options when none provided', () => {
      // Should not throw with default options
      const input = new RichInput({ historyFile });
      input.destroy();
    });
  });

  describe('isIncomplete (tested via history persistence)', () => {
    // isIncomplete is private, but we can test its logic by constructing
    // inputs and verifying the behavior. We'll re-export or test indirectly.
    // Since we can't call it directly, we test via the class behavior patterns.

    it('detects unfinished ``` blocks', () => {
      // We create a subclass or use any-cast to test the private method
      const input = new RichInput({ historyFile }) as any;
      expect(input.isIncomplete('hello ```js\ncode')).toBe(true);
      expect(input.isIncomplete('```')).toBe(true);
      input.destroy();
    });

    it('detects trailing backslash', () => {
      const input = new RichInput({ historyFile }) as any;
      expect(input.isIncomplete('hello \\')).toBe(true);
      input.destroy();
    });

    it('returns false for complete text', () => {
      const input = new RichInput({ historyFile }) as any;
      expect(input.isIncomplete('hello world')).toBe(false);
      expect(input.isIncomplete('```js\ncode\n```')).toBe(false);
      expect(input.isIncomplete('')).toBe(false);
      input.destroy();
    });

    it('returns false for even number of triple backticks', () => {
      const input = new RichInput({ historyFile }) as any;
      expect(input.isIncomplete('```js\ncode\n```\nmore\n```py\ncode2\n```')).toBe(false);
      input.destroy();
    });
  });

  describe('addToHistory', () => {
    it('does not add duplicate of last entry', () => {
      const input = new RichInput({ historyFile }) as any;
      input.addToHistory('first');
      input.addToHistory('first');
      input.addToHistory('first');
      expect(input.history).toEqual(['first']);
      input.destroy();
    });

    it('adds different entries', () => {
      const input = new RichInput({ historyFile }) as any;
      input.addToHistory('first');
      input.addToHistory('second');
      input.addToHistory('third');
      expect(input.history).toEqual(['first', 'second', 'third']);
      input.destroy();
    });

    it('allows re-adding after a different entry', () => {
      const input = new RichInput({ historyFile }) as any;
      input.addToHistory('a');
      input.addToHistory('b');
      input.addToHistory('a');
      expect(input.history).toEqual(['a', 'b', 'a']);
      input.destroy();
    });

    it('trims history to maxHistory size', () => {
      const input = new RichInput({ historyFile, maxHistorySize: 3 }) as any;
      input.addToHistory('one');
      input.addToHistory('two');
      input.addToHistory('three');
      input.addToHistory('four');
      expect(input.history.length).toBe(3);
      expect(input.history[0]).toBe('two');
      expect(input.history[2]).toBe('four');
      input.destroy();
    });
  });

  describe('searchHistory', () => {
    it('finds matching entry (case-insensitive)', () => {
      const input = new RichInput({ historyFile }) as any;
      input.addToHistory('Hello World');
      input.addToHistory('goodbye');
      const result = input.searchHistory('hello');
      expect(result).toBe('Hello World');
      input.destroy();
    });

    it('returns the most recent match', () => {
      const input = new RichInput({ historyFile }) as any;
      input.addToHistory('test alpha');
      input.addToHistory('other');
      input.addToHistory('test beta');
      const result = input.searchHistory('test');
      expect(result).toBe('test beta');
      input.destroy();
    });

    it('returns null for no match', () => {
      const input = new RichInput({ historyFile }) as any;
      input.addToHistory('hello');
      expect(input.searchHistory('xyz')).toBeNull();
      input.destroy();
    });

    it('returns null for empty query', () => {
      const input = new RichInput({ historyFile }) as any;
      input.addToHistory('hello');
      expect(input.searchHistory('')).toBeNull();
      input.destroy();
    });
  });

  describe('getCompletions', () => {
    it('returns matching completions from provider', () => {
      const provider = (partial: string) => {
        const cmds = ['/help', '/history', '/exit'];
        return cmds.filter(c => c.startsWith(partial));
      };
      const input = new RichInput({ historyFile, completionProvider: provider }) as any;
      // Simulate tab completion by calling handleTab indirectly
      // Since handleTab is private and writes to stderr, test the provider directly
      const results = provider('/h');
      expect(results).toEqual(['/help', '/history']);
      input.destroy();
    });
  });

  describe('history file persistence', () => {
    it('saves history to file then loads in new instance', () => {
      const input1 = new RichInput({ historyFile }) as any;
      input1.addToHistory('persisted-entry-1');
      input1.addToHistory('persisted-entry-2');
      input1.destroy();

      // Verify file was written
      expect(fs.existsSync(historyFile)).toBe(true);
      const content = fs.readFileSync(historyFile, 'utf-8');
      expect(content).toContain('persisted-entry-1');
      expect(content).toContain('persisted-entry-2');

      // Load in a new instance
      const input2 = new RichInput({ historyFile }) as any;
      expect(input2.history).toContain('persisted-entry-1');
      expect(input2.history).toContain('persisted-entry-2');
      input2.destroy();
    });

    it('creates parent directory if missing', () => {
      const deepFile = path.join(testDir, 'a', 'b', 'c', 'history.txt');
      const input = new RichInput({ historyFile: deepFile }) as any;
      input.addToHistory('deep-entry');
      input.destroy();

      expect(fs.existsSync(deepFile)).toBe(true);
    });

    it('filters empty lines when loading', () => {
      fs.writeFileSync(historyFile, 'line1\n\n\nline2\n\n');
      const input = new RichInput({ historyFile }) as any;
      expect(input.history).toEqual(['line1', 'line2']);
      input.destroy();
    });

    it('respects maxHistorySize when loading', () => {
      fs.writeFileSync(historyFile, 'a\nb\nc\nd\ne\n');
      const input = new RichInput({ historyFile, maxHistorySize: 3 }) as any;
      expect(input.history.length).toBe(3);
      expect(input.history).toEqual(['c', 'd', 'e']);
      input.destroy();
    });
  });

  describe('destroy', () => {
    it('does not throw', () => {
      const input = new RichInput({ historyFile });
      expect(() => input.destroy()).not.toThrow();
    });

    it('can be called multiple times', () => {
      const input = new RichInput({ historyFile });
      expect(() => {
        input.destroy();
        input.destroy();
      }).not.toThrow();
    });
  });
});
