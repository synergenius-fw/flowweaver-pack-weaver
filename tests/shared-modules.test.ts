import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('tool-registry', () => {
  it('exports ALL_TOOLS with 36 tools', async () => {
    const { ALL_TOOLS } = await import('../src/bot/tool-registry.js');
    expect(ALL_TOOLS.length).toBe(41);
  });

  it('BOT_TOOLS contains only tools with bot context', async () => {
    const { ALL_TOOLS, BOT_TOOLS } = await import('../src/bot/tool-registry.js');
    const expected = ALL_TOOLS.filter(t => t.contexts.includes('bot'));
    expect(BOT_TOOLS.length).toBe(expected.length);
    expect(BOT_TOOLS.length).toBe(12);
  });

  it('ASSISTANT_TOOLS contains only tools with assistant context', async () => {
    const { ALL_TOOLS, ASSISTANT_TOOLS } = await import('../src/bot/tool-registry.js');
    const expected = ALL_TOOLS.filter(t => t.contexts.includes('assistant'));
    expect(ASSISTANT_TOOLS.length).toBe(expected.length);
    expect(ASSISTANT_TOOLS.length).toBe(37);
  });

  it('VERBOSE_TOOL_NAMES contains all verboseOutput tools', async () => {
    const { ALL_TOOLS, VERBOSE_TOOL_NAMES } = await import('../src/bot/tool-registry.js');
    const expected = ALL_TOOLS.filter(t => t.verboseOutput).map(t => t.name);
    expect([...VERBOSE_TOOL_NAMES].sort()).toEqual(expected.sort());
    expect(VERBOSE_TOOL_NAMES.has('fw_diagram')).toBe(true);
    expect(VERBOSE_TOOL_NAMES.has('tsc_check')).toBe(true);
    expect(VERBOSE_TOOL_NAMES.has('bot_spawn')).toBe(false);
  });

  it('all tools have valid name, description, and inputSchema', async () => {
    const { ALL_TOOLS } = await import('../src/bot/tool-registry.js');
    for (const tool of ALL_TOOLS) {
      expect(tool.name).toMatch(/^[a-z_]+$/);
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.category).toBeTruthy();
      expect(tool.contexts.length).toBeGreaterThan(0);
    }
  });

  it('shared tools (both bot + assistant) have both contexts', async () => {
    const { ALL_TOOLS } = await import('../src/bot/tool-registry.js');
    const shared = ALL_TOOLS.filter(t => t.contexts.includes('bot') && t.contexts.includes('assistant'));
    const sharedNames = shared.map(t => t.name).sort();
    expect(sharedNames).toContain('read_file');
    expect(sharedNames).toContain('list_files');
    expect(sharedNames).toContain('run_shell');
    expect(sharedNames).toContain('web_fetch');
  });

  it('generateToolPromptSection groups by category', async () => {
    const { generateToolPromptSection } = await import('../src/bot/tool-registry.js');
    const section = generateToolPromptSection();
    expect(section).toContain('bot-management:');
    expect(section).toContain('queue:');
    expect(section).toContain('flow-weaver:');
    expect(section).toContain('project:');
  });

  it('generateVerboseToolList returns comma-separated names', async () => {
    const { generateVerboseToolList } = await import('../src/bot/tool-registry.js');
    const list = generateVerboseToolList();
    expect(list).toContain('fw_diagram');
    expect(list).toContain('tsc_check');
    expect(list).not.toContain('bot_spawn');
  });
});

describe('ansi', () => {
  it('exports color functions that wrap text with ANSI codes', async () => {
    const { c } = await import('../src/bot/ansi.js');
    expect(c.green('ok')).toBe('\x1b[32mok\x1b[0m');
    expect(c.red('err')).toBe('\x1b[31merr\x1b[0m');
    expect(c.cyan('info')).toBe('\x1b[36minfo\x1b[0m');
    expect(c.dim('faint')).toBe('\x1b[2mfaint\x1b[0m');
    expect(c.bold('strong')).toBe('\x1b[1mstrong\x1b[0m');
    expect(c.yellow('warn')).toBe('\x1b[33mwarn\x1b[0m');
    expect(c.redBold('critical')).toBe('\x1b[1;31mcritical\x1b[0m');
  });
});

