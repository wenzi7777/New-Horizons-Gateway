#!/usr/bin/env node
// Writes the update manifests for a published studio-vX.Y.Z release from
// the files in a folder (the release's assets, downloaded with
// `gh release download studio-vX.Y.Z -D <dir>`):
//
//   releases/studio-latest.json      NH Studio app (dmg / exe / AppImage per platform key)
//   releases/gateway-bin-latest.json NH Studio headless (nh-studio-headless-<key>)
//   releases/pocket-latest.json      NH Pocket (nh-pocket-<version>.apk), if present
//
// A vX.Y.Z-beta.N version writes the -beta.json files instead; a stable one
// writes both (leaving beta never downgrades). URLs point at the release's
// download links; size and sha256 are computed here from the actual files.
//
//   node ts/scripts/release-manifests.mjs --tag studio-v2.0.0 --dir /tmp/assets
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const REPO = 'wenzi7777/New-Horizons-Gateway';
const { values } = parseArgs({ options: { tag: { type: 'string' }, dir: { type: 'string' }, 'out-dir': { type: 'string' } }, strict: true });
if (!values.tag?.startsWith('studio-v') || !values.dir) {
  process.stderr.write('usage: --tag studio-vX.Y.Z --dir <downloaded assets> [--out-dir releases]\n');
  process.exit(2);
}
const tag = values.tag;
const version = tag.slice('studio-'.length);
const plain = version.slice(1);
const beta = version.includes('-beta.');
const dir = resolve(values.dir);
const outDir = resolve(values['out-dir'] ?? join(import.meta.dirname, '..', '..', 'releases'));
const notesUrl = `https://raw.githubusercontent.com/${REPO}/${tag}/releases/notes/${tag}.md`;
const files = new Set(readdirSync(dir));

function asset(name) {
  if (!files.has(name)) return null;
  const path = join(dir, name);
  return {
    url: `https://github.com/${REPO}/releases/download/${tag}/${encodeURIComponent(name)}`,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    size: statSync(path).size,
  };
}

function manifest(map) {
  const assets = {};
  for (const [key, name] of Object.entries(map)) {
    const a = asset(name);
    if (a) assets[key] = a;
  }
  return { version, notes_url: notesUrl, released_at: new Date().toISOString(), assets };
}

function write(base, body) {
  const names = beta ? [`${base}-beta.json`] : [`${base}-latest.json`, `${base}-beta.json`];
  for (const name of names) writeFileSync(join(outDir, name), `${JSON.stringify(body, null, 2)}\n`);
  process.stdout.write(`${names.join(', ')}: ${Object.keys(body.assets).join(', ') || '(no assets)'}\n`);
}

write(
  'studio',
  manifest({
    'darwin-arm64': `NH-Studio-${plain}-mac-arm64.dmg`,
    'darwin-x64': `NH-Studio-${plain}-mac-x64.dmg`,
    'win32-x64': `NH-Studio-${plain}-win-x64.exe`,
    'linux-x64': `NH-Studio-${plain}-linux-x86_64.AppImage`,
  }),
);
write(
  'gateway-bin',
  manifest({
    'darwin-arm64': 'nh-studio-headless-darwin-arm64',
    'darwin-x64': 'nh-studio-headless-darwin-x64',
    'win32-x64': 'nh-studio-headless-win32-x64.exe',
    'linux-x64': 'nh-studio-headless-linux-x64',
    'linux-arm64': 'nh-studio-headless-linux-arm64',
  }),
);
if (files.has(`nh-pocket-${version}.apk`)) write('pocket', manifest({ android: `nh-pocket-${version}.apk` }));
