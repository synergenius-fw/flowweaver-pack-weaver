import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const { mockExecFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFileSync: mockExecFileSync };
});

import { weaverLoadConfig } from '../src/node-types/load-config.js';
import { weaverDetectProvider } from '../src/node-types/detect-provider.js';
import { weaverResolveTarget } from '../src/node-types/resolve-target.js';
import { weaverSendNotify } from '../src/node-types/send-notify.js';
import { weaverReport } from '../src/node-types/report.js';
import type { WeaverEnv, WeaverContext } from '../src/bot/types.js';

describe('weaverLoadConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns defaults when no .weaver.json exists', () => {
    const result = weaverLoadConfig(tmpDir);
    expect(result.projectDir).toBe(tmpDir);
    expect(result.config.provider).toBe('auto');
  });

  it('loads config from .weaver.json', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.weaver.json'),
      JSON.stringify({ provider: 'anthropic', target: 'my-workflow.ts' }),
    );
    const result = weaverLoadConfig(tmpDir);
    expect(result.config.provider).toBe('anthropic');
    expect(result.config.target).toBe('my-workflow.ts');
  });

  it('merges config with defaults', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.weaver.json'),
      JSON.stringify({ target: 'test.ts' }),
    );
    const result = weaverLoadConfig(tmpDir);
    expect(result.config.provider).toBe('auto');
    expect(result.config.target).toBe('test.ts');
  });

  it('defaults projectDir to cwd when not provided', () => {
    const result = weaverLoadConfig();
    expect(result.projectDir).toBe(process.cwd());
  });

  it('throws SyntaxError when .weaver.json contains invalid JSON', () => {
    fs.writeFileSync(path.join(tmpDir, '.weaver.json'), '{not valid}');
    expect(() => weaverLoadConfig(tmpDir)).toThrow(SyntaxError);
  });
});

