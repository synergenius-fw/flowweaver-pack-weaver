import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { weaverBotReport } from '../src/node-types/bot-report.js';

describe('weaverBotReport', () => {
  it('returns empty report when not executing', async () => {
    const result = await weaverBotReport(false);
    expect(result.summary).toBe('');
    const report = JSON.parse(result.reportJson);
    expect(report.path).toBe('unknown');
  });

  it('returns empty report when no context provided', async () => {
    const result = await weaverBotReport(true);
    expect(result.summary).toBe('');
  });

  it('generates summary from main context', async () => {
    const ctx = JSON.stringify({
      env: { projectDir: '/tmp', config: {}, providerInfo: { type: 'claude-cli' } },
      taskJson: JSON.stringify({ instruction: 'Fix bugs' }),
      resultJson: JSON.stringify({ success: true, outcome: 'completed', summary: 'Fixed 3 bugs' }),
      filesModified: JSON.stringify(['/tmp/a.ts', '/tmp/b.ts']),
    });

    const result = await weaverBotReport(true, ctx);
    expect(result.summary).toContain('Fix bugs');
    expect(result.summary).toContain('completed');
    expect(result.summary).toContain('2 modified');

    const report = JSON.parse(result.reportJson);
    expect(report.path).toBe('main');
  });

  it('generates summary from read context', async () => {
    const ctx = JSON.stringify({
      env: { projectDir: '/tmp', config: {}, providerInfo: { type: 'claude-cli' } },
      resultJson: JSON.stringify({ success: true }),
    });

    const result = await weaverBotReport(true, undefined, ctx);
    const report = JSON.parse(result.reportJson);
    expect(report.path).toBe('read');
  });

  it('generates summary from abort context', async () => {
    const ctx = JSON.stringify({
      env: { projectDir: '/tmp', config: {}, providerInfo: { type: 'claude-cli' } },
      resultJson: JSON.stringify({ success: false }),
    });

    const result = await weaverBotReport(true, undefined, undefined, ctx);
    const report = JSON.parse(result.reportJson);
    expect(report.path).toBe('abort');
  });

  it('includes git commit info in summary', async () => {
    const ctx = JSON.stringify({
      env: { projectDir: '/tmp', config: {}, providerInfo: { type: 'claude-cli' } },
      gitResultJson: JSON.stringify({ skipped: false, results: ['Committed'] }),
    });

    const result = await weaverBotReport(true, ctx);
    expect(result.summary).toContain('Git: committed');
  });

  it('abort context with result.success=false sets onFailure=true and onSuccess=false', async () => {
    const abortCtx = JSON.stringify({
      env: { projectDir: '/tmp', config: {}, providerInfo: { type: 'claude-cli' } },
      resultJson: JSON.stringify({ success: false }),
    });

    const result = await weaverBotReport(true, undefined, undefined, abortCtx);

    expect(result.onFailure).toBe(true);
    expect(result.onSuccess).toBe(false);
  });

  it('main context with result.success=false sets onFailure=true and onSuccess=false', async () => {
    const mainCtx = JSON.stringify({
      env: { projectDir: '/tmp', config: {}, providerInfo: { type: 'claude-cli' } },
      resultJson: JSON.stringify({ success: false }),
    });

    const result = await weaverBotReport(true, mainCtx);

    expect(result.onFailure).toBe(true);
    expect(result.onSuccess).toBe(false);
  });

  it('gitResult with skipped=true does not add Git:committed to summary', async () => {
    const ctx = JSON.stringify({
      env: { projectDir: '/tmp', config: {}, providerInfo: { type: 'claude-cli' } },
      gitResultJson: JSON.stringify({ skipped: true, results: [] }),
    });

    const result = await weaverBotReport(true, ctx);

    expect(result.summary).not.toContain('Git');
  });
});

