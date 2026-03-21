import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('ProjectModelStore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-model-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('filters workflow health to only include runs within the project directory', async () => {
    // Set up a fake run history with runs from multiple projects
    const weaverDir = path.join(os.homedir(), '.weaver');
    const historyPath = path.join(weaverDir, 'history.ndjson');
    const originalHistory = fs.existsSync(historyPath)
      ? fs.readFileSync(historyPath, 'utf-8')
      : null;

    // Write test run records: some in our project, some outside
    const testRuns = [
      { id: 'r1', workflowFile: path.join(tmpDir, 'src/workflows/my-flow.ts'), startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 100, success: true, outcome: 'completed', summary: 'ok', dryRun: false },
      { id: 'r2', workflowFile: path.join(tmpDir, 'src/workflows/my-flow.ts'), startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 200, success: false, outcome: 'failed', summary: 'err', dryRun: false },
      { id: 'r3', workflowFile: '/some/other/project/workflow.ts', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 50, success: true, outcome: 'completed', summary: 'ok', dryRun: false },
      { id: 'r4', workflowFile: '/private/tmp/weaver-demo/workflows/greet.ts', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 30, success: true, outcome: 'completed', summary: 'ok', dryRun: false },
    ];

    // Temporarily write test data
    fs.mkdirSync(weaverDir, { recursive: true });
    const testHistoryPath = path.join(weaverDir, 'history-test-backup.ndjson');
    if (originalHistory !== null) {
      fs.writeFileSync(testHistoryPath, originalHistory, 'utf-8');
    }
    fs.writeFileSync(historyPath, testRuns.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');

    try {
      const { ProjectModelStore } = await import('../src/bot/project-model.js');
      const store = new ProjectModelStore(tmpDir);
      const model = await store.build();

      // Should only include workflows within tmpDir
      const files = model.health.workflows.map(w => w.file);
      expect(files).toHaveLength(1);
      expect(files[0]).toContain('my-flow.ts');

      // Should NOT include workflows from other projects
      expect(files.some(f => f.includes('greet.ts'))).toBe(false);
      expect(files.some(f => f.includes('other/project'))).toBe(false);

      // The one workflow should have correct stats
      const wf = model.health.workflows[0]!;
      expect(wf.totalRuns).toBe(2);
      expect(wf.successRate).toBe(0.5); // 1 success out of 2
    } finally {
      // Restore original history
      if (originalHistory !== null) {
        fs.writeFileSync(historyPath, originalHistory, 'utf-8');
      } else {
        fs.unlinkSync(historyPath);
      }
      if (fs.existsSync(testHistoryPath)) {
        fs.unlinkSync(testHistoryPath);
      }
    }
  });

  it('displays relative paths in workflow health, not absolute paths', async () => {
    const weaverDir = path.join(os.homedir(), '.weaver');
    const historyPath = path.join(weaverDir, 'history.ndjson');
    const originalHistory = fs.existsSync(historyPath)
      ? fs.readFileSync(historyPath, 'utf-8')
      : null;

    const testRuns = [
      { id: 'r1', workflowFile: path.join(tmpDir, 'src/workflows/my-flow.ts'), startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 100, success: true, outcome: 'completed', summary: 'ok', dryRun: false },
    ];

    fs.mkdirSync(weaverDir, { recursive: true });
    fs.writeFileSync(historyPath, testRuns.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');

    try {
      const { ProjectModelStore } = await import('../src/bot/project-model.js');
      const store = new ProjectModelStore(tmpDir);
      const model = await store.build();

      // File path should be relative, not absolute
      const wf = model.health.workflows[0]!;
      expect(wf.file).toBe('src/workflows/my-flow.ts');
      expect(wf.file.startsWith('/')).toBe(false);
    } finally {
      if (originalHistory !== null) {
        fs.writeFileSync(historyPath, originalHistory, 'utf-8');
      } else {
        fs.unlinkSync(historyPath);
      }
    }
  });
});
