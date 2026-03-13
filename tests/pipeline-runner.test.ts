import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PipelineRunner } from '../src/bot/pipeline-runner.js';
import type { PipelineConfig } from '../src/bot/types.js';

function makeConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    version: 1,
    name: 'test-pipeline',
    stages: [],
    ...overrides,
  };
}

describe('PipelineRunner.load', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads and parses a valid JSON config', () => {
    const config: PipelineConfig = {
      version: 1,
      name: 'my-pipeline',
      stages: [
        { id: 'build', workflow: '/absolute/path/build.yaml' },
      ],
    };
    const configPath = path.join(tmpDir, 'pipeline.json');
    fs.writeFileSync(configPath, JSON.stringify(config));

    const loaded = PipelineRunner.load(configPath);

    expect(loaded.version).toBe(1);
    expect(loaded.name).toBe('my-pipeline');
    expect(loaded.stages).toHaveLength(1);
    expect(loaded.stages[0].id).toBe('build');
  });

  it('throws for a missing file', () => {
    const missing = path.join(tmpDir, 'does-not-exist.json');

    expect(() => PipelineRunner.load(missing)).toThrow('Pipeline config not found');
  });

  it('throws for invalid JSON', () => {
    const configPath = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(configPath, '{ not valid json!!!');

    expect(() => PipelineRunner.load(configPath)).toThrow('Invalid JSON in pipeline config');
  });

  it('resolves relative workflow paths relative to the config directory', () => {
    const config: PipelineConfig = {
      version: 1,
      name: 'rel-pipeline',
      stages: [
        { id: 'build', workflow: './workflows/build.yaml' },
        { id: 'test', workflow: '../other/test.yaml' },
      ],
    };
    const configPath = path.join(tmpDir, 'pipeline.json');
    fs.writeFileSync(configPath, JSON.stringify(config));

    const loaded = PipelineRunner.load(configPath);

    expect(loaded.stages[0].workflow).toBe(path.resolve(tmpDir, './workflows/build.yaml'));
    expect(loaded.stages[1].workflow).toBe(path.resolve(tmpDir, '../other/test.yaml'));
  });

  it('does not modify absolute workflow paths', () => {
    const absWorkflow = '/some/absolute/path/workflow.yaml';
    const config: PipelineConfig = {
      version: 1,
      name: 'abs-pipeline',
      stages: [
        { id: 'build', workflow: absWorkflow },
      ],
    };
    const configPath = path.join(tmpDir, 'pipeline.json');
    fs.writeFileSync(configPath, JSON.stringify(config));

    const loaded = PipelineRunner.load(configPath);

    expect(loaded.stages[0].workflow).toBe(absWorkflow);
  });

  it('resolves relative paths from a nested config directory', () => {
    const nested = path.join(tmpDir, 'sub', 'dir');
    fs.mkdirSync(nested, { recursive: true });

    const config: PipelineConfig = {
      version: 1,
      name: 'nested',
      stages: [
        { id: 's1', workflow: 'build.yaml' },
      ],
    };
    const configPath = path.join(nested, 'pipeline.json');
    fs.writeFileSync(configPath, JSON.stringify(config));

    const loaded = PipelineRunner.load(configPath);

    expect(loaded.stages[0].workflow).toBe(path.join(nested, 'build.yaml'));
  });
});

