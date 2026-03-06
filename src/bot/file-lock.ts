import * as fs from 'node:fs';
import * as path from 'node:path';

export interface FileLockOptions {
  retries?: number;
  retryWait?: number;
  staleMs?: number;
}

interface LockInfo {
  pid: number;
  timestamp: number;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function withFileLock<T>(
  lockPath: string,
  fn: () => T | Promise<T>,
  options?: FileLockOptions,
): Promise<T> {
  const retries = options?.retries ?? 50;
  const retryWait = options?.retryWait ?? 50;
  const staleMs = options?.staleMs ?? 10_000;
  const lockDir = lockPath + '.lock';
  const infoFile = path.join(lockDir, 'info.json');

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      fs.mkdirSync(lockDir, { recursive: false });

      fs.writeFileSync(infoFile, JSON.stringify({ pid: process.pid, timestamp: Date.now() }), 'utf-8');

      try {
        return await fn();
      } finally {
        try { fs.rmSync(lockDir, { recursive: true }); } catch { /* ignore */ }
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      // Lock exists, check if stale
      try {
        const raw = fs.readFileSync(infoFile, 'utf-8');
        const info = JSON.parse(raw) as LockInfo;
        const isStale = Date.now() - info.timestamp > staleMs;
        const isDead = !isPidAlive(info.pid);

        if (isStale || isDead) {
          try { fs.rmSync(lockDir, { recursive: true }); } catch { /* ignore */ }
          continue;
        }
      } catch {
        // Can't read lock info, try to clean up
        try { fs.rmSync(lockDir, { recursive: true }); } catch { /* ignore */ }
        continue;
      }

      if (attempt < retries) {
        await new Promise(r => setTimeout(r, retryWait));
      }
    }
  }

  throw new Error(`Failed to acquire file lock after ${retries} retries: ${lockPath}`);
}
