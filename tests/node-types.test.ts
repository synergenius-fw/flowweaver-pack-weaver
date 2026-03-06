import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { weaverLoadConfig } from '../src/node-types/load-config.js';
import { weaverDetectProvider } from '../src/node-types/detect-provider.js';
import { weaverResolveTarget } from '../src/node-types/resolve-target.js';
import { weaverSendNotify } from '../src/node-types/send-notify.js';
import { weaverReport } from '../src/node-types/report.js';
import type { WeaverEnv } from '../src/bot/types.js';

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
    expect(result.targetPath).toBe(wfPath);
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
    expect(result.targetPath).toBe(wfPath);
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

  it('passes through env', () => {
    const wfPath = path.join(tmpDir, 'w.ts');
    fs.writeFileSync(wfPath, '// file');
    const env = makeEnv({ target: 'w.ts' });
    const result = weaverResolveTarget(env);
    expect(result.env).toBe(env);
  });
});

describe('weaverSendNotify', () => {
  function makeEnv(config = {}): WeaverEnv {
    return {
      projectDir: '/proj',
      config: { provider: 'auto', ...config },
      providerType: 'anthropic',
      providerInfo: { type: 'anthropic' },
    };
  }

  it('returns pass-through values when no notify config', () => {
    const resultJson = JSON.stringify({ success: true, outcome: 'completed' });
    const result = weaverSendNotify(makeEnv(), resultJson);
    expect(result.env.projectDir).toBe('/proj');
    expect(result.resultJson).toBe(resultJson);
  });

  it('handles notify as array', () => {
    const env = makeEnv({
      notify: [{ channel: 'webhook', url: 'http://localhost:9999/hook', events: ['error'] }],
    });
    const resultJson = JSON.stringify({ success: true, outcome: 'completed' });
    // Should not send (event is workflow-complete, not error)
    const result = weaverSendNotify(env, resultJson);
    expect(result.env.projectDir).toBe('/proj');
  });
});

describe('weaverReport', () => {
  function makeEnv(): WeaverEnv {
    return {
      projectDir: '/project',
      config: { provider: 'auto' },
      providerType: 'anthropic',
      providerInfo: { type: 'anthropic' },
    };
  }

  it('formats summary with relative path', () => {
    const resultJson = JSON.stringify({
      outcome: 'completed',
      summary: 'All good',
      executionTime: 2.5,
    });
    const result = weaverReport(makeEnv(), '/project/src/workflow.ts', resultJson);
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
    const result = weaverReport(makeEnv(), '/project/wf.ts', resultJson);
    expect(result.summary).toContain('failed');
    expect(result.summary).not.toContain('Time:');
  });
});