describe('PipelineRunner validation (via run)', () => {
  let runner: PipelineRunner;

  beforeEach(() => {
    runner = new PipelineRunner();
  });

  it('throws for empty stages array', async () => {
    const config = makeConfig({ stages: [] });

    await expect(runner.run(config)).rejects.toThrow('Pipeline must have at least one stage');
  });

  it('throws when stages property is undefined', async () => {
    const config = makeConfig();
    // Force undefined stages to test the guard
    (config as any).stages = undefined;

    await expect(runner.run(config)).rejects.toThrow('Pipeline must have at least one stage');
  });

  it('throws for duplicate stage IDs', async () => {
    const config = makeConfig({
      stages: [
        { id: 'build', workflow: '/w/build.yaml' },
        { id: 'build', workflow: '/w/build2.yaml' },
      ],
    });

    await expect(runner.run(config)).rejects.toThrow('Duplicate stage id: "build"');
  });

  it('throws for duplicate IDs among many stages', async () => {
    const config = makeConfig({
      stages: [
        { id: 'a', workflow: '/w/a.yaml' },
        { id: 'b', workflow: '/w/b.yaml' },
        { id: 'c', workflow: '/w/c.yaml' },
        { id: 'b', workflow: '/w/b2.yaml' },
      ],
    });

    await expect(runner.run(config)).rejects.toThrow('Duplicate stage id: "b"');
  });

  it('throws for an unknown dependency', async () => {
    const config = makeConfig({
      stages: [
        { id: 'deploy', workflow: '/w/deploy.yaml', dependsOn: ['build'] },
      ],
    });

    await expect(runner.run(config)).rejects.toThrow(
      'Stage "deploy" depends on unknown stage "build"',
    );
  });

  it('throws for unknown dependency in a multi-stage pipeline', async () => {
    const config = makeConfig({
      stages: [
        { id: 'build', workflow: '/w/build.yaml' },
        { id: 'deploy', workflow: '/w/deploy.yaml', dependsOn: ['build', 'test'] },
      ],
    });

    await expect(runner.run(config)).rejects.toThrow(
      'Stage "deploy" depends on unknown stage "test"',
    );
  });

  it('throws for a simple circular dependency (A -> B -> A)', async () => {
    const config = makeConfig({
      stages: [
        { id: 'a', workflow: '/w/a.yaml', dependsOn: ['b'] },
        { id: 'b', workflow: '/w/b.yaml', dependsOn: ['a'] },
      ],
    });

    await expect(runner.run(config)).rejects.toThrow('Circular dependency detected');
  });

  it('throws for a longer circular dependency chain (A -> B -> C -> A)', async () => {
    const config = makeConfig({
      stages: [
        { id: 'a', workflow: '/w/a.yaml', dependsOn: ['c'] },
        { id: 'b', workflow: '/w/b.yaml', dependsOn: ['a'] },
        { id: 'c', workflow: '/w/c.yaml', dependsOn: ['b'] },
      ],
    });

    await expect(runner.run(config)).rejects.toThrow('Circular dependency detected');
  });

  it('throws for a self-referencing dependency', async () => {
    const config = makeConfig({
      stages: [
        { id: 'loop', workflow: '/w/loop.yaml', dependsOn: ['loop'] },
      ],
    });

    await expect(runner.run(config)).rejects.toThrow('Circular dependency detected');
  });

  it('throws for a cycle in a subset of stages', async () => {
    const config = makeConfig({
      stages: [
        { id: 'root', workflow: '/w/root.yaml' },
        { id: 'x', workflow: '/w/x.yaml', dependsOn: ['root', 'z'] },
        { id: 'y', workflow: '/w/y.yaml', dependsOn: ['x'] },
        { id: 'z', workflow: '/w/z.yaml', dependsOn: ['y'] },
      ],
    });

    await expect(runner.run(config)).rejects.toThrow('Circular dependency detected');
  });

  it('does not throw for a valid DAG', async () => {
    // This should pass validation but will fail at execution (runWorkflow),
    // so we just check that it does NOT throw a validation error.
    const config = makeConfig({
      stages: [
        { id: 'build', workflow: '/w/build.yaml' },
        { id: 'test', workflow: '/w/test.yaml', dependsOn: ['build'] },
        { id: 'deploy', workflow: '/w/deploy.yaml', dependsOn: ['test'] },
      ],
    });

    // Validation passes; execution may fail for other reasons (no actual workflow files).
    // We check that the specific validation errors are NOT thrown.
    try {
      await runner.run(config);
    } catch (err: any) {
      // If it throws, it must NOT be a validation error
      expect(err.message).not.toMatch(/Pipeline must have at least one stage/);
      expect(err.message).not.toMatch(/Duplicate stage id/);
      expect(err.message).not.toMatch(/depends on unknown stage/);
      expect(err.message).not.toMatch(/Circular dependency detected/);
    }
  });

  it('does not throw for diamond-shaped dependencies', async () => {
    const config = makeConfig({
      stages: [
        { id: 'a', workflow: '/w/a.yaml' },
        { id: 'b', workflow: '/w/b.yaml', dependsOn: ['a'] },
        { id: 'c', workflow: '/w/c.yaml', dependsOn: ['a'] },
        { id: 'd', workflow: '/w/d.yaml', dependsOn: ['b', 'c'] },
      ],
    });

    try {
      await runner.run(config);
    } catch (err: any) {
      expect(err.message).not.toMatch(/Circular dependency detected/);
      expect(err.message).not.toMatch(/Duplicate stage id/);
      expect(err.message).not.toMatch(/depends on unknown stage/);
    }
  });
});

