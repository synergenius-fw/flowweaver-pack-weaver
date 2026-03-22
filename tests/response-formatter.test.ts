import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  highlightCodeBlocks,
  linkifyPaths,
  formatResponse,
} from '../src/bot/response-formatter.js';

// ANSI codes from ansi.ts
const ESC = '\x1b';
const cyan = (s: string) => `${ESC}[36m${s}${ESC}[0m`;
const dim = (s: string) => `${ESC}[2m${s}${ESC}[0m`;

describe('highlightCodeBlocks', () => {
  it('wraps code in dim ANSI', () => {
    const input = '```\nhello\n```';
    const result = highlightCodeBlocks(input);
    expect(result).toContain(dim('hello\n'));
  });

  it('shows language tag in cyan', () => {
    const input = '```typescript\nconst x = 1;\n```';
    const result = highlightCodeBlocks(input);
    expect(result).toContain(cyan('[typescript]'));
    expect(result).toContain(dim('const x = 1;\n'));
  });

  it('handles no language tag', () => {
    const input = '```\nplain code\n```';
    const result = highlightCodeBlocks(input);
    // No cyan language tag header
    expect(result).not.toContain(cyan('['));
    expect(result).toContain(dim('plain code\n'));
  });

  it('handles multiple code blocks', () => {
    const input = 'before\n```js\nalpha\n```\nmiddle\n```py\nbeta\n```\nafter';
    const result = highlightCodeBlocks(input);
    expect(result).toContain(cyan('[js]'));
    expect(result).toContain(cyan('[py]'));
    expect(result).toContain(dim('alpha\n'));
    expect(result).toContain(dim('beta\n'));
    expect(result).toContain('before');
    expect(result).toContain('middle');
    expect(result).toContain('after');
  });

  it('does not modify text without code blocks', () => {
    const input = 'Just some regular text with no fences.';
    expect(highlightCodeBlocks(input)).toBe(input);
  });

  it('does not modify inline backticks', () => {
    const input = 'Use `console.log` for debugging.';
    expect(highlightCodeBlocks(input)).toBe(input);
  });
});