describe('paths', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('resolveWeaverDir returns explicit dir when provided', async () => {
    const { resolveWeaverDir } = await import('../src/bot/paths.js');
    expect(resolveWeaverDir('/custom/dir')).toBe('/custom/dir');
  });

  it('resolveWeaverDir falls back to ~/.weaver when no env vars set', async () => {
    delete process.env.WEAVER_QUEUE_DIR;
    delete process.env.WEAVER_STEERING_DIR;
    delete process.env.WEAVER_PROJECT_DIR;
    vi.resetModules();
    const { resolveWeaverDir } = await import('../src/bot/paths.js');
    expect(resolveWeaverDir()).toBe(path.join(os.homedir(), '.weaver'));
  });

  it('hashDir returns 8-char hex string', async () => {
    const { hashDir } = await import('../src/bot/paths.js');
    const hash = hashDir('/some/project');
    expect(hash).toHaveLength(8);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('hashDir is deterministic', async () => {
    const { hashDir } = await import('../src/bot/paths.js');
    expect(hashDir('/same/path')).toBe(hashDir('/same/path'));
    expect(hashDir('/different')).not.toBe(hashDir('/same/path'));
  });
});

describe('safety', () => {
  it('isBlockedCommand detects dangerous commands', async () => {
    const { isBlockedCommand } = await import('../src/bot/safety.js');
    expect(isBlockedCommand('rm -rf /')).toBeTruthy();
    expect(isBlockedCommand('git push origin main')).toBeTruthy();
    expect(isBlockedCommand('npm publish')).toBeTruthy();
    expect(isBlockedCommand('sudo apt install')).toBeTruthy();
    expect(isBlockedCommand('echo hello')).toBe(false);
    expect(isBlockedCommand('npx vitest run')).toBe(false);
  });

  it('isBlockedUrl blocks localhost and internal IPs', async () => {
    const { isBlockedUrl } = await import('../src/bot/safety.js');
    expect(isBlockedUrl('http://localhost:3000')).toBe(true);
    expect(isBlockedUrl('http://127.0.0.1/api')).toBe(true);
    expect(isBlockedUrl('http://192.168.1.1')).toBe(true);
    expect(isBlockedUrl('http://10.0.0.1')).toBe(true);
    expect(isBlockedUrl('https://api.example.com')).toBe(false);
    expect(isBlockedUrl('https://npmjs.com')).toBe(false);
  });

  it('exports constants', async () => {
    const { CHARS_PER_TOKEN, MAX_READ_SIZE, BLOCKED_SHELL_PATTERNS } = await import('../src/bot/safety.js');
    expect(CHARS_PER_TOKEN).toBe(4);
    expect(MAX_READ_SIZE).toBe(1_048_576);
    expect(Array.isArray(BLOCKED_SHELL_PATTERNS)).toBe(true);
    expect(BLOCKED_SHELL_PATTERNS.length).toBeGreaterThan(10);
  });
});

describe('error-classifier', () => {
  it('classifies transient errors correctly', async () => {
    const { classifyError } = await import('../src/bot/error-classifier.js');

    expect(classifyError(new Error('502 Bad Gateway')).isTransient).toBe(true);
    expect(classifyError(new Error('429 rate limit')).isTransient).toBe(true);
    expect(classifyError(new Error('ETIMEDOUT')).isTransient).toBe(true);
    expect(classifyError(new Error('504 Gateway Timeout')).isTransient).toBe(true);
    expect(classifyError(new Error('exited with code 143')).isTransient).toBe(true);
  });

  it('classifies permanent errors correctly', async () => {
    const { classifyError } = await import('../src/bot/error-classifier.js');

    expect(classifyError(new Error('401 Unauthorized')).isTransient).toBe(false);
    expect(classifyError(new Error('403 Forbidden')).isTransient).toBe(false);
    expect(classifyError(new Error('Failed to parse JSON')).isTransient).toBe(false);
  });

  it('provides guidance for known errors', async () => {
    const { classifyError } = await import('../src/bot/error-classifier.js');

    expect(classifyError(new Error('401 invalid key')).guidance).toContain('API key');
    expect(classifyError(new Error('429 rate limit')).guidance).toContain('Rate limited');
    expect(classifyError(new Error('Queue full')).guidance).toContain('200 max');
  });

  it('returns unknown for unrecognized errors', async () => {
    const { classifyError } = await import('../src/bot/error-classifier.js');
    const result = classifyError(new Error('something random'));
    expect(result.isTransient).toBe(false);
    expect(result.guidance).toBeNull();
    expect(result.category).toBe('unknown');
  });

  it('backward-compatible isTransientError works', async () => {
    const { isTransientError } = await import('../src/bot/error-classifier.js');
    expect(isTransientError(new Error('502'))).toBe(true);
    expect(isTransientError(new Error('401'))).toBe(false);
  });

  it('backward-compatible getErrorGuidance works', async () => {
    const { getErrorGuidance } = await import('../src/bot/error-classifier.js');
    expect(getErrorGuidance('ETIMEDOUT')).toContain('timeout');
    expect(getErrorGuidance('something random')).toBeNull();
  });

  it('withRetry retries on transient errors', async () => {
    const { withRetry } = await import('../src/bot/error-classifier.js');
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts < 3) throw new Error('502 Bad Gateway');
      return 'ok';
    };
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('withRetry does not retry permanent errors', async () => {
    const { withRetry } = await import('../src/bot/error-classifier.js');
    let attempts = 0;
    const fn = async () => {
      attempts++;
      throw new Error('401 Unauthorized');
    };
    await expect(withRetry(fn, { maxRetries: 3, baseDelayMs: 1 })).rejects.toThrow('401');
    expect(attempts).toBe(1);
  });
});
