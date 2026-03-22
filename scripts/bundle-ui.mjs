/**
 * Bundle UI contributions for the platform's pack-ui-contributions-loader.
 *
 * Each .tsx file in src/ui/ gets bundled to dist/ui/<name>.js as a
 * CommonJS module with React externalized (the platform shims it via require).
 */

import { build } from 'esbuild';
import { readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const UI_SRC = 'src/ui';
const UI_DIST = 'dist/ui';

// Ensure output dir
mkdirSync(UI_DIST, { recursive: true });

// Find all .tsx files
const entries = readdirSync(UI_SRC).filter(f => f.endsWith('.tsx'));

if (entries.length === 0) {
  console.log('No UI contributions to bundle.');
  process.exit(0);
}

for (const entry of entries) {
  const name = entry.replace('.tsx', '');
  await build({
    entryPoints: [join(UI_SRC, entry)],
    outfile: join(UI_DIST, `${name}.js`),
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2020',
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom', '@fw/plugin-ui-kit', '@fw/plugin-theme'],
    minify: false,
    sourcemap: false,
  });
  console.log(`  bundled: ${UI_DIST}/${name}.js`);
}