describe('linkifyPaths', () => {
  const cwd = '/projects/my-app';

  // Save and restore env
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    origEnv.TERM_PROGRAM = process.env.TERM_PROGRAM;
    origEnv.TERM_PROGRAM_VERSION = process.env.TERM_PROGRAM_VERSION;
  });

  afterEach(() => {
    if (origEnv.TERM_PROGRAM !== undefined) {
      process.env.TERM_PROGRAM = origEnv.TERM_PROGRAM;
    } else {
      delete process.env.TERM_PROGRAM;
    }
    if (origEnv.TERM_PROGRAM_VERSION !== undefined) {
      process.env.TERM_PROGRAM_VERSION = origEnv.TERM_PROGRAM_VERSION;
    } else {
      delete process.env.TERM_PROGRAM_VERSION;
    }
  });

  function enableHyperlinks() {
    process.env.TERM_PROGRAM = 'iTerm.app';
  }

  function disableHyperlinks() {
    delete process.env.TERM_PROGRAM;
    delete process.env.TERM_PROGRAM_VERSION;
  }

  it('creates OSC 8 links for file paths when supported', () => {
    enableHyperlinks();
    const text = 'Check src/index.ts for details';
    const result = linkifyPaths(text, cwd);
    expect(result).toContain('\x1b]8;;file:///projects/my-app/src/index.ts\x07');
    expect(result).toContain('src/index.ts');
    expect(result).toContain('\x1b]8;;\x07');
  });

  it('handles src/ paths', () => {
    enableHyperlinks();
    const text = 'Edit src/utils/helper.ts now';
    const result = linkifyPaths(text, cwd);
    expect(result).toContain('file:///projects/my-app/src/utils/helper.ts');
  });

  it('handles tests/ paths', () => {
    enableHyperlinks();
    const text = 'Run tests/unit/foo.test.ts';
    const result = linkifyPaths(text, cwd);
    expect(result).toContain('file:///projects/my-app/tests/unit/foo.test.ts');
  });

  it('handles lib/ paths', () => {
    enableHyperlinks();
    const text = 'See lib/core.js';
    const result = linkifyPaths(text, cwd);
    expect(result).toContain('file:///projects/my-app/lib/core.js');
  });

  it('handles .json and .md files', () => {
    enableHyperlinks();
    const text = 'Check src/config.json and src/README.md';
    const result = linkifyPaths(text, cwd);
    expect(result).toContain('file:///projects/my-app/src/config.json');
    expect(result).toContain('file:///projects/my-app/src/README.md');
  });

  it('does not link non-file text', () => {
    enableHyperlinks();
    const text = 'This is just regular text without file paths.';
    const result = linkifyPaths(text, cwd);
    expect(result).toBe(text);
  });

  it('does not link paths not starting with known prefixes', () => {
    enableHyperlinks();
    const text = 'Check foo/bar.ts or random/file.js';
    const result = linkifyPaths(text, cwd);
    expect(result).toBe(text);
  });

  it('returns unchanged text when terminal does not support hyperlinks', () => {
    disableHyperlinks();
    const text = 'Check src/index.ts for details';
    const result = linkifyPaths(text, cwd);
    expect(result).toBe(text);
  });

  it('supports WezTerm as TERM_PROGRAM', () => {
    process.env.TERM_PROGRAM = 'WezTerm';
    const text = 'See src/app.ts';
    const result = linkifyPaths(text, cwd);
    expect(result).toContain('\x1b]8;;file://');
  });

  it('supports vscode as TERM_PROGRAM', () => {
    process.env.TERM_PROGRAM = 'vscode';
    const text = 'See src/app.ts';
    const result = linkifyPaths(text, cwd);
    expect(result).toContain('\x1b]8;;file://');
  });

  it('supports terminals with TERM_PROGRAM_VERSION set and known TERM_PROGRAM', () => {
    process.env.TERM_PROGRAM = 'Hyper';
    process.env.TERM_PROGRAM_VERSION = '3.0.0';
    const text = 'See src/app.ts';
    const result = linkifyPaths(text, cwd);
    expect(result).toContain('\x1b]8;;file://');
  });

  it('does NOT enable hyperlinks for Apple_Terminal even with TERM_PROGRAM_VERSION', () => {
    process.env.TERM_PROGRAM = 'Apple_Terminal';
    process.env.TERM_PROGRAM_VERSION = '453';
    const text = 'See src/app.ts';
    const result = linkifyPaths(text, cwd);
    expect(result).toBe(text);
  });

  it('does NOT enable hyperlinks when only TERM_PROGRAM_VERSION is set (unknown terminal)', () => {
    delete process.env.TERM_PROGRAM;
    process.env.TERM_PROGRAM_VERSION = '1.2.3';
    const text = 'See src/app.ts';
    const result = linkifyPaths(text, cwd);
    expect(result).toBe(text);
  });
});

describe('formatResponse', () => {
  const cwd = '/projects/my-app';

  beforeEach(() => {
    process.env.TERM_PROGRAM = 'iTerm.app';
  });

  afterEach(() => {
    delete process.env.TERM_PROGRAM;
  });

  it('applies both highlightCodeBlocks and linkifyPaths', () => {
    const input = 'See ```js\nconst a = 1;\n```\nFile at src/index.ts';
    const result = formatResponse(input, cwd);
    // Code blocks formatted
    expect(result).toContain(cyan('[js]'));
    expect(result).toContain(dim('const a = 1;\n'));
    // Paths linkified
    expect(result).toContain('file:///projects/my-app/src/index.ts');
  });

  it('handles text with no code blocks and no paths', () => {
    const input = 'Just plain text';
    const result = formatResponse(input, cwd);
    expect(result).toBe(input);
  });

  it('handles text with only code blocks', () => {
    const input = '```ts\nlet x = 1;\n```';
    const result = formatResponse(input, cwd);
    expect(result).toContain(cyan('[ts]'));
    expect(result).toContain(dim('let x = 1;\n'));
  });

  it('handles text with only paths', () => {
    const input = 'Edit src/main.ts please';
    const result = formatResponse(input, cwd);
    expect(result).toContain('file:///projects/my-app/src/main.ts');
  });
});
