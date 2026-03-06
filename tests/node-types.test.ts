import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { weaverLoadConfig } from '../src/node-types/load-config.js';
import { weaverDetectProvider } from '../src/node-types/detect-provider.js';
import { weaverResolveTarget } from '../src/node-types/resolve-target.js';
import { weaverSendNotify } from '../src/node-types/send-notify.js';
import { weaverReport } from '../src/node-types/report.js';

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
    const config = JSON.parse(result.config);
    expect(config.provider).toBe('auto');
  });

  it('loads config from .weaver.json', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.weaver.json'),
      JSON.stringify({ provider: 'anthropic', target: 'my-workflow.ts' }),
    );
    const result = weaverLoadConfig(tmpDir);
    const config = JSON.parse(result.config);
    expect(config.provider).toBe('anthropic');
    expect(config.target).toBe('my-workflow.ts');
  });

  it('merges config with defaults', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.weaver.json'),
      JSON.stringify({ target: 'test.ts' }),
    );
    const result = weaverLoadConfig(tmpDir);
    const config = JSON.parse(result.config);
    expect(config.provider).toBe('auto');
    expect(config.target).toBe('test.ts');
  });

  it('defaults projectDir to cwd when not provided', () => {
    const result = weaverLoadConfig();
    expect(result.projectDir).toBe(process.cwd());
  });
});

describe('weaverDetectProvider', () => {
  const baseConfig = JSON.stringify({ provider: 'auto' });

  it('detects anthropic when ANTHROPIC_API_KEY is set', () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key-123';
    try {
      const result = weaverDetectProvider('/tmp', baseConfig);
      expect(result.providerType).toBe('anthropic');
      const info = JSON.parse(result.providerInfo);
      expect(info.type).toBe('anthropic');
      expect(info.apiKey).toBe('test-key-123');
      expect(info.model).toBe('claude-sonnet-4-6');
    } finally {
      if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  it('uses explicit provider from config', () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'key';
    try {
      const config = JSON.stringify({ provider: 'anthropic' });
      const result = weaverDetectProvider('/tmp', config);
      expect(result.providerType).toBe('anthropic');
    } finally {
      if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  it('uses object provider config', () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'key';
    try {
      const config = JSON.stringify({
        provider: { name: 'anthropic', model: 'claude-opus-4-6', maxTokens: 8192 },
      });
      const result = weaverDetectProvider('/tmp', config);
      expect(result.providerType).toBe('anthropic');
      const info = JSON.parse(result.providerInfo);
      expect(info.model).toBe('claude-opus-4-6');
      expect(info.maxTokens).toBe(8192);
    } finally {
      if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  it('throws when anthropic provider has no API key', () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const config = JSON.stringify({ provider: 'anthropic' });
      expect(() => weaverDetectProvider('/tmp', config)).toThrow('ANTHROPIC_API_KEY is not set');
    } finally {
      if (origKey !== undefined) process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  it('passes through projectDir and config', () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'key';
    try {
      const result = weaverDetectProvider('/my/dir', baseConfig);
      expect(result.projectDir).toBe('/my/dir');
      expect(result.config).toBe(baseConfig);
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

  it('resolves explicit target from config', () => {
    const wfPath = path.join(tmpDir, 'my-workflow.ts');
    fs.writeFileSync(wfPath, '// workflow');
    const config = JSON.stringify({ target: 'my-workflow.ts' });
    const result = weaverResolveTarget(tmpDir, config, 'anthropic', '{}');
    expect(result.targetPath).toBe(wfPath);
  });

  it('throws when explicit target not found', () => {
    const config = JSON.stringify({ target: 'nonexistent.ts' });
    expect(() => weaverResolveTarget(tmpDir, config, 'anthropic', '{}')).toThrow(
      'Target workflow not found',
    );
  });

  it('auto-scans for workflow files', () => {
    const wfPath = path.join(tmpDir, 'test.ts');
    fs.writeFileSync(wfPath, '/** @flowWeaver workflow */\nexport function test() {}');
    const config = JSON.stringify({});
    const result = weaverResolveTarget(tmpDir, config, 'anthropic', '{}');
    expect(result.targetPath).toBe(wfPath);
  });

  it('throws when no workflows found', () => {
    const config = JSON.stringify({});
    expect(() => weaverResolveTarget(tmpDir, config, 'anthropic', '{}')).toThrow(
      'No workflow files found',
    );
  });

  it('throws when multiple workflows found', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), '/** @flowWeaver workflow */');
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), '/** @flowWeaver workflow */');
    const config = JSON.stringify({});
    expect(() => weaverResolveTarget(tmpDir, config, 'anthropic', '{}')).toThrow(
      'Multiple workflows found',
    );
  });

  it('passes through all inputs', () => {
    const wfPath = path.join(tmpDir, 'w.ts');
    fs.writeFileSync(wfPath, '// file');
    const config = JSON.stringify({ target: 'w.ts' });
    const result = weaverResolveTarget(tmpDir, config, 'myProvider', '{"foo":1}');
    expect(result.projectDir).toBe(tmpDir);
    expect(result.config).toBe(config);
    expect(result.providerType).toBe('myProvider');
    expect(result.providerInfo).toBe('{"foo":1}');
  });
});

describe('weaverSendNotify', () => {
  it('returns pass-through values when no notify config', () => {
    const config = JSON.stringify({});
    const resultJson = JSON.stringify({ success: true, outcome: 'completed' });
    const result = weaverSendNotify('/proj', config, '/proj/wf.ts', resultJson);
    expect(result.projectDir).toBe('/proj');
    expect(result.targetPath).toBe('/proj/wf.ts');
    expect(result.resultJson).toBe(resultJson);
  });

  it('handles notify as array', () => {
    const config = JSON.stringify({
      notify: [{ channel: 'webhook', url: 'http://localhost:9999/hook', events: ['error'] }],
    });
    const resultJson = JSON.stringify({ success: true, outcome: 'completed' });
    // Should not send (event is workflow-complete, not error)
    const result = weaverSendNotify('/proj', config, '/proj/wf.ts', resultJson);
    expect(result.projectDir).toBe('/proj');
  });
});

describe('weaverReport', () => {
  it('formats summary with relative path', () => {
    const resultJson = JSON.stringify({
      outcome: 'completed',
      summary: 'All good',
      executionTime: 2.5,
    });
    const result = weaverReport('/project', '/project/src/workflow.ts', resultJson);
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
    const result = weaverReport('/project', '/project/wf.ts', resultJson);
    expect(result.summary).toContain('failed');
    expect(result.summary).not.toContain('Time:');
  });
});