describe('weaverDetectProvider', () => {
  const baseConfig = { provider: 'auto' as const };

  it('detects anthropic when ANTHROPIC_API_KEY is set', () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key-123';
    try {
      const result = weaverDetectProvider('/tmp', baseConfig);
      expect(result.env.providerType).toBe('anthropic');
      expect(result.env.providerInfo.type).toBe('anthropic');
      expect(result.env.providerInfo.apiKey).toBe('test-key-123');
      expect(result.env.providerInfo.model).toBe('claude-sonnet-4-6');
    } finally {
      if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  it('uses explicit provider from config', () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'key';
    try {
      const result = weaverDetectProvider('/tmp', { provider: 'anthropic' });
      expect(result.env.providerType).toBe('anthropic');
    } finally {
      if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  it('uses object provider config', () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'key';
    try {
      const result = weaverDetectProvider('/tmp', {
        provider: { name: 'anthropic', model: 'claude-opus-4-6', maxTokens: 8192 },
      });
      expect(result.env.providerType).toBe('anthropic');
      expect(result.env.providerInfo.model).toBe('claude-opus-4-6');
      expect(result.env.providerInfo.maxTokens).toBe(8192);
    } finally {
      if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  it('throws when anthropic provider has no API key', () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => weaverDetectProvider('/tmp', { provider: 'anthropic' })).toThrow('ANTHROPIC_API_KEY is not set');
    } finally {
      if (origKey !== undefined) process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  it('assembles env with projectDir and config', () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'key';
    try {
      const result = weaverDetectProvider('/my/dir', baseConfig);
      expect(result.env.projectDir).toBe('/my/dir');
      expect(result.env.config).toEqual(baseConfig);
    } finally {
      if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  describe('auto-detection fallback branches', () => {
    let origKey: string | undefined;

    beforeEach(() => {
      vi.clearAllMocks();
      origKey = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
    });

    afterEach(() => {
      if (origKey !== undefined) process.env.ANTHROPIC_API_KEY = origKey;
      delete (globalThis as any).__fw_llm_provider__;
    });

    it('platform provider — __fw_llm_provider__ truthy → type is "platform"', () => {
      (globalThis as any).__fw_llm_provider__ = 'fake-platform';
      const result = weaverDetectProvider('/tmp', { provider: 'auto' });
      expect(result.env.providerType).toBe('platform');
      expect(result.env.providerInfo.type).toBe('platform');
    });

    it('claude-cli — whichSafe("claude") returns non-empty path → type is "claude-cli"', () => {
      mockExecFileSync.mockReturnValueOnce('/usr/local/bin/claude\n');
      const result = weaverDetectProvider('/tmp', { provider: 'auto' });
      expect(result.env.providerType).toBe('claude-cli');
      expect(result.env.providerInfo.type).toBe('claude-cli');
    });

    it('copilot-cli — no claude, whichSafe("copilot") returns non-empty path → type is "copilot-cli"', () => {
      mockExecFileSync.mockReturnValueOnce('').mockReturnValueOnce('/usr/local/bin/copilot\n');
      const result = weaverDetectProvider('/tmp', { provider: 'auto' });
      expect(result.env.providerType).toBe('copilot-cli');
      expect(result.env.providerInfo.type).toBe('copilot-cli');
    });

    it('no provider found — both which commands return "" → throws "No AI provider found"', () => {
      mockExecFileSync.mockReturnValue('');
      expect(() => weaverDetectProvider('/tmp', { provider: 'auto' })).toThrow('No AI provider found');
    });
  });
});

describe('weaverResolveTarget', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeEnv(config = {}): WeaverEnv {
    return {
      projectDir: tmpDir,
      config: { provider: 'auto', ...config },
      providerType: 'anthropic',
      providerInfo: { type: 'anthropic' },
    };
  }

  it('resolves explicit target from config', () => {
    const wfPath = path.join(tmpDir, 'my-workflow.ts');
    fs.writeFileSync(wfPath, '// workflow');
    const result = weaverResolveTarget(makeEnv({ target: 'my-workflow.ts' }));
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    expect(ctx.targetPath).toBe(wfPath);
  });

  it('throws when explicit target not found', () => {
    expect(() => weaverResolveTarget(makeEnv({ target: 'nonexistent.ts' }))).toThrow(
      'Target workflow not found',
    );
  });

  it('auto-scans for workflow files', () => {
    const wfPath = path.join(tmpDir, 'test.ts');
    fs.writeFileSync(wfPath, '/** @flowWeaver workflow */\nexport function test() {}');
    const result = weaverResolveTarget(makeEnv());
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    expect(ctx.targetPath).toBe(wfPath);
  });

  it('throws when no workflows found', () => {
    expect(() => weaverResolveTarget(makeEnv())).toThrow(
      'No workflow files found',
    );
  });

  it('throws when multiple workflows found', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), '/** @flowWeaver workflow */');
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), '/** @flowWeaver workflow */');
    expect(() => weaverResolveTarget(makeEnv())).toThrow(
      'Multiple workflows found',
    );
  });

  it('includes env in context', () => {
    const wfPath = path.join(tmpDir, 'w.ts');
    fs.writeFileSync(wfPath, '// file');
    const env = makeEnv({ target: 'w.ts' });
    const result = weaverResolveTarget(env);
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    expect(ctx.env).toEqual(env);
  });

  it('resolves absolute target path from config', () => {
    const wfPath = path.join(tmpDir, 'absolute-workflow.ts');
    fs.writeFileSync(wfPath, '// workflow');
    // Pass the absolute path directly as config.target
    const result = weaverResolveTarget(makeEnv({ target: wfPath }));
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    expect(ctx.targetPath).toBe(wfPath);
  });

  it('falls back to single workflow found in subdirectory', () => {
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir);
    const wfPath = path.join(srcDir, 'pipeline.ts');
    fs.writeFileSync(wfPath, '/** @flowWeaver workflow */\nexport function pipeline() {}');
    const result = weaverResolveTarget(makeEnv());
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    expect(ctx.targetPath).toBe(wfPath);
  });
});

describe('weaverSendNotify', () => {
  function makeCtx(config = {}, extra = {}): string {
    const ctx: WeaverContext = {
      env: {
        projectDir: '/proj',
        config: { provider: 'auto', ...config },
        providerType: 'anthropic',
        providerInfo: { type: 'anthropic' },
      },
      targetPath: '/proj/wf.ts',
      resultJson: JSON.stringify({ success: true, outcome: 'completed' }),
      ...extra,
    };
    return JSON.stringify(ctx);
  }

  it('returns pass-through values when no notify config', () => {
    const result = weaverSendNotify(makeCtx());
    const ctx = JSON.parse(result.ctx) as WeaverContext;
    expect(ctx.env.projectDir).toBe('/proj');
    expect(ctx.resultJson).toBe(JSON.stringify({ success: true, outcome: 'completed' }));
  });

  it('handles notify as array', () => {
    const ctx = makeCtx({
      notify: [{ channel: 'webhook', url: 'http://localhost:9999/hook', events: ['error'] }],
    });
    const result = weaverSendNotify(ctx);
    const parsed = JSON.parse(result.ctx) as WeaverContext;
    expect(parsed.env.projectDir).toBe('/proj');
  });

  describe('webhook failure logging', () => {
    let consoleError: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      // Restore any previously stacked spies and ensure clean env state
      vi.restoreAllMocks();
      delete process.env.WEAVER_VERBOSE;
      consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      delete process.env.WEAVER_VERBOSE;
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it('logs to console.error when fetch fails and WEAVER_VERBOSE is set', async () => {
      process.env.WEAVER_VERBOSE = '1';
      const fetchError = new Error('network unreachable');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchError));

      weaverSendNotify(makeCtx({
        notify: [{ channel: 'webhook', url: 'http://localhost:9999/hook', events: ['workflow-complete'] }],
      }));

      // Flush the microtask queue so the .catch() handler executes
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(consoleError).toHaveBeenCalledWith(
        '[send-notify] webhook failed:',
        fetchError,
      );
    });

    it('does not log to console.error when fetch fails and WEAVER_VERBOSE is not set', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unreachable')));

      weaverSendNotify(makeCtx({
        notify: [{ channel: 'webhook', url: 'http://localhost:9999/hook', events: ['workflow-complete'] }],
      }));

      await new Promise(resolve => setTimeout(resolve, 0));

      expect(consoleError).not.toHaveBeenCalled();
    });
  });

  // ── payload shapes and event filtering ────────────────────────────────────────

  describe('payload shapes and event filtering', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      vi.restoreAllMocks();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    // ── discord ──────────────────────────────────────────────────────────────────

    it('discord channel: embed color is green (0x22c55e) on success', () => {
      weaverSendNotify(makeCtx(
        { notify: [{ channel: 'discord', url: 'https://discord.com/webhook' }] },
        { resultJson: JSON.stringify({ success: true, outcome: 'completed', summary: 'done' }) },
      ));

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, init] = mockFetch.mock.calls[0] as [string, { body: string }];
      const body = JSON.parse(init.body);
      expect(body.embeds[0].color).toBe(0x22c55e);
    });

    it('discord channel: embed color is red (0xef4444) on failure', () => {
      weaverSendNotify(makeCtx(
        { notify: [{ channel: 'discord', url: 'https://discord.com/webhook' }] },
        { resultJson: JSON.stringify({ success: false, outcome: 'failed', summary: 'broke' }) },
      ));

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, init] = mockFetch.mock.calls[0] as [string, { body: string }];
      const body = JSON.parse(init.body);
      expect(body.embeds[0].color).toBe(0xef4444);
    });

    // ── slack ─────────────────────────────────────────────────────────────────────

    it('slack channel: blocks header contains checkmark emoji on success', () => {
      weaverSendNotify(makeCtx(
        { notify: [{ channel: 'slack', url: 'https://hooks.slack.com/t/webhook' }] },
        { resultJson: JSON.stringify({ success: true, outcome: 'completed', summary: 'done' }) },
      ));

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, init] = mockFetch.mock.calls[0] as [string, { body: string }];
      const body = JSON.parse(init.body);
      expect(body.blocks[0].text.text).toContain(':white_check_mark:');
    });

    // ── generic webhook ───────────────────────────────────────────────────────────

    it('generic webhook: sends raw event JSON (no embeds or blocks)', () => {
      weaverSendNotify(makeCtx(
        { notify: [{ channel: 'webhook', url: 'https://example.com/hook' }] },
        { resultJson: JSON.stringify({ success: true, outcome: 'completed' }) },
      ));

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, init] = mockFetch.mock.calls[0] as [string, { body: string }];
      const body = JSON.parse(init.body);
      expect(body.success).toBe(true);
      expect(body.outcome).toBe('completed');
      expect(body.embeds).toBeUndefined();
      expect(body.blocks).toBeUndefined();
    });

    // ── events filter ─────────────────────────────────────────────────────────────

    it('events filter: webhook skipped when result type not in channel.events', () => {
      // success=false → eventType='error', not in ['workflow-complete'] → skipped
      weaverSendNotify(makeCtx(
        { notify: [{ channel: 'webhook', url: 'https://example.com/hook', events: ['workflow-complete'] }] },
        { resultJson: JSON.stringify({ success: false, outcome: 'failed' }) },
      ));

      expect(mockFetch).not.toHaveBeenCalled();
    });

    // ── multiple channels ─────────────────────────────────────────────────────────

    it('multiple notify channels: fetch called once per matching channel', () => {
      weaverSendNotify(makeCtx(
        {
          notify: [
            { channel: 'webhook', url: 'https://example.com/hook1' },
            { channel: 'webhook', url: 'https://example.com/hook2' },
          ],
        },
        { resultJson: JSON.stringify({ success: true, outcome: 'completed' }) },
      ));

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const calledUrls = mockFetch.mock.calls.map(([url]: [string]) => url);
      expect(calledUrls).toContain('https://example.com/hook1');
      expect(calledUrls).toContain('https://example.com/hook2');
    });
  });
});

