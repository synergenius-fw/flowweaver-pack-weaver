#!/usr/bin/env tsx
/**
 * Release script -- bump version, build, create a PR, and let CI handle the rest.
 *
 * Usage:
 *   npm run release patch       # 0.2.0 -> 0.2.1
 *   npm run release minor       # 0.2.0 -> 0.3.0
 *   npm run release major       # 0.2.0 -> 1.0.0
 *   npm run release 0.5.0       # explicit version
 *
 * What it does:
 *   1. Bumps version in package.json and flowweaver.manifest.json
 *   2. Builds the project
 *   3. Creates a release branch, commits, pushes
 *   4. Creates a PR with auto-merge enabled
 *
 * After CI passes, the PR auto-merges. A GitHub Action then creates the
 * release and tag, which triggers npm publish automatically.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const pkgPath = path.join(rootDir, 'package.json');

function run(cmd: string, opts?: { cwd?: string; stdio?: 'inherit' | 'pipe' }): string {
  const result = execSync(cmd, {
    cwd: opts?.cwd ?? rootDir,
    stdio: opts?.stdio ?? 'pipe',
    encoding: 'utf-8',
  });
  return (result ?? '').trim();
}

function fail(msg: string): never {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
}

function info(msg: string): void {
  console.log(`\x1b[36m→ ${msg}\x1b[0m`);
}

function success(msg: string): void {
  console.log(`\x1b[32m✓ ${msg}\x1b[0m`);
}

function bumpVersion(current: string, bump: string): string {
  if (/^\d+\.\d+\.\d+/.test(bump)) return bump;

  const [major, minor, patch] = current.split('.').map(Number);
  switch (bump) {
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'major':
      return `${major + 1}.0.0`;
    default:
      fail(`Invalid bump type: "${bump}". Use patch, minor, major, or an explicit version.`);
  }
}

function preflight(): void {
  const branch = run('git rev-parse --abbrev-ref HEAD');
  if (branch !== 'main') {
    fail(`Must be on main branch (currently on "${branch}")`);
  }

  const dirty = run('git diff --name-only');
  if (dirty) {
    fail(`Working tree has uncommitted changes:\n${dirty}\nCommit or stash them first.`);
  }

  run('git fetch origin main');
  const behind = run('git rev-list HEAD..origin/main --count');
  if (behind !== '0') {
    fail(`Local main is ${behind} commit(s) behind origin. Run "git pull" first.`);
  }

  try {
    run('gh --version');
  } catch {
    fail('GitHub CLI (gh) is required but not found. Install it: https://cli.github.com');
  }
}

const bump = process.argv[2];
if (!bump) {
  console.log('Usage: npm run release <patch|minor|major|x.y.z>');
  process.exit(0);
}

preflight();

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
const currentVersion = pkg.version;
const newVersion = bumpVersion(currentVersion, bump);
const tag = `v${newVersion}`;
const releaseBranch = `release/${tag}`;

info(`Bumping ${currentVersion} → ${newVersion}`);

try {
  run(`git rev-parse ${tag}`);
  fail(`Tag ${tag} already exists`);
} catch {
  // Good
}

// 1. Bump version in package.json and manifest
pkg.version = newVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

const manifestPath = path.join(rootDir, 'flowweaver.manifest.json');
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  manifest.version = newVersion;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}
success(`Updated versions to ${newVersion}`);

// 2. Build
info('Building...');
run('npm run build', { stdio: 'inherit' });
success('Build complete');

// 3. Create release branch, commit, push
run(`git checkout -b ${releaseBranch}`);
run('git add package.json flowweaver.manifest.json');
run(`git commit -m "Release ${tag}"`);
run(`git push -u origin ${releaseBranch}`);
success(`Pushed ${releaseBranch}`);

// 4. Create PR with auto-merge
const prUrl = run(
  `gh pr create --title "Release ${tag}" --body "Bump version to ${newVersion}" --base main --head ${releaseBranch}`
);
info(`PR created: ${prUrl}`);

run(`gh pr merge ${releaseBranch} --squash --subject "Release ${tag}" --body "Bump version to ${newVersion}" --auto`);
success('Auto-merge enabled. CI will merge the PR when checks pass.');

run('git checkout main');

info('Once CI passes, the PR will auto-merge, create a GitHub release, and publish to npm.');
