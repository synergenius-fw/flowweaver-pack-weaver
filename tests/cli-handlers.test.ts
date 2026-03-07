import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parseArgs, handleEject } from '../src/cli-handlers.js';

describe('parseArgs', () => {
  it('defaults to run command', () => {
    const opts = parseArgs(['node', 'weaver']);
    expect(opts.command).toBe('run');
    expect(opts.verbose).toBe(false);
    expect(opts.dryRun).toBe(false);
    expect(opts.quiet).toBe(false);
  });

  it('parses run with file', () => {
    const opts = parseArgs(['node', 'weaver', 'run', 'my-workflow.ts']);
    expect(opts.command).toBe('run');
    expect(opts.file).toBe('my-workflow.ts');
  });

  it('parses implicit run (file without run keyword)', () => {
    const opts = parseArgs(['node', 'weaver', 'my-workflow.ts']);
    expect(opts.command).toBe('run');
    expect(opts.file).toBe('my-workflow.ts');
  });

  it('parses history command', () => {
    const opts = parseArgs(['node', 'weaver', 'history']);
    expect(opts.command).toBe('history');
  });

  it('parses history with id', () => {
    const opts = parseArgs(['node', 'weaver', 'history', 'abc123']);
    expect(opts.command).toBe('history');
    expect(opts.historyId).toBe('abc123');
  });

  it('parses costs command', () => {
    const opts = parseArgs(['node', 'weaver', 'costs']);
    expect(opts.command).toBe('costs');
  });

  it('parses providers command', () => {
    const opts = parseArgs(['node', 'weaver', 'providers']);
    expect(opts.command).toBe('providers');
  });

  it('parses eject command', () => {
    const opts = parseArgs(['node', 'weaver', 'eject']);
    expect(opts.command).toBe('eject');
  });

  it('parses eject with --workflow flag', () => {
    const opts = parseArgs(['node', 'weaver', 'eject', '--workflow', 'bot']);
    expect(opts.command).toBe('eject');
    expect(opts.ejectWorkflow).toBe('bot');
  });

  it('parses watch command', () => {
    const opts = parseArgs(['node', 'weaver', 'watch', 'my.ts']);
    expect(opts.command).toBe('watch');
    expect(opts.file).toBe('my.ts');
  });

  it('parses cron command with schedule', () => {
    const opts = parseArgs(['node', 'weaver', 'cron', '*/5 * * * *', 'my.ts']);
    expect(opts.command).toBe('cron');
    expect(opts.cronSchedule).toBe('*/5 * * * *');
    expect(opts.file).toBe('my.ts');
  });

  it('parses pipeline command', () => {
    const opts = parseArgs(['node', 'weaver', 'pipeline', 'config.json']);
    expect(opts.command).toBe('pipeline');
    expect(opts.file).toBe('config.json');
  });

  it('parses dashboard command', () => {
    const opts = parseArgs(['node', 'weaver', 'dashboard']);
    expect(opts.command).toBe('dashboard');
    expect(opts.dashboard).toBe(true);
  });

  it('parses verbose flag', () => {
    const opts = parseArgs(['node', 'weaver', '-v', 'file.ts']);
    expect(opts.verbose).toBe(true);
  });

  it('parses dry-run flag', () => {
    const opts = parseArgs(['node', 'weaver', '-n', 'file.ts']);
    expect(opts.dryRun).toBe(true);
  });

  it('parses params as JSON', () => {
    const opts = parseArgs(['node', 'weaver', '-p', '{"key":"val"}', 'file.ts']);
    expect(opts.params).toEqual({ key: 'val' });
  });

  it('parses config path', () => {
    const opts = parseArgs(['node', 'weaver', '-c', '/path/to/.weaver.json', 'file.ts']);
    expect(opts.configPath).toBe('/path/to/.weaver.json');
  });

  it('parses history options', () => {
    const opts = parseArgs([
      'node', 'weaver', 'history',
      '--limit', '10',
      '--outcome', 'failed',
      '--json',
    ]);
    expect(opts.historyLimit).toBe(10);
    expect(opts.historyOutcome).toBe('failed');
    expect(opts.historyJson).toBe(true);
  });

  it('parses dashboard options', () => {
    const opts = parseArgs([
      'node', 'weaver', 'dashboard', 'file.ts',
      '--port', '5000',
      '--open',
    ]);
    expect(opts.dashboardPort).toBe(5000);
    expect(opts.dashboardOpen).toBe(true);
  });

  it('parses approval override', () => {
    const opts = parseArgs(['node', 'weaver', '--approval', 'web', 'file.ts']);
    expect(opts.approvalMode).toBe('web');
  });

  it('--workflow routes to historyWorkflow for history command', () => {
    const opts = parseArgs(['node', 'weaver', 'history', '--workflow', 'my-wf.ts']);
    expect(opts.historyWorkflow).toBe('my-wf.ts');
    expect(opts.ejectWorkflow).toBeUndefined();
  });
});

