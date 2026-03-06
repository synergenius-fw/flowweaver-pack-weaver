import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { WeaverEnv, GenesisFingerprint } from '../bot/types.js';

/**
 * Fingerprints the project state: hashes .ts files, reads package.json,
 * captures git branch/commit, scans for workflow files, and hashes the
 * target workflow content.
 *
 * @flowWeaver nodeType
 * @label Genesis Observe
 * @input env [order:0] - Weaver environment bundle
 * @input genesisConfigJson [order:1] - Genesis configuration (JSON)
 * @output env [order:0] - Weaver environment bundle (pass-through)
 * @output genesisConfigJson [order:1] - Genesis configuration (pass-through)
 * @output fingerprintJson [order:2] - Project fingerprint (JSON)
 * @output onSuccess [order:-2] - On Success
 * @output onFailure [order:-1] - On Failure
 */
export async function genesisObserve(
  execute: boolean,
  env: WeaverEnv,
  genesisConfigJson: string,
): Promise<{
  onSuccess: boolean; onFailure: boolean;
  env: WeaverEnv;
  genesisConfigJson: string;
  fingerprintJson: string;
}> {
  if (!execute) {
    const empty: GenesisFingerprint = {
      timestamp: new Date().toISOString(),
      files: {},
      packageJson: null,
      gitBranch: null,
      gitCommit: null,
      workflowHash: '',
      existingWorkflows: [],
    };
    return { onSuccess: true, onFailure: false, env, genesisConfigJson, fingerprintJson: JSON.stringify(empty) };
  }

  const config = JSON.parse(genesisConfigJson);
  const projectDir = env.projectDir;

  try {
    // Hash .ts files in the project (root + src/ if present)
    const files: Record<string, string> = {};
    const dirsToScan = [projectDir];
    const srcDir = path.join(projectDir, 'src');
    if (fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory()) dirsToScan.push(srcDir);

    for (const dir of dirsToScan) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.ts')) {
          const filePath = path.join(dir, entry.name);
          const relPath = path.relative(projectDir, filePath);
          const content = fs.readFileSync(filePath, 'utf-8');
          files[relPath] = crypto.createHash('sha256').update(content).digest('hex');
        }
      }
    }

    // Read package.json if it exists
    let packageJson: Record<string, unknown> | null = null;
    const pkgPath = path.join(projectDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      packageJson = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    }

    // Get git branch and commit
    let gitBranch: string | null = null;
    let gitCommit: string | null = null;
    try {
      gitBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      // Not a git repo or git unavailable
    }

    // Scan for existing workflow files (files containing @flowWeaver workflow)
    const existingWorkflows: string[] = [];
    for (const [relPath, _hash] of Object.entries(files)) {
      const filePath = path.join(projectDir, relPath);
      const content = fs.readFileSync(filePath, 'utf-8');
      if (content.includes('@flowWeaver workflow')) {
        existingWorkflows.push(relPath);
      }
    }

    // Hash the target workflow content
    const targetPath = path.resolve(projectDir, config.targetWorkflow);
    const targetContent = fs.readFileSync(targetPath, 'utf-8');
    const workflowHash = crypto.createHash('sha256').update(targetContent).digest('hex');

    const fingerprint: GenesisFingerprint = {
      timestamp: new Date().toISOString(),
      files,
      packageJson,
      gitBranch,
      gitCommit,
      workflowHash,
      existingWorkflows,
    };

    console.log(`\x1b[36m→ Fingerprint: ${Object.keys(files).length} files, ${existingWorkflows.length} workflows\x1b[0m`);

    return {
      onSuccess: true, onFailure: false,
      env, genesisConfigJson,
      fingerprintJson: JSON.stringify(fingerprint),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m→ Observe failed: ${msg}\x1b[0m`);
    return {
      onSuccess: false, onFailure: true,
      env, genesisConfigJson,
      fingerprintJson: '{}',
    };
  }
}