describe('weaverReport', () => {
  function makeCtx(targetPath: string, resultJson: string | undefined, extra: Partial<WeaverContext> = {}): string {
    const ctx: WeaverContext = {
      env: {
        projectDir: '/project',
        config: { provider: 'auto' },
        providerType: 'anthropic',
        providerInfo: { type: 'anthropic' },
      },
      targetPath,
      resultJson,
      ...extra,
    };
    return JSON.stringify(ctx);
  }

  it('formats summary with relative path', () => {
    const resultJson = JSON.stringify({
      outcome: 'completed',
      summary: 'All good',
      executionTime: 2.5,
    });
    const result = weaverReport(makeCtx('/project/src/workflow.ts', resultJson));
    expect(result.summary).toContain('src/workflow.ts');
    expect(result.summary).toContain('completed');
    expect(result.summary).toContain('All good');
    expect(result.summary).toContain('2.5s');
  });

  it('handles result without executionTime', () => {
    const resultJson = JSON.stringify({
      outcome: 'failed',
      summary: 'Something broke',
    });
    const result = weaverReport(makeCtx('/project/wf.ts', resultJson));
    expect(result.summary).toContain('failed');
    expect(result.summary).not.toContain('Time:');
  });

  it('throws when resultJson is absent from context', () => {
    expect(() => weaverReport(makeCtx('/project/wf.ts', undefined))).toThrow();
  });

  it('produces correct summary when gitResultJson is present in context', () => {
    const resultJson = JSON.stringify({ outcome: 'committed', summary: 'Changes committed' });
    const gitResultJson = JSON.stringify({ committed: true, sha: 'abc123', message: 'weaver: auto-commit' });
    const result = weaverReport(makeCtx('/project/wf.ts', resultJson, { gitResultJson }));
    expect(result.summary).toContain('committed');
    expect(result.summary).toContain('Changes committed');
    // gitResultJson is not reflected in the summary (not part of weaverReport's output)
    expect(result.summary).not.toContain('abc123');
  });
});
