/**
 * Update Checker — checks npm registry for newer versions of installed packs.
 * Results are cached for 24 hours to avoid spamming the registry.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { safeJsonParse } from './safe-json.js';

export interface UpdateInfo {
  packageName: string;
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_DIR = path.join(os.homedir(), '.weaver');
const CACHE_FILE = path.join(CACHE_DIR, 'update-cache.json');

interface CacheEntry {
  checkedAt: number;
  updates: UpdateInfo[];
}

function readCache(): CacheEntry | null {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const text = fs.readFileSync(CACHE_FILE, 'utf-8');
    const parsed = safeJsonParse<CacheEntry>(text, 'update-cache');
    if (!parsed.ok) {
      console.error(`[weaver] ${parsed.error}`);
      return null;
    }
    if (Date.now() - parsed.value.checkedAt < CACHE_TTL_MS) return parsed.value;
    return null; // stale
  } catch {
    return null;
  }
}

function writeCache(entry: CacheEntry): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(entry, null, 2), 'utf-8');
  } catch { /* non-fatal */ }
}

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function fetchLatestVersion(packageName: string): Promise<string | null> {
  try {
    const encoded = packageName.replace('/', '%2f');
    const resp = await fetch(`https://registry.npmjs.org/${encoded}/latest`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { version?: string };
    return data.version ?? null;
  } catch {
    return null; // network error, timeout, etc.
  }
}

/**
 * Check for updates on installed packs. Returns cached result if fresh.
 * Checks: the weaver pack itself, and any flow-weaver-pack-* in node_modules.
 */
export async function checkForUpdates(projectDir: string): Promise<UpdateInfo[]> {
  // Return cached if fresh
  const cached = readCache();
  if (cached) return cached.updates;

  const updates: UpdateInfo[] = [];

  // Check the weaver pack itself
  try {
    const packPkgPath = path.resolve(projectDir, 'node_modules', '@synergenius', 'flow-weaver-pack-weaver', 'package.json');
    if (fs.existsSync(packPkgPath)) {
      const text = fs.readFileSync(packPkgPath, 'utf-8');
      const parsed = safeJsonParse<{ name: string; version: string }>(text, 'pack-weaver package.json');
      if (!parsed.ok) {
        console.error(`[weaver] ${parsed.error}`);
      } else {
        const pkg = parsed.value;
        const current = pkg.version;
        const latest = await fetchLatestVersion(pkg.name);
        if (latest && compareVersions(latest, current) > 0) {
          updates.push({ packageName: pkg.name, currentVersion: current, latestVersion: latest, updateAvailable: true });
        } else if (latest) {
          updates.push({ packageName: pkg.name, currentVersion: current, latestVersion: latest, updateAvailable: false });
        }
      }
    }
  } catch { /* not installed or unreadable */ }

  // Check flow-weaver core
  try {
    const corePkgPath = path.resolve(projectDir, 'node_modules', '@synergenius', 'flow-weaver', 'package.json');
    if (fs.existsSync(corePkgPath)) {
      const text = fs.readFileSync(corePkgPath, 'utf-8');
      const parsed = safeJsonParse<{ name: string; version: string }>(text, 'flow-weaver package.json');
      if (!parsed.ok) {
        console.error(`[weaver] ${parsed.error}`);
      } else {
        const pkg = parsed.value;
        const current = pkg.version;
        const latest = await fetchLatestVersion(pkg.name);
        if (latest && compareVersions(latest, current) > 0) {
          updates.push({ packageName: pkg.name, currentVersion: current, latestVersion: latest, updateAvailable: true });
        }
      }
    }
  } catch { /* not installed */ }

  // Cache result
  writeCache({ checkedAt: Date.now(), updates });
  return updates;
}

/**
 * Format update info as a brief notification string.
 */
export function formatUpdateNotification(updates: UpdateInfo[]): string | null {
  const available = updates.filter(u => u.updateAvailable);
  if (available.length === 0) return null;
  const lines = available.map(u => `${u.packageName}: ${u.currentVersion} → ${u.latestVersion}`);
  return `Updates available:\n${lines.join('\n')}\nRun: npm update`;
}
