#!/usr/bin/env node
// Bundles NH Studio's Electron main process and preload with esbuild:
//
//   src/main/main.ts        -> dist/main/main.cjs        (CJS, node, electron external)
//   src/preload/preload.ts  -> dist/preload/preload.cjs  (CJS, sandboxed preload: electron external only)
//
// Workspace packages (@nhgw/core, engine, host, ui-tokens, the @nhgw/node
// adapters) are bundled in, so the packaged app needs no node_modules.
//
// Usage: node scripts/build-main.mjs [--dev] [--watch]
//   --dev    inline source maps, no minify (npm run dev)
//   --watch  rebuild on change (with --dev)
import { build, context } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const dev = args.has('--dev');
const watch = args.has('--watch');

const common = {
  absWorkingDir: appDir,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  keepNames: true,
  legalComments: 'none',
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
};

const targets = [
  { ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.cjs' },
  { ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload/preload.cjs' },
];

if (watch) {
  for (const options of targets) await (await context(options)).watch();
} else {
  await Promise.all(targets.map((options) => build(options)));
}
