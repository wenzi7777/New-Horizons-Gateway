// The phone QR code, the VirusTotal badge, the macOS open steps, and a guard
// against app.js calling a function nobody defined (a missing
// updateChannelControl once left every card on "Checking").
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as download from "../download.js";
import { encodeQr, formatBits, qrSvg, rsRemainder } from "../qr.js";
import { STRINGS } from "../i18n.js";

const SITE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(join(SITE_DIR, name), "utf8");
const LANGS = ["en", "ja", "zh-CN"];
const PAGE_URL = "https://wenzi7777.github.io/New-Horizons-Gateway/";

// ── QR code ─────────────────────────────────────────────────────────────

test("qr: Reed-Solomon and format bits match the spec's worked values", () => {
  // ISO/IEC 18004 "HELLO WORLD" 1-M example: data codewords -> 10 EC codewords.
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(rsRemainder(data, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  // Level M format strings, mask 0 and mask 7.
  assert.equal(formatBits(0).toString(2).padStart(15, "0"), "101010000010010");
  assert.equal(formatBits(7).toString(2).padStart(15, "0"), "100101010100000");
});

test("qr: the page URL encodes with finder patterns in all three corners", () => {
  const { version, size, modules } = encodeQr(PAGE_URL);
  assert.equal(size, version * 4 + 17);
  assert.equal(modules.length, size);
  const finder = (x0, y0) => {
    for (let dy = 0; dy < 7; dy++) {
      for (let dx = 0; dx < 7; dx++) {
        const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        assert.equal(modules[y0 + dy][x0 + dx], ring !== 2, `finder at ${x0},${y0}`);
      }
    }
  };
  finder(0, 0);
  finder(size - 7, 0);
  finder(0, size - 7);
  assert.equal(modules[size - 8][8], true, "dark module");
  // Versions grow with the text, and stop at the encoder's limit.
  assert.ok(encodeQr("x".repeat(200)).version > version);
  assert.throws(() => encodeQr("x".repeat(400)), /qr_too_long/);
});

test("qr: the SVG takes its colours from the design tokens", () => {
  const svg = qrSvg(PAGE_URL, { label: 'QR "page"' });
  assert.match(svg, /^<svg class="qr"[^>]*viewBox="0 0 (\d+) \1"/);
  assert.match(svg, /<rect class="qr-bg"/);
  assert.match(svg, /<path class="qr-fg" d="M/);
  assert.match(svg, /aria-label="QR &quot;page&quot;"/);
  assert.doesNotMatch(svg, /fill=|#[0-9a-f]{3,6}\b/i, "colours belong in app.css");
  const css = read("app.css");
  assert.match(css, /\.qr-bg\s*\{\s*fill:\s*var\(--/);
  assert.match(css, /\.qr-fg\s*\{\s*fill:\s*var\(--/);
  assert.match(css, /\[data-theme="dark"\] \.qr-bg/);
});

test("qr: the page has the phone panel, shown on computers only", () => {
  const html = read("index.html");
  assert.match(html, /id="phone-qr"[^>]*hidden/);
  assert.match(html, /id="phone-qr-code"/);
  const app = read("app.js");
  assert.match(app, /qrSvg\(/);
  assert.match(app, /renderPhoneQr\(\)/);
  for (const os of ["mac", "windows", "linux", "chromeos"]) assert.equal(download.showsPhoneQr({ os }), true, os);
  for (const os of ["android", "ios", "unknown"]) assert.equal(download.showsPhoneQr({ os }), false, os);
  assert.equal(download.showsPhoneQr(null), false);
  assert.equal(download.phoneQrUrl(`${PAGE_URL}?channel=beta#main`), `${PAGE_URL}?channel=beta`);
  assert.equal(download.phoneQrUrl("not a url"), "");
  // Hidden on narrow and touch-only screens by CSS too.
  assert.match(read("app.css"), /@media \(max-width: 640px\)[^{]*\{\s*\.phone-qr \{ display: none; \}/);
});

// ── VirusTotal badge ────────────────────────────────────────────────────

const SHA = "a".repeat(64);
const asset = (extra) => ({ url: "https://github.com/x/y/releases/download/v1/f.dmg", sha256: SHA, size: 10, ...extra });
const VT = { url: `https://www.virustotal.com/gui/file/${SHA}`, sha256: SHA, malicious: 0, scanned_at: "2026-11-11T08:00:00Z" };

test("virustotal: parsed from the manifest asset, absent stays absent", () => {
  assert.deepEqual(download.parseAsset(asset()), { url: asset().url, sha256: SHA, size: 10 });
  assert.deepEqual(download.parseAsset(asset({ virustotal: VT })).virustotal, { url: VT.url, sha256: SHA, malicious: 0, scannedAt: VT.scanned_at });
  // A bad scan entry hides the badge, never the download.
  for (const bad of [null, "x", {}, { ...VT, url: "https://evil.example/report" }, { ...VT, url: "javascript:alert(1)" }, { ...VT, malicious: -1 }, { ...VT, malicious: 1.5 }, { ...VT, malicious: "many" }]) {
    const parsed = download.parseAsset(asset({ virustotal: bad }));
    assert.equal(parsed.virustotal, undefined, JSON.stringify(bad));
    assert.equal(parsed.url, asset().url);
  }
  const body = JSON.stringify({ version: "v2.1.0", assets: { "darwin-arm64": asset({ virustotal: VT }), "win32-x64": asset() } });
  const view = download.productView(download.productById("studio"), { status: "ok", body });
  assert.equal(view.kind, "ready");
  assert.ok(view.manifest.assets["darwin-arm64"].virustotal);
  assert.equal(view.manifest.assets["win32-x64"].virustotal, undefined);
});

test("virustotal: badge is green for 0 detections, flagged otherwise, none without a scan", () => {
  const clean = download.virusTotalBadge(download.parseAsset(asset({ virustotal: VT })));
  assert.deepEqual(clean, { href: VT.url, tone: "clean", labelKey: "vtClean", titleKey: "vtTitleDated", vars: { count: 0, date: "2026-11-11" } });
  const flagged = download.virusTotalBadge(download.parseAsset(asset({ virustotal: { ...VT, malicious: 3, scanned_at: "" } })));
  assert.equal(flagged.tone, "flagged");
  assert.equal(flagged.labelKey, "vtFlagged");
  assert.equal(flagged.titleKey, "vtTitle");
  assert.equal(flagged.vars.count, 3);
  assert.equal(download.virusTotalBadge(download.parseAsset(asset())), null);
  assert.equal(download.virusTotalBadge(null), null);
  for (const lang of LANGS) {
    for (const key of ["vtClean", "vtFlagged", "vtTitle", "vtTitleDated"]) assert.ok(STRINGS[lang][key], `${lang}.${key}`);
    assert.match(STRINGS[lang].vtFlagged, /\{count\}/);
    assert.match(STRINGS[lang].vtTitleDated, /\{date\}/);
  }
  assert.match(STRINGS.en.vtClean, /Scanned by VirusTotal/);
  // app.js draws it on every asset row (and beside the big button when the list is hidden).
  const app = read("app.js");
  assert.match(app, /virusTotalBadge\(asset\)/);
  assert.ok((app.match(/appendScanBadge\(/g) || []).length >= 3);
  const css = read("app.css");
  assert.match(css, /\.scan-badge\.clean \{ color: var\(--success\)/);
});

// ── macOS open steps ────────────────────────────────────────────────────

test("macOS steps: Open Anyway in Privacy & Security, right-click alternative, headless xattr kept", () => {
  const html = read("index.html");
  for (const key of ["studioMac1", "studioMac2", "studioMac3", "studioMac4"]) assert.match(html, new RegExp(`data-i18n="${key}"`));
  assert.match(STRINGS.en.studioMac3, /Privacy & Security/);
  assert.match(STRINGS.en.studioMac3, /Open Anyway/);
  assert.match(STRINGS.en.studioMac4, /right-click/);
  assert.match(STRINGS.ja.studioMac3, /このまま開く/);
  assert.match(STRINGS["zh-CN"].studioMac3, /仍要打开/);
  assert.match(html, /data-cmd="mac-xattr"/);
  assert.match(read("app.js"), /xattr -d com\.apple\.quarantine/);
});

test("zh-CN calls Profiles 描述文件", () => {
  for (const [key, value] of Object.entries(STRINGS["zh-CN"])) assert.doesNotMatch(value, /配置文件/, key);
});

// ── Every function app.js calls exists ──────────────────────────────────

const JS_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "typeof", "function", "await", "new", "of", "in", "do", "else", "try", "case", "void", "delete", "throw", "import", "export", "async", "super", "this"]);
const GLOBALS = new Set(["String", "Number", "Boolean", "Object", "Array", "Math", "JSON", "Date", "Error", "Promise", "Map", "Set", "URL", "URLSearchParams", "AbortController", "TextEncoder", "fetch", "setTimeout", "clearTimeout", "encodeURIComponent", "decodeURIComponent", "parseInt", "parseFloat", "isNaN", "Buffer"]);

function definedNames(source) {
  const names = new Set();
  for (const m of source.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1]);
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from/g)) for (const part of m[1].split(",")) if (part.trim()) names.add(part.trim().split(/\s+as\s+/).pop());
  for (const m of source.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) names.add(m[1]);
  // Parameters and destructured locals: (a, b) => / function f(a, b).
  for (const m of source.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) for (const part of m[1].split(/[,{}\s=]+/)) if (/^[A-Za-z_$][\w$]*$/.test(part)) names.add(part);
  for (const m of source.matchAll(/\b([A-Za-z_$][\w$]*)\s*=>/g)) names.add(m[1]);
  return names;
}

function calledNames(source) {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/`(?:\\.|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
  const called = new Set();
  for (const m of code.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) if (!JS_KEYWORDS.has(m[2])) called.add(m[2]);
  return called;
}

for (const file of ["app.js", "download.js", "qr.js"]) {
  test(`every function ${file} calls is defined or imported`, () => {
    const source = read(file);
    const defined = definedNames(source);
    const missing = [...calledNames(source)].filter((name) => !defined.has(name) && !GLOBALS.has(name));
    assert.deepEqual(missing, [], `${file} calls undefined: ${missing.join(", ")}`);
  });
}

test("app.js imports only names download.js / qr.js export", async () => {
  const app = read("app.js");
  const qr = await import("../qr.js");
  for (const m of app.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/(download|qr)\.js/g)) {
    const mod = m[2] === "qr" ? qr : download;
    for (const name of m[1].split(",").map((s) => s.trim()).filter(Boolean)) assert.ok(name in mod, `${m[2]}.js lacks export ${name}`);
  }
});

test("the function-call guard catches a missing function", () => {
  const source = "function render() { updateChannelControl(); draw(); }\nconst draw = () => 1;";
  const defined = definedNames(source);
  assert.deepEqual([...calledNames(source)].filter((n) => !defined.has(n)), ["updateChannelControl"]);
});
