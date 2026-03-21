import { handleInit, printHelp, parseArgs } from '../src/cli-handlers.js';
import { handleCommand } from '../src/cli-bridge.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// handleInit
// ---------------------------------------------------------------------------
describe('handleInit', () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-init-'));
    origCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildOpts(overrides: Partial<ReturnType<typeof parseArgs>> = {}) {
    const defaults = parseArgs(['node', 'weaver', 'init']);
    return { ...defaults, ...overrides };
  }

  it('creates .weaver.json in the specified directory', async () => {
    const opts = buildOpts({ file: tmpDir });
    await handleInit(opts);

    const configPath = path.join(tmpDir, '.weaver.json');
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it('created file is valid JSON with provider and approval fields', async () => {
    const opts = buildOpts({ file: tmpDir });
    await handleInit(opts);

    const configPath = path.join(tmpDir, '.weaver.json');
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw);

    expect(config).toHaveProperty('provider');
    expect(config).toHaveProperty('approval');
    // approval is always 'auto' for a fresh init
    expect(config.approval).toBe('auto');
    // provider is either 'auto' or an object with a name property
    if (typeof config.provider === 'string') {
      expect(config.provider).toBe('auto');
    } else {
      expect(config.provider).toHaveProperty('name');
      expect(typeof config.provider.name).toBe('string');
    }
  });

  it('does NOT overwrite an existing config (idempotent)', async () => {
    const configPath = path.join(tmpDir, '.weaver.json');
    const existingContent = JSON.stringify({ custom: true }, null, 2) + '\n';
    fs.writeFileSync(configPath, existingContent, 'utf-8');

    const opts = buildOpts({ file: tmpDir });
    await handleInit(opts);

    const afterContent = fs.readFileSync(configPath, 'utf-8');
    expect(afterContent).toBe(existingContent);
  });

  it('outputs "already exists" message when config is present', async () => {
    const configPath = path.join(tmpDir, '.weaver.json');
    fs.writeFileSync(configPath, '{}', 'utf-8');

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const opts = buildOpts({ file: tmpDir });
      await handleInit(opts);

      const output = spy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toContain('already exists');
    } finally {
      spy.mockRestore();
    }
  });

  it('uses cwd when opts.file is undefined', async () => {
    process.chdir(tmpDir);
    const opts = buildOpts({ file: undefined });
    await handleInit(opts);

    expect(fs.existsSync(path.join(tmpDir, '.weaver.json'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// printHelp
// ---------------------------------------------------------------------------
describe('printHelp', () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    spy.mockRestore();
  });

  function capturedOutput(): string {
    return spy.mock.calls.map((c) => c.join(' ')).join('\n');
  }

  it('prints general help when called with no arguments', () => {
    printHelp();
    const output = capturedOutput();
    expect(output).toContain('Get started:');
    expect(output).toContain('Quick start:');
    expect(output).toContain('init');
  });

  it('general help includes the bot and run commands', () => {
    printHelp();
    const output = capturedOutput();
    expect(output).toContain('bot');
    expect(output).toContain('run');
  });

  it('prints bot-specific help including --file, --template, --auto-approve', () => {
    printHelp('bot');
    const output = capturedOutput();
    expect(output).toContain('--file');
    expect(output).toContain('--template');
    expect(output).toContain('--auto-approve');
  });

  it('prints run-specific help', () => {
    printHelp('run');
    const output = capturedOutput();
    expect(output).toContain('--dashboard');
    expect(output).toContain('--port');
  });

  it('prints history-specific help with --limit, --outcome, etc.', () => {
    printHelp('history');
    const output = capturedOutput();
    expect(output).toContain('--limit');
    expect(output).toContain('--outcome');
    expect(output).toContain('--since');
    expect(output).toContain('--json');
    expect(output).toContain('--prune');
    expect(output).toContain('--clear');
  });

  it('prints init-specific usage line', () => {
    printHelp('init');
    const output = capturedOutput();
    // init has a COMMAND_HELP entry so it prints the usage line
    expect(output).toContain('init');
  });

  it('falls back to general help for unknown command name', () => {
    printHelp('nonexistent');
    const output = capturedOutput();
    expect(output).toContain('Get started:');
  });
});

// ---------------------------------------------------------------------------
// parseArgs — init and help related
// ---------------------------------------------------------------------------
describe('parseArgs — init and help', () => {
  it('parses "init" as the command', () => {
    const opts = parseArgs(['node', 'weaver', 'init']);
    expect(opts.command).toBe('init');
  });

  it('parses init with a positional file argument', () => {
    const opts = parseArgs(['node', 'weaver', 'init', './my-project']);
    expect(opts.command).toBe('init');
    expect(opts.file).toBe('./my-project');
  });

  it('sets showHelp when --help flag is present', () => {
    const opts = parseArgs(['node', 'weaver', 'bot', '--help']);
    expect(opts.showHelp).toBe(true);
  });

  it('sets showHelp with -h shorthand', () => {
    const opts = parseArgs(['node', 'weaver', '-h']);
    expect(opts.showHelp).toBe(true);
  });

  it('preserves command when --help is combined with init', () => {
    const opts = parseArgs(['node', 'weaver', 'init', '--help']);
    expect(opts.command).toBe('init');
    expect(opts.showHelp).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleCommand (cli-bridge) — init related
// ---------------------------------------------------------------------------
describe('handleCommand — init', () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-bridge-init-'));
    origCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not throw "Unknown" for the init command', async () => {
    // Running init in a tmpDir so it actually creates the file harmlessly.
    await expect(handleCommand('init', [])).resolves.not.toThrow();
  });

  it('handleCommand("init", ["--help"]) does not throw', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(handleCommand('init', ['--help'])).resolves.not.toThrow();
      // Verify it actually printed help
      const output = spy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toContain('init');
    } finally {
      spy.mockRestore();
    }
  });

  it('handleCommand("init", []) creates .weaver.json in cwd', async () => {
    await handleCommand('init', []);
    expect(fs.existsSync(path.join(tmpDir, '.weaver.json'))).toBe(true);
  });

  it('handleCommand("init", []) is idempotent via the bridge', async () => {
    // First call creates the file
    await handleCommand('init', []);
    const first = fs.readFileSync(path.join(tmpDir, '.weaver.json'), 'utf-8');

    // Second call should not overwrite
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await handleCommand('init', []);
      const second = fs.readFileSync(path.join(tmpDir, '.weaver.json'), 'utf-8');
      expect(second).toBe(first);

      const output = spy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toContain('already exists');
    } finally {
      spy.mockRestore();
    }
  });
});
