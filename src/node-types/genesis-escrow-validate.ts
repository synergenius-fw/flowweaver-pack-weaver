import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import type { GenesisContext } from '../bot/types.js';
import { GenesisStore } from '../bot/genesis-store.js';

/**
 * Validates staged escrow files. For workflows, runs flow-weaver compile+validate
 * on a temp copy. For TypeScript modules, runs a transpile check.
 *
 * @flowWeaver nodeType
 * @label Genesis Escrow Validate
 * @input ctx [order:0] - Genesis context (JSON)
 * @output ctx [order:0] - Genesis context with escrow validation result (JSON)
 * @output onSuccess [order:-2] - On Success
 * @output onFailure [order:-1] [hidden] - On Failure
 */
export function genesisEscrowValidate(ctx: string): {
  onSuccess: boolean; onFailure: boolean;
  ctx: string;
} {
  const context = JSON.parse(ctx) as GenesisContext;
  const { env } = context;
  const store = new GenesisStore(env.projectDir);
  const token = store.loadEscrowToken();

  if (!token || token.phase !== 'staged') {
    // No staged escrow: pass through (not an error, just nothing to validate)
    return { onSuccess: true, onFailure: false, ctx: JSON.stringify(context) };
  }

  const packRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

  try {
    for (const relFile of token.affectedFiles) {
      const stagedPath = store.getEscrowStagedPath(relFile);
      const content = fs.readFileSync(stagedPath, 'utf-8');

      if (relFile.includes('workflows/')) {
        // Workflow file: write to temp, run compile+validate
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'escrow-validate-'));
        const tmpFile = path.join(tmpDir, path.basename(relFile));
        fs.writeFileSync(tmpFile, content, 'utf-8');

        try {
          execFileSync('flow-weaver', ['compile', tmpFile], {
            cwd: packRoot,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 30_000,
          });

          execFileSync('flow-weaver', ['validate', tmpFile], {
            cwd: packRoot,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 30_000,
          });
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      } else {
        // TypeScript module: transpile check using tsc --noEmit on a temp file
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'escrow-tsc-'));
        const tmpFile = path.join(tmpDir, path.basename(relFile));
        fs.writeFileSync(tmpFile, content, 'utf-8');

        // Write a minimal tsconfig for the check
        const tsconfig = {
          compilerOptions: {
            target: 'ES2022',
            module: 'Node16',
            moduleResolution: 'Node16',
            noEmit: true,
            strict: true,
            skipLibCheck: true,
            esModuleInterop: true,
          },
          include: [path.basename(relFile)],
        };
        fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify(tsconfig), 'utf-8');

        try {
          execFileSync('npx', ['tsc', '--project', path.join(tmpDir, 'tsconfig.json')], {
            cwd: tmpDir,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 30_000,
          });
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      }
    }

    token.phase = 'validated';
    token.validationResult = { compiled: true, validated: true };
    store.saveEscrowToken(token);

    console.log('\x1b[32m→ Escrow validation passed\x1b[0m');
    return { onSuccess: true, onFailure: false, ctx: JSON.stringify(context) };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);

    token.phase = 'rolled-back';
    token.rollbackReason = `Validation failed: ${msg.slice(0, 500)}`;
    token.validationResult = { compiled: false, validated: false, error: msg.slice(0, 500) };
    store.saveEscrowToken(token);

    // Clean up staged files
    for (const relFile of token.affectedFiles) {
      try { fs.unlinkSync(store.getEscrowStagedPath(relFile)); } catch { /* ignore */ }
    }

    console.error(`\x1b[31m→ Escrow validation failed: ${msg.slice(0, 200)}\x1b[0m`);
    context.error = `Escrow validation failed: ${msg.slice(0, 200)}`;
    return { onSuccess: false, onFailure: true, ctx: JSON.stringify(context) };
  }
}
