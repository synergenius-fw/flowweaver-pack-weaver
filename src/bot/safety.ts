/**
 * Shared safety constants and checks — single source of truth.
 */

export const BLOCKED_COMMANDS = ['rm -rf', 'git push', 'npm publish', 'sudo', 'curl|sh', 'wget|sh'];
export const BLOCKED_URL_PATTERN = /localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d|172\.(1[6-9]|2\d|3[01])\.|192\.168\./i;
export const MAX_READ_SIZE = 1_048_576;
export const CHARS_PER_TOKEN = 4;

export function isBlockedCommand(cmd: string): boolean {
  return BLOCKED_COMMANDS.some(b => cmd.includes(b));
}

export function isBlockedUrl(url: string): boolean {
  return BLOCKED_URL_PATTERN.test(url);
}
