import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { withFileLock } from '../src/bot/file-lock.js';

describe('withFileLock', () => {
  let tmpDir: string;
  let lockPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-lock-'));
    lockPath = path.join(tmpDir, 'test-file');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('executes the function and returns the result', async () => {
    const result = await withFileLock(lockPath, () => 42);
    expect(result).toBe(42);
  });

  it('executes async functions', async () => {
    const result = await withFileLock(lockPath, async () => {
      await new Promise(r => setTimeout(r, 10));
      return 'async-result';
    });
    expect(result).toBe('async-result');
  });

  it('releases lock after execution', async () => {
    await withFileLock(lockPath, () => 'done');
    // Lock dir should be cleaned up
    expect(fs.existsSync(lockPath + '.lock')).toBe(false);
  });

  it('releases lock even if function throws', async () => {
    await expect(
      withFileLock(lockPath, () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');
    expect(fs.existsSync(lockPath + '.lock')).toBe(false);
  });

  it('serializes concurrent acquisitions', async () => {
    const order: number[] = [];
    const task = (id: number, delay: number) =>
      withFileLock(lockPath, async () => {
        order.push(id);
        await new Promise(r => setTimeout(r, delay));
      }, { retries: 100, retryWait: 10 });

    await Promise.all([task(1, 50), task(2, 10)]);
    // Both should complete (order may vary, but both must run)
    expect(order).toHaveLength(2);
    expect(order).toContain(1);
    expect(order).toContain(2);
  });

  it('cleans up stale lock with dead PID', async () => {
    const lockDir = lockPath + '.lock';
    fs.mkdirSync(lockDir);
    // PID 999999 almost certainly does not exist
    fs.writeFileSync(path.join(lockDir, 'info.json'), JSON.stringify({ pid: 999999, timestamp: Date.now() }));

    const result = await withFileLock(lockPath, () => 'recovered');
    expect(result).toBe('recovered');
  });

  it('cleans up stale lock by timestamp', async () => {
    const lockDir = lockPath + '.lock';
    fs.mkdirSync(lockDir);
    // Timestamp far in the past
    fs.writeFileSync(path.join(lockDir, 'info.json'), JSON.stringify({ pid: process.pid, timestamp: 1 }));

    const result = await withFileLock(lockPath, () => 'recovered', { staleMs: 1000 });
    expect(result).toBe('recovered');
  });

  it('throws after exhausting retries', async () => {
    const lockDir = lockPath + '.lock';
    fs.mkdirSync(lockDir);
    // Use current PID and fresh timestamp so the lock isn't considered stale
    fs.writeFileSync(path.join(lockDir, 'info.json'), JSON.stringify({ pid: process.pid, timestamp: Date.now() }));

    await expect(
      withFileLock(lockPath, () => 'never', { retries: 2, retryWait: 10, staleMs: 60_000 }),
    ).rejects.toThrow('Failed to acquire file lock after 2 retries');

    // Clean up the lock dir we created manually
    fs.rmSync(lockDir, { recursive: true });
  });
});
