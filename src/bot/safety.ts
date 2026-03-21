/**
 * Shared safety constants and checks — single source of truth.
 *
 * Both step-executor.ts and assistant-tools.ts MUST use these patterns.
 * Do not duplicate blocklists elsewhere.
 */

/** Shell commands that are NEVER allowed (destructive or evasive operations). */
export const BLOCKED_SHELL_PATTERNS: RegExp[] = [
  // Destructive file operations
  /\brm\s+(-[a-z]*r|-[a-z]*f)[a-z]*\s/i,  // rm with -r or -f flags

  // Git remote/destructive operations
  /\bgit\s+push\b/i,              // git push (no remote ops)
  /\bgit\s+reset\s+--hard\b/i,    // git reset --hard

  // Package publishing
  /\bnpm\s+publish\b/i,           // npm publish

  // Remote code execution via download
  /\bcurl\b.*\|\s*(sh|bash)\b/i,  // curl | sh/bash
  /\bwget\b.*\|\s*(sh|bash)\b/i,  // wget | sh/bash

  // Privilege escalation
  /\bsudo\b/i,                    // sudo

  // Dangerous permissions
  /\bchmod\s+777\b/i,             // chmod 777

  // Process killing
  /\bkill\s+-9\b/i,               // kill -9

  // Disk destruction
  /\bmkfs\b/i,                    // format disk
  /\bdd\s+if=/i,                  // dd (disk destroyer)
  />\s*\/dev\/sd/i,               // write to raw disk

  // Pipe-to-interpreter: encoded payload execution
  /\bbase64\b.*\|\s*(sh|bash|zsh)\b/i,  // base64 | bash

  // Inline code execution via interpreters
  /\bnode\s+(-e|--eval)\b/i,           // node -e / node --eval
  /\bpython[23]?\s+-c\b/i,             // python -c / python3 -c
  /\bperl\s+-e\b/i,                    // perl -e
  /\bruby\s+-e\b/i,                    // ruby -e

  // Shell eval (arbitrary code execution)
  /\beval\s+/i,                         // eval ...
];

export const BLOCKED_URL_PATTERN = /localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d|172\.(1[6-9]|2\d|3[01])\.|192\.168\./i;
export const MAX_READ_SIZE = 1_048_576;
export const CHARS_PER_TOKEN = 4;

/**
 * Check if a shell command matches any blocked pattern.
 * Returns the matching pattern source string, or false if safe.
 */
export function isBlockedCommand(cmd: string): string | false {
  for (const pattern of BLOCKED_SHELL_PATTERNS) {
    if (pattern.test(cmd)) {
      return pattern.source;
    }
  }
  return false;
}

export function isBlockedUrl(url: string): boolean {
  return BLOCKED_URL_PATTERN.test(url);
}
