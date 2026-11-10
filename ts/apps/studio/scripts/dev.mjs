#!/usr/bin/env node
// `npm run dev`: the renderer on Vite's dev server, main/preload rebuilt by
// esbuild on change, and Electron started with VITE_DEV_SERVER_URL. Quitting
// Electron (or Ctrl-C) stops everything. Main-process changes need an app
// restart (Cmd/Ctrl-Q, then npm run dev again); renderer changes hot-reload.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const electronBinary = require('electron'); // the path of the Electron executable
const { createServer } = await import('vite');

const children = new Set();
const stopAll = (code = 0) => {
  for (const child of children) child.kill();
  process.exit(code);
};
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

const server = await createServer({ root: appDir, configFile: resolve(appDir, 'vite.config.ts') });
await server.listen();
const url = server.resolvedUrls?.local?.[0];
if (!url) {
  console.error('vite: no local URL');
  stopAll(1);
}
console.log(`[dev] renderer at ${url}`);

const buildScript = resolve(appDir, 'scripts/build-main.mjs');
// One build first, so Electron starts on fresh output; then watch.
if (spawnSync(process.execPath, [buildScript, '--dev'], { cwd: appDir, stdio: 'inherit' }).status !== 0) {
  await server.close();
  stopAll(1);
}
const builder = spawn(process.execPath, [buildScript, '--dev', '--watch'], { cwd: appDir, stdio: 'inherit' });
children.add(builder);

const electron = spawn(electronBinary, ['.'], {
  cwd: appDir,
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url, ELECTRON_ENABLE_LOGGING: '1' },
});
children.add(electron);
electron.on('exit', async (code) => {
  children.delete(electron);
  await server.close();
  stopAll(code ?? 0);
});