describe('weaverBotReport queue integration', () => {
  let tmpDir: string;
  let queuePath: string;
  let origHome: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-report-'));
    const weaverDir = path.join(tmpDir, '.weaver');
    fs.mkdirSync(weaverDir, { recursive: true });
    queuePath = path.join(weaverDir, 'task-queue.ndjson');
    origHome = os.homedir();
    // Override HOME so bot-report finds our test queue
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('marks queue task as completed on success', async () => {
    // Create a task in the queue
    const task = { id: 'test-123', instruction: 'test', priority: 0, addedAt: Date.now(), status: 'running' };
    fs.writeFileSync(queuePath, JSON.stringify(task) + '\n');

    const ctx = JSON.stringify({
      env: { projectDir: '/tmp', config: {}, providerInfo: { type: 'claude-cli' } },
      taskJson: JSON.stringify({ instruction: 'test', queueId: 'test-123' }),
      resultJson: JSON.stringify({ success: true }),
    });

    await weaverBotReport(true, ctx);

    // Check queue was updated
    const content = fs.readFileSync(queuePath, 'utf-8').trim();
    const updated = JSON.parse(content.split('\n')[0]);
    expect(updated.status).toBe('completed');
  });

  it('marks queue task as failed on failure', async () => {
    const task = { id: 'fail-456', instruction: 'fail', priority: 0, addedAt: Date.now(), status: 'running' };
    fs.writeFileSync(queuePath, JSON.stringify(task) + '\n');

    const ctx = JSON.stringify({
      env: { projectDir: '/tmp', config: {}, providerInfo: { type: 'claude-cli' } },
      taskJson: JSON.stringify({ instruction: 'fail', queueId: 'fail-456' }),
      resultJson: JSON.stringify({ success: false }),
    });

    await weaverBotReport(true, ctx);

    const content = fs.readFileSync(queuePath, 'utf-8').trim();
    const updated = JSON.parse(content.split('\n')[0]);
    expect(updated.status).toBe('failed');
  });

  it('marks abort path tasks as failed', async () => {
    const task = { id: 'abort-789', instruction: 'abort', priority: 0, addedAt: Date.now(), status: 'running' };
    fs.writeFileSync(queuePath, JSON.stringify(task) + '\n');

    const ctx = JSON.stringify({
      env: { projectDir: '/tmp', config: {}, providerInfo: { type: 'claude-cli' } },
      taskJson: JSON.stringify({ instruction: 'abort', queueId: 'abort-789' }),
    });

    await weaverBotReport(true, undefined, undefined, ctx);

    const content = fs.readFileSync(queuePath, 'utf-8').trim();
    const updated = JSON.parse(content.split('\n')[0]);
    expect(updated.status).toBe('failed');
  });

  it('handles missing queueId gracefully (no queue update)', async () => {
    const ctx = JSON.stringify({
      env: { projectDir: '/tmp', config: {}, providerInfo: { type: 'claude-cli' } },
      taskJson: JSON.stringify({ instruction: 'no queue id' }),
      resultJson: JSON.stringify({ success: true }),
    });

    // Should not throw
    const result = await weaverBotReport(true, ctx);
    expect(result.summary).toContain('no queue id');
  });

  it('handles missing queue file gracefully', async () => {
    // Delete queue file
    if (fs.existsSync(queuePath)) fs.unlinkSync(queuePath);

    const ctx = JSON.stringify({
      env: { projectDir: '/tmp', config: {}, providerInfo: { type: 'claude-cli' } },
      taskJson: JSON.stringify({ instruction: 'test', queueId: 'missing-queue' }),
      resultJson: JSON.stringify({ success: true }),
    });

    // Should not throw
    const result = await weaverBotReport(true, ctx);
    expect(result.summary).toContain('test');
  });

  it('queueId present but no matching task in queue — file unchanged', async () => {
    const otherTask = { id: 'other-task-999', instruction: 'other', priority: 0, addedAt: Date.now(), status: 'pending' };
    fs.writeFileSync(queuePath, JSON.stringify(otherTask) + '\n');

    const ctx = JSON.stringify({
      env: { projectDir: '/tmp', config: {}, providerInfo: { type: 'claude-cli' } },
      taskJson: JSON.stringify({ instruction: 'no match', queueId: 'nonexistent-id' }),
      resultJson: JSON.stringify({ success: true }),
    });

    await weaverBotReport(true, ctx);

    // Queue file must be unchanged — the mismatched task still has status 'pending'
    const content = fs.readFileSync(queuePath, 'utf-8').trim();
    const tasks = content.split('\n').filter(Boolean).map(l => JSON.parse(l));
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('other-task-999');
    expect(tasks[0].status).toBe('pending');
  });
});