describe('handleEject', () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-eject-'));
    origCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ejects all workflows by default', async () => {
    const opts = parseArgs(['node', 'weaver', 'eject']);
    await handleEject(opts);

    expect(fs.existsSync(path.join(tmpDir, 'weaver-bot.ts'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'weaver-bot-batch.ts'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'genesis-task.ts'))).toBe(true);

    const metaPath = path.join(tmpDir, '.weaver-meta.json');
    expect(fs.existsSync(metaPath)).toBe(true);

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    expect(meta.ejected).toBe(true);
    expect(meta.workflowFiles.bot).toBe('weaver-bot.ts');
    expect(meta.workflowFiles.batch).toBe('weaver-bot-batch.ts');
    expect(meta.workflowFiles.genesis).toBe('genesis-task.ts');
    expect(typeof meta.packVersion).toBe('string');
  });

  it('ejects a single workflow with --workflow flag', async () => {
    const opts = parseArgs(['node', 'weaver', 'eject', '--workflow', 'bot']);
    await handleEject(opts);

    expect(fs.existsSync(path.join(tmpDir, 'weaver-bot.ts'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'weaver-bot-batch.ts'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'genesis-task.ts'))).toBe(false);

    const meta = JSON.parse(fs.readFileSync(path.join(tmpDir, '.weaver-meta.json'), 'utf-8'));
    expect(meta.workflowFiles.bot).toBe('weaver-bot.ts');
    expect(meta.workflowFiles.batch).toBeUndefined();
  });

  it('rewrites imports to package imports', async () => {
    const opts = parseArgs(['node', 'weaver', 'eject', '--workflow', 'bot']);
    await handleEject(opts);

    const content = fs.readFileSync(path.join(tmpDir, 'weaver-bot.ts'), 'utf-8');
    expect(content).toContain('@synergenius/flowweaver-pack-weaver/node-types');
    expect(content).not.toContain('../node-types/');
  });

  it('ejected workflow contains flow-weaver annotations', async () => {
    const opts = parseArgs(['node', 'weaver', 'eject', '--workflow', 'bot']);
    await handleEject(opts);

    const content = fs.readFileSync(path.join(tmpDir, 'weaver-bot.ts'), 'utf-8');
    expect(content).toContain('@flowWeaver workflow');
    expect(content).toContain('weaverLoadConfig');
    expect(content).toContain('weaverReceiveTask');
  });

  it('merges with existing meta on incremental eject', async () => {
    // Eject bot first
    const opts1 = parseArgs(['node', 'weaver', 'eject', '--workflow', 'bot']);
    await handleEject(opts1);

    // Then eject genesis
    const opts2 = parseArgs(['node', 'weaver', 'eject', '--workflow', 'genesis']);
    await handleEject(opts2);

    const meta = JSON.parse(fs.readFileSync(path.join(tmpDir, '.weaver-meta.json'), 'utf-8'));
    expect(meta.workflowFiles.bot).toBe('weaver-bot.ts');
    expect(meta.workflowFiles.genesis).toBe('genesis-task.ts');
  });
});
