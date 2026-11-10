#!/usr/bin/env node
// Scans release files with VirusTotal (public API v3) and writes
// <dir>/virustotal.json: { "<file name>": { sha256, url, malicious,
// suspicious, harmless, undetected, scanned_at } }. release-manifests.mjs
// copies each entry into the manifest asset as `virustotal`, and the
// download page shows a "Scanned by VirusTotal" badge from it.
//
//   VIRUSTOTAL_API_KEY=... node ts/scripts/virustotal-scan.mjs --dir <assets>
//
// The free key allows 4 requests a minute: every request here waits its
// turn (16 s apart). A file VirusTotal already knows (by sha256) is not
// uploaded again. Files over 32 MB go through an upload URL (up to 650 MB).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const API = 'https://www.virustotal.com/api/v3';
const SPACING_MS = 16_000;
const SCAN_SUFFIXES = ['.dmg', '.exe', '.AppImage', '.apk'];

const { values } = parseArgs({ options: { dir: { type: 'string' }, 'max-wait-min': { type: 'string' } }, strict: true });
const key = process.env.VIRUSTOTAL_API_KEY;
if (!values.dir) {
  process.stderr.write('usage: VIRUSTOTAL_API_KEY=... --dir <assets>\n');
  process.exit(2);
}
if (!key) {
  process.stdout.write('VIRUSTOTAL_API_KEY not set: skipping the scan\n');
  process.exit(0);
}
const dir = resolve(values.dir);
const maxWaitMs = Number(values['max-wait-min'] ?? 30) * 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;

async function vt(path, init = {}) {
  const wait = last + SPACING_MS - Date.now();
  if (wait > 0) await sleep(wait);
  last = Date.now();
  const response = await fetch(path.startsWith('http') ? path : `${API}${path}`, { ...init, headers: { 'x-apikey': key, ...(init.headers ?? {}) } });
  const text = await response.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, json };
}

function stats(report) {
  const s = report?.data?.attributes?.last_analysis_stats ?? report?.data?.attributes?.stats ?? {};
  return { malicious: s.malicious ?? 0, suspicious: s.suspicious ?? 0, harmless: s.harmless ?? 0, undetected: s.undetected ?? 0 };
}

const names = readdirSync(dir).filter((n) => SCAN_SUFFIXES.some((s) => n.endsWith(s)) || n.startsWith('nh-studio-headless-'));
const out = {};
for (const name of names) {
  const path = join(dir, name);
  const bytes = readFileSync(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const known = await vt(`/files/${sha256}`);
  let done = known.status === 200 && known.json?.data?.attributes?.last_analysis_date;
  if (!done) {
    let uploadUrl = `${API}/files`;
    if (statSync(path).size > 32 * 1024 * 1024) {
      const u = await vt('/files/upload_url');
      if (u.status !== 200) throw new Error(`upload_url ${u.status}: ${JSON.stringify(u.json)}`);
      uploadUrl = u.json.data;
    }
    const form = new FormData();
    form.append('file', new Blob([bytes]), name);
    const up = await vt(uploadUrl, { method: 'POST', body: form });
    if (up.status !== 200) throw new Error(`upload ${name} ${up.status}: ${JSON.stringify(up.json)}`);
    const analysisId = up.json.data.id;
    const started = Date.now();
    for (;;) {
      const a = await vt(`/analyses/${analysisId}`);
      if (a.json?.data?.attributes?.status === 'completed') break;
      if (Date.now() - started > maxWaitMs) throw new Error(`scan of ${name} did not finish in time`);
      await sleep(30_000);
    }
  }
  const report = await vt(`/files/${sha256}`);
  out[name] = { sha256, url: `https://www.virustotal.com/gui/file/${sha256}`, ...stats(report), scanned_at: new Date().toISOString() };
  process.stdout.write(`${name}: ${out[name].malicious} malicious, ${out[name].suspicious} suspicious\n`);
}
writeFileSync(join(dir, 'virustotal.json'), `${JSON.stringify(out, null, 2)}\n`);
process.stdout.write(`${join(dir, 'virustotal.json')}\n`);
