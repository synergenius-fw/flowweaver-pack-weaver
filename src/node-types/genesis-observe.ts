import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { GenesisFingerprint, GenesisContext } from '../bot/types.js';
import { getWorkflowDescription } from '../bot/genesis-prompt-context.js';

/**
 * Fingerprints the project state: hashes .ts files, reads package.json,
 * captures git branch/commit, scans for workflow files, and hashes the
 * target workflow content.
 *
 * @flowWeaver nodeType
 * @label Genesis Observe
 * @input ctx [order:0] - Genesis context (JSON)
 * @output ctx [order:0] - Genesis context with fingerprintJson (JSON)
 * @output onSuccess [order:-2] - On Success
 * @output onFailure [order:-1] [hidden] - On Failure
 */
export async function genesisObserve(
  execute: boolean,
  ctx: string,
): Promise<{
  onSuccess: boolean; onFailure: boolean;
  ctx: string;
}> {
  const context = JSON.parse(ctx) as GenesisContext;
  const { env } = context;
  const config = JSON.parse(context.genesisConfigJson);

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
    context.fingerprintJson = JSON.stringify(empty);
    return { onSuccess: true, onFailure: false, ctx: JSON.stringify(context) };
  }

  const projectDir = env.projectDir;

  try {
    const files: Record<string, string> = {};
    const fileContents: Record<string, string> = {};
    const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.next', '.turbo']);

    function walkDir(dir: string): void {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) {
            walkDir(path.join(dir, entry.name));
          }
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
          const filePath = path.join(dir, entry.name);
          const relPath = path.relative(projectDir, filePath);
          const content = fs.readFileSync(filePath, 'utf-8');
          fileContents[relPath] = content;
          files[relPath] = crypto.createHash('sha256').update(content).digest('hex');
        }
      }
    }

    walkDir(projectDir);

    let packageJson: Record<string, unknown> | null = null;
    const pkgPath = path.join(projectDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      packageJson = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    }

    let gitBranch: string | null = null;
    let gitCommit: string | null = null;
    try {
      gitBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch (err) {
      // Not a git repo or git unavailable
      if (process.env.WEAVER_VERBOSE) console.error('[genesis-observe] git unavailable:', err);
    }

    const existingWorkflows: string[] = [];
    for (const [relPath, content] of Object.entries(fileContents)) {
      if (content.includes('@flowWeaver workflow')) {
        existingWorkflows.push(relPath);
      }
    }

    let workflowHash = '';
    let targetPath = '';
    if (config.targetWorkflow) {
      targetPath = path.resolve(projectDir, config.targetWorkflow);
      const targetRelPath = path.relative(projectDir, targetPath);
      const targetContent = fileContents[targetRelPath] ?? fs.readFileSync(targetPath, 'utf-8');
      workflowHash = crypto.createHash('sha256').update(targetContent).digest('hex');
    }

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

    context.fingerprintJson = JSON.stringify(fingerprint);
    if (targetPath) {
      context.workflowDescription = await getWorkflowDescription(targetPath);
    }

    return { onSuccess: true, onFailure: false, ctx: JSON.stringify(context) };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m→ Observe failed: ${msg}\x1b[0m`);
    context.fingerprintJson = '{}';
    return { onSuccess: false, onFailure: true, ctx: JSON.stringify(context) };
  }
}
