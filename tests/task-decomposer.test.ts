import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { decomposeTask, type DecomposableTask } from '../src/bot/task-decomposer.js';

describe('decomposeTask', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decompose-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Helper: create files in a target subdir
  // -----------------------------------------------------------------------
  function createFiles(subdir: string, files: string[]): void {
    const dir = path.join(tmpDir, subdir);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of files) {
      fs.writeFileSync(path.join(dir, f), `// ${f}`, 'utf-8');
    }
  }

  function makeTask(overrides: Partial<DecomposableTask> = {}): DecomposableTask {
    return {
      id: 'task-1',
      instruction: 'Fix all templates',
      ...overrides,
    };
  }

  // -----------------------------------------------------------------------
  // No decomposition cases
  // -----------------------------------------------------------------------

  describe('returns original task without decomposition', () => {
    it('when instruction does not match any broad pattern', () => {
      const task = makeTask({ instruction: 'Add error handling to parser' });
      const result = decomposeTask(task, tmpDir);
      expect(result.decomposed).toBe(false);
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0]!.id).toBe('task-1');
    });

    it('when task already has a single target', () => {
      createFiles('src/templates', ['foo.ts', 'bar.ts']);
      const task = makeTask({
        instruction: 'Fix all templates',
        targets: ['src/templates/foo.ts'],
      });
      const result = decomposeTask(task, tmpDir);
      expect(result.decomposed).toBe(false);
      expect(result.tasks).toHaveLength(1);
    });

    it('when target directory does not exist', () => {
      const task = makeTask({ instruction: 'Fix all templates' });
      const result = decomposeTask(task, tmpDir);
      expect(result.decomposed).toBe(false);
    });

    it('when target directory is empty (no .ts files)', () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'templates'), { recursive: true });
      const task = makeTask({ instruction: 'Fix all templates' });
      const result = decomposeTask(task, tmpDir);
      expect(result.decomposed).toBe(false);
    });

    it('when instruction mentions a directory we do not target', () => {
      const task = makeTask({ instruction: 'Fix all handlers' });
      const result = decomposeTask(task, tmpDir);
      expect(result.decomposed).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Broad pattern matching
  // -----------------------------------------------------------------------

  describe('recognizes broad patterns', () => {
    it('matches "Fix all templates"', () => {
      createFiles('src/templates', ['a.ts', 'b.ts']);
      const result = decomposeTask(makeTask({ instruction: 'Fix all templates' }), tmpDir);
      expect(result.decomposed).toBe(true);
      expect(result.tasks).toHaveLength(2);
    });

    it('matches "Validate every workflow"', () => {
      createFiles('src/workflows', ['deploy.ts', 'build.ts']);
      const result = decomposeTask(makeTask({ instruction: 'Validate every workflow' }), tmpDir);
      expect(result.decomposed).toBe(true);
      expect(result.tasks).toHaveLength(2);
    });

    it('matches "Check each node type"', () => {
      createFiles('src/node-types', ['fetch.ts', 'parse.ts']);
      const result = decomposeTask(makeTask({ instruction: 'Check each node type' }), tmpDir);
      expect(result.decomposed).toBe(true);
      expect(result.tasks).toHaveLength(2);
    });

    it('matches "Validate all files in src/templates"', () => {
      createFiles('src/templates', ['x.ts']);
      const result = decomposeTask(
        makeTask({ instruction: 'Validate all files in src/templates' }),
        tmpDir,
      );
      expect(result.decomposed).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Decomposition output structure
  // -----------------------------------------------------------------------

  describe('decomposed task structure', () => {
    beforeEach(() => {
      createFiles('src/templates', ['alpha.ts', 'beta.ts', 'gamma.ts']);
    });

    it('generates sequential sub-IDs from the parent task ID', () => {
      const result = decomposeTask(makeTask({ id: 'parent' }), tmpDir);
      expect(result.tasks.map(t => t.id)).toEqual(['parent-1', 'parent-2', 'parent-3']);
    });

    it('sets targets to the file path for each sub-task', () => {
      const result = decomposeTask(makeTask(), tmpDir);
      for (const task of result.tasks) {
        expect(task.targets).toHaveLength(1);
        expect(task.targets![0]).toMatch(/^src\/templates\/.+\.ts$/);
      }
    });

    it('extracts the verb from the original instruction', () => {
      const result = decomposeTask(makeTask({ instruction: 'Validate all templates' }), tmpDir);
      for (const task of result.tasks) {
        expect(task.instruction).toMatch(/^Validate /);
      }
    });

    it('uses "Process" as default verb when no verb is recognized', () => {
      // Force a broad match with a non-standard verb
      const task = makeTask({ instruction: 'Do something for all templates' });
      const result = decomposeTask(task, tmpDir);
      // "Do" is not in the recognized verb list
      for (const t of result.tasks) {
        expect(t.instruction).toMatch(/^Process /);
      }
    });

    it('inherits mode from parent task', () => {
      const task = makeTask({ mode: 'validate' });
      const result = decomposeTask(task, tmpDir);
      for (const t of result.tasks) {
        expect(t.mode).toBe('validate');
      }
    });

    it('defaults mode to "modify" when parent has no mode', () => {
      const task = makeTask();
      delete task.mode;
      const result = decomposeTask(task, tmpDir);
      for (const t of result.tasks) {
        expect(t.mode).toBe('modify');
      }
    });

    it('inherits priority from parent task', () => {
      const task = makeTask({ priority: 5 });
      const result = decomposeTask(task, tmpDir);
      for (const t of result.tasks) {
        expect(t.priority).toBe(5);
      }
    });

    it('defaults priority to 0 when parent has no priority', () => {
      const task = makeTask();
      delete task.priority;
      const result = decomposeTask(task, tmpDir);
      for (const t of result.tasks) {
        expect(t.priority).toBe(0);
      }
    });
  });

  // -----------------------------------------------------------------------
  // File filtering
  // -----------------------------------------------------------------------

  describe('file filtering', () => {
    it('excludes index.ts files', () => {
      createFiles('src/templates', ['index.ts', 'real.ts']);
      const result = decomposeTask(makeTask(), tmpDir);
      expect(result.decomposed).toBe(true);
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0]!.targets![0]).toContain('real.ts');
    });

    it('excludes non-.ts files', () => {
      createFiles('src/templates', ['readme.md', 'data.json', 'valid.ts']);
      const result = decomposeTask(makeTask(), tmpDir);
      expect(result.decomposed).toBe(true);
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0]!.targets![0]).toContain('valid.ts');
    });

    it('returns sorted file order (alphabetical)', () => {
      createFiles('src/templates', ['zebra.ts', 'alpha.ts', 'middle.ts']);
      const result = decomposeTask(makeTask(), tmpDir);
      const names = result.tasks.map(t => path.basename(t.targets![0]!));
      expect(names).toEqual(['alpha.ts', 'middle.ts', 'zebra.ts']);
    });
  });

  // -----------------------------------------------------------------------
  // Guard: too many files (>50)
  // -----------------------------------------------------------------------

  describe('file count guard', () => {
    it('does not decompose when directory has more than 50 .ts files', () => {
      const files = Array.from({ length: 51 }, (_, i) => `file-${i}.ts`);
      createFiles('src/templates', files);
      const result = decomposeTask(makeTask(), tmpDir);
      expect(result.decomposed).toBe(false);
      expect(result.tasks).toHaveLength(1);
    });

    it('decomposes when directory has exactly 50 .ts files', () => {
      const files = Array.from({ length: 50 }, (_, i) => `file-${i}.ts`);
      createFiles('src/templates', files);
      const result = decomposeTask(makeTask(), tmpDir);
      expect(result.decomposed).toBe(true);
      expect(result.tasks).toHaveLength(50);
    });
  });

  // -----------------------------------------------------------------------
  // Multiple targets bypass
  // -----------------------------------------------------------------------

  describe('multiple explicit targets', () => {
    it('decomposes even with multiple targets if instruction matches', () => {
      createFiles('src/templates', ['a.ts', 'b.ts']);
      const task = makeTask({
        instruction: 'Fix all templates',
        targets: ['src/templates/a.ts', 'src/templates/b.ts'],
      });
      // targets.length > 1, so the early exit for single-target doesn't trigger
      const result = decomposeTask(task, tmpDir);
      expect(result.decomposed).toBe(true);
    });
  });
});
