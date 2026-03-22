import * as path from 'node:path';
import { c } from './ansi.js';

/**
 * Highlight code blocks in streamed text.
 * Detects ```lang ... ``` patterns and applies dim styling.
 */
export function highlightCodeBlocks(text: string): string {
  return text.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
    const header = lang ? `  ${c.cyan(`[${lang}]`)}\n` : '';
    return `${header}${c.dim(code)}`;
  });
}

/**
 * Make file paths clickable using OSC 8 terminal hyperlinks.
 * Only active when terminal supports it.
 */
export function linkifyPaths(text: string, cwd: string): string {
  if (!supportsHyperlinks()) return text;
  return text.replace(/\b((?:src|tests|lib|dist)\/[\w/.-]+\.(?:ts|js|json|md))\b/g, (match) => {
    const abs = path.resolve(cwd, match);
    return `\x1b]8;;file://${abs}\x07${match}\x1b]8;;\x07`;
  });
}

/**
 * Format a full response — apply all formatting passes.
 */
export function formatResponse(text: string, cwd: string): string {
  let result = text;
  result = highlightCodeBlocks(result);
  result = linkifyPaths(result, cwd);
  return result;
}

function supportsHyperlinks(): boolean {
  const term = process.env.TERM_PROGRAM ?? '';
  // Known terminals that support OSC 8 hyperlinks
  return ['iTerm.app', 'WezTerm', 'vscode', 'Hyper'].includes(term);
}
