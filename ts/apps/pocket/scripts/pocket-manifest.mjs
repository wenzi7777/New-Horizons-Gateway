#!/usr/bin/env node
// Writes the NH Pocket update manifest (releases/pocket-latest.json, or
// pocket-beta.json for a vX.Y.Z-beta.N version) for a release APK. Upload the
// APK to the GitHub release first and pass its download URL; the app checks
// size and sha256 before it opens the installer.
//
//   node apps/pocket/scripts/pocket-manifest.mjs --apk nh-pocket-v2.1.0.apk \
//     --version v2.1.0 --url https://github.com/wenzi7777/New-Horizons-Gateway/releases/download/pocket-v2.1.0/nh-pocket-v2.1.0.apk \
//     [--notes-url <url>] [--out-dir ../releases]
//
// The APK must be signed with the same key as the installed app (the EAS
// build's keystore), or Android refuses the update.
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: { apk: { type: 'string' }, version: { type: 'string' }, url: { type: 'string' }, 'notes-url': { type: 'string' }, 'out-dir': { type: 'string' } },
  strict: true,
});
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(2);
};
if (!values.apk || !values.version || !values.url) fail('usage: --apk <file> --version vX.Y.Z[-beta.N] --url https://... [--notes-url <url>] [--out-dir <dir>]');
if (!/^v\d+\.\d+\.\d+(-beta\.\d+)?$/.test(values.version)) fail('version must be vX.Y.Z or vX.Y.Z-beta.N');
if (!values.url.startsWith('https://')) fail('url must be https://');
const beta = values.version.includes('-beta.');
const bytes = readFileSync(values.apk);
const manifest = {
  version: values.version,
  notes_url: values['notes-url'] ?? '',
  released_at: new Date().toISOString(),
  assets: { android: { url: values.url, sha256: createHash('sha256').update(bytes).digest('hex'), size: statSync(values.apk).size } },
};
const outDir = resolve(values['out-dir'] ?? join(import.meta.dirname, '..', '..', '..', '..', 'releases'));
const out = join(outDir, beta ? 'pocket-beta.json' : 'pocket-latest.json');
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${out}\n`);
