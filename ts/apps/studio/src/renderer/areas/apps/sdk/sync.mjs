#!/usr/bin/env node
// Copy the NHOS App SDK (compiler, validator, simulator) from the App Library
// checkout into this folder, with the authoring guide and the example apps
// App Studio's "AI prompt" quotes. NHOS-App-Library is the source of truth:
// never edit lib/, docs/ or examples/ here -- change the library, then run
//
//   node apps/studio/src/renderer/areas/apps/sdk/sync.mjs [path/to/NHOS-App-Library]
//
// (from New-Horizons-Gateway/ts). The default library path is the checkout
// beside New-Horizons-Gateway. test/renderer/appsSdkSync.test.ts fails when
// the copy and the library drift apart, whenever the library is checked out.
// The same files, picked the same way, as the Desktop's scripts/sync_app_sdk.sh.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LIBRARY = resolve(HERE, '../../../../../../../../../NHOS-App-Library');
export const EXAMPLE_FLOWS = ['steps', 'tilt', 'mat_view'];
export const EXAMPLE_READOUTS = ['sensors'];
export const EXAMPLE_PANELS = ['sysmon'];

function main() {
  const library = resolve(process.argv[2] ?? DEFAULT_LIBRARY);
  const source = join(library, 'sdk');
  if (!existsSync(join(source, 'lib', 'index.mjs'))) {
    console.error(`No SDK at ${source}; pass the App Library checkout as the first argument.`);
    process.exit(1);
  }
  for (const dir of ['lib', 'docs', 'examples']) rmSync(join(HERE, dir), { recursive: true, force: true });
  mkdirSync(join(HERE, 'lib'), { recursive: true });
  mkdirSync(join(HERE, 'docs'), { recursive: true });
  mkdirSync(join(HERE, 'examples'), { recursive: true });
  for (const name of readdirSync(join(source, 'lib')).filter((n) => n.endsWith('.mjs'))) {
    copyFileSync(join(source, 'lib', name), join(HERE, 'lib', name));
  }
  // Beside index.mjs as index.d.mts, TypeScript resolves the SDK's types without allowJs.
  copyFileSync(join(source, 'index.d.ts'), join(HERE, 'lib', 'index.d.mts'));
  copyFileSync(join(library, 'docs', 'authoring.md'), join(HERE, 'docs', 'authoring.md'));
  for (const app of EXAMPLE_FLOWS) copyFileSync(join(library, 'apps', app, 'app.nhs'), join(HERE, 'examples', `${app}.nhs`));
  for (const app of EXAMPLE_READOUTS) copyFileSync(join(library, 'apps', app, 'readout.json'), join(HERE, 'examples', `${app}.readout.json`));
  for (const app of EXAMPLE_PANELS) copyFileSync(join(library, 'apps', app, 'panel.json'), join(HERE, 'examples', `${app}.panel.json`));
  let commit = 'unknown';
  let dirty = '';
  try {
    commit = execFileSync('git', ['-C', library, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    if (execFileSync('git', ['-C', library, 'status', '--porcelain', '--', 'sdk', 'docs', 'apps'], { encoding: 'utf8' }).trim()) dirty = ' (with uncommitted changes)';
  } catch {
    // Not a git checkout: the copy is still made.
  }
  writeFileSync(
    join(HERE, 'SOURCE'),
    `Vendored from NHOS-App-Library at ${commit}${dirty}: lib/ from sdk/,\ndocs/ from docs/, examples/ from apps/.\nDo not edit these files here: change the library, then run sync.mjs in this folder.\n`,
  );
  console.log(`Synced SDK from ${source} (${commit}${dirty}) into ${HERE}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
