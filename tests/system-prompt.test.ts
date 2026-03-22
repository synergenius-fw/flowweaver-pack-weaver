import { describe, it, expect, vi, beforeEach } from 'vitest';

// We need to test the internal formatting functions. They're not exported directly,
// but we can test them through the exported builders. We also need to test the
// exported buildSystemPrompt and buildBotSystemPrompt.

// Mock the dynamic import for doc-metadata
vi.mock('@synergenius/flow-weaver/doc-metadata', () => ({
  ALL_ANNOTATIONS: [
    { name: 'flowWeaver', syntax: '@flowWeaver <type>', description: 'Declares a block', category: 'Core' },
    { name: 'input', syntax: '@input <name> <type>', description: 'Declares an input port', category: 'Ports' },
    { name: 'output', syntax: '@output <name> <type>', description: 'Declares an output port', category: 'Ports' },
  ],
  PORT_MODIFIERS: [
    { name: 'optional', syntax: '[name]', description: 'Makes port optional' },
  ],
  NODE_MODIFIERS: [
    { name: 'expression', syntax: '@expression', description: 'Pure expression node' },
  ],
  VALIDATION_CODES: [
    { code: 'E001', severity: 'error', title: 'Unknown node', description: 'Node type not found', category: 'Resolution' },
    { code: 'W001', severity: 'warning', title: 'Unused port', description: 'Port has no connections', category: 'Lint' },
  ],
  CLI_COMMANDS: [
    { name: 'validate', description: 'Validate a workflow', botCompatible: true, options: [{ flags: '--json', description: 'JSON output' }] },
    { name: 'compile', description: 'Compile a workflow', group: 'build' },
    { name: 'diagram', description: 'Generate diagram', botCompatible: true, options: [{ flags: '--format', arg: 'fmt', description: 'Output format' }] },
  ],
}));

describe('system-prompt', () => {
  // Reset the module cache before each test so cachedPrompt is cleared
  let buildSystemPrompt: () => Promise<string>;
  let buildBotSystemPrompt: (contextBundle?: string, cliCommands?: any[], projectDir?: string) => string;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/bot/system-prompt.js');
    buildSystemPrompt = mod.buildSystemPrompt;
    buildBotSystemPrompt = mod.buildBotSystemPrompt;
  });

  describe('buildSystemPrompt', () => {
    it('includes annotation categories grouped correctly', async () => {
      const prompt = await buildSystemPrompt();
      // Core and Ports should appear as category headers
      expect(prompt).toContain('[Core]');
      expect(prompt).toContain('[Ports]');
    });

    it('includes annotation syntax and descriptions', async () => {
      const prompt = await buildSystemPrompt();
      expect(prompt).toContain('@flowWeaver <type>  -- Declares a block');
      expect(prompt).toContain('@input <name> <type>  -- Declares an input port');
    });

    it('includes port modifiers', async () => {
      const prompt = await buildSystemPrompt();
      expect(prompt).toContain('Port modifiers (after port name):');
      expect(prompt).toContain('[name]  -- Makes port optional');
    });

    it('includes node modifiers', async () => {
      const prompt = await buildSystemPrompt();
      expect(prompt).toContain('Node instance modifiers (in @node declaration):');
      expect(prompt).toContain('@expression  -- Pure expression node');
    });

    it('includes only error-severity validation codes', async () => {
      const prompt = await buildSystemPrompt();
      // E001 is severity=error, should be included
      expect(prompt).toContain('E001: Unknown node -- Node type not found');
      // W001 is severity=warning, should NOT be included
      expect(prompt).not.toContain('W001');
    });

    it('includes only top-level CLI commands (no group)', async () => {
      const prompt = await buildSystemPrompt();
      // validate has no group, should appear
      expect(prompt).toContain('flow-weaver validate -- Validate a workflow');
      // compile has group="build", should NOT appear
      expect(prompt).not.toContain('flow-weaver compile');
    });

    it('caches the prompt on second call', async () => {
      const first = await buildSystemPrompt();
      const second = await buildSystemPrompt();
      expect(first).toBe(second);
    });

    it('returns a prompt with core structure when metadata import fails', async () => {
      vi.resetModules();
      // Mock the import to fail
      vi.doMock('@synergenius/flow-weaver/doc-metadata', () => {
        throw new Error('Module not found');
      });
      const mod = await import('../src/bot/system-prompt.js');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const prompt = await mod.buildSystemPrompt();
      // Should still return a valid prompt (just with empty sections)
      expect(prompt).toContain('You are Weaver');
      expect(prompt).toContain('Annotation Grammar');
      // Should warn about the failure
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][0]).toMatch(/doc-metadata/i);
      warnSpy.mockRestore();
    });
  });

  describe('buildBotSystemPrompt', () => {
    it('includes safety policy', () => {
      const prompt = buildBotSystemPrompt();
      expect(prompt).toContain('Safety Policy');
      expect(prompt).toContain('Writes that shrink a file by >50%');
    });

    it('includes context bundle when provided', () => {
      const prompt = buildBotSystemPrompt('Project: test-project\nVersion: 1.0');
      expect(prompt).toContain('## Project Context');
      expect(prompt).toContain('Project: test-project');
    });

    it('omits context section when no bundle', () => {
      const prompt = buildBotSystemPrompt();
      expect(prompt).not.toContain('## Project Context');
    });

    it('loads and includes project plan from projectDir', () => {
      const fs = require('node:fs');
      const origExistsSync = fs.existsSync;
      const origReadFileSync = fs.readFileSync;
      // Mock fs to return a plan file
      vi.spyOn(fs, 'existsSync').mockImplementation((p: string) => {
        if (p.endsWith('.weaver-plan.md')) return true;
        return origExistsSync(p);
      });
      vi.spyOn(fs, 'readFileSync').mockImplementation((p: string, enc: string) => {
        if (typeof p === 'string' && p.endsWith('.weaver-plan.md')) return '# My Plan\nDo the thing.';
        return origReadFileSync(p, enc);
      });

      const prompt = buildBotSystemPrompt(undefined, undefined, '/fake/project');
      expect(prompt).toContain('## Project Plan & Vision');
      expect(prompt).toContain('# My Plan');
      expect(prompt).toContain('Do the thing.');

      vi.restoreAllMocks();
    });

    it('omits plan section when projectDir has no plan file', () => {
      const prompt = buildBotSystemPrompt(undefined, undefined, '/nonexistent/dir');
      expect(prompt).not.toContain('## Project Plan & Vision');
    });

    it('logs a warning when plan file read fails', () => {
      const fs = require('node:fs');
      vi.spyOn(fs, 'existsSync').mockImplementation((p: string) => {
        if (typeof p === 'string' && p.endsWith('.weaver-plan.md')) return true;
        return false;
      });
      vi.spyOn(fs, 'readFileSync').mockImplementation((p: string) => {
        if (typeof p === 'string' && p.endsWith('.weaver-plan.md')) throw new Error('EACCES: permission denied');
        throw new Error('unexpected read');
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const prompt = buildBotSystemPrompt(undefined, undefined, '/fake/project');
      // Plan should be missing since read failed
      expect(prompt).not.toContain('## Project Plan & Vision');
      // Should have warned about the failure
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][0]).toMatch(/plan/i);

      warnSpy.mockRestore();
      vi.restoreAllMocks();
    });
  });
});