describe('PipelineRunner single-stage filtering (via run with stage option)', () => {
  let runner: PipelineRunner;

  beforeEach(() => {
    runner = new PipelineRunner();
  });

  it('throws for unknown stage in single-stage mode', async () => {
    const config = makeConfig({
      stages: [
        { id: 'build', workflow: '/w/build.yaml' },
      ],
    });

    // transitiveDeps will throw for unknown stage
    await expect(runner.run(config, { stage: 'nonexistent' })).rejects.toThrow(
      'Unknown stage: "nonexistent"',
    );
  });
});

describe('PipelineRunner.load preserves config fields', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preserves failFast and defaultTimeoutSeconds', () => {
    const config: PipelineConfig = {
      version: 1,
      name: 'full-config',
      stages: [{ id: 's1', workflow: '/w/s1.yaml' }],
      failFast: false,
      defaultTimeoutSeconds: 120,
    };
    const configPath = path.join(tmpDir, 'pipeline.json');
    fs.writeFileSync(configPath, JSON.stringify(config));

    const loaded = PipelineRunner.load(configPath);

    expect(loaded.failFast).toBe(false);
    expect(loaded.defaultTimeoutSeconds).toBe(120);
  });

  it('preserves stage-level fields (condition, params, timeoutSeconds, dependsOn, label)', () => {
    const config: PipelineConfig = {
      version: 1,
      name: 'detailed',
      stages: [
        {
          id: 'build',
          workflow: '/w/build.yaml',
          label: 'Build step',
          params: { env: 'production' },
          timeoutSeconds: 60,
        },
        {
          id: 'notify',
          workflow: '/w/notify.yaml',
          dependsOn: ['build'],
          condition: 'always',
        },
      ],
    };
    const configPath = path.join(tmpDir, 'pipeline.json');
    fs.writeFileSync(configPath, JSON.stringify(config));

    const loaded = PipelineRunner.load(configPath);

    expect(loaded.stages[0].label).toBe('Build step');
    expect(loaded.stages[0].params).toEqual({ env: 'production' });
    expect(loaded.stages[0].timeoutSeconds).toBe(60);
    expect(loaded.stages[1].dependsOn).toEqual(['build']);
    expect(loaded.stages[1].condition).toBe('always');
  });

  it('preserves description field', () => {
    const config: PipelineConfig = {
      version: 1,
      name: 'with-desc',
      description: 'A test pipeline',
      stages: [{ id: 's1', workflow: '/w/s1.yaml' }],
    };
    const configPath = path.join(tmpDir, 'pipeline.json');
    fs.writeFileSync(configPath, JSON.stringify(config));

    const loaded = PipelineRunner.load(configPath);

    expect(loaded.description).toBe('A test pipeline');
  });
});
