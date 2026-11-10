import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PRODUCTS,
  detectPlatform,
  fileNameFromUrl,
  formatSize,
  headlessAssetName,
  localizedNotesUrl,
  manifestUrlFor,
  parseAsset,
  parseManifest,
  pickAssets,
  pickLanguage,
  productById,
  productView,
  recommendedProduct,
  releasePageUrl,
  renderedUrl,
  studioAssetName,
} from "../download.js";

const UA = {
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  macChrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  macFirefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
  windowsChrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  windowsEdge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  linuxFirefox: "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
  linuxArm: "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  androidChrome: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  ipadDesktop: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  chromebook: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

const ALL_ASSETS = Object.fromEntries(
  ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64", "linux-arm64", "android"].map((key) => [
    key,
    { url: `https://github.com/wenzi7777/New-Horizons-Gateway/releases/download/v2.0.0/nh-studio-headless-${key}`, sha256: "ab".repeat(32), size: 110_000_000 },
  ]),
);

// ── Platform detection ──────────────────────────────────────────────────

test("detects macOS from Safari, Chrome and Firefox (architecture unknown)", () => {
  for (const ua of [UA.macSafari, UA.macChrome, UA.macFirefox]) {
    const platform = detectPlatform({ userAgent: ua, platform: "MacIntel", maxTouchPoints: 0 });
    assert.equal(platform.os, "mac", ua);
  }
});

test("Chromium's userAgentData wins over the UA string", () => {
  assert.equal(detectPlatform({ userAgent: UA.macChrome, uaData: { platform: "macOS", mobile: false } }).os, "mac");
  assert.equal(detectPlatform({ userAgent: UA.windowsChrome, uaData: { platform: "Windows" } }).os, "windows");
  assert.equal(detectPlatform({ userAgent: UA.androidChrome, uaData: { platform: "Android", mobile: true } }).os, "android");
  assert.equal(detectPlatform({ userAgent: UA.linuxArm, uaData: { platform: "Linux" } }).os, "linux");
  // An empty hint falls back to the UA string.
  assert.equal(detectPlatform({ userAgent: UA.windowsEdge, uaData: { platform: "" } }).os, "windows");
});

test("high-entropy architecture refines the guess", () => {
  assert.deepEqual(detectPlatform({ userAgent: UA.macChrome, uaData: { platform: "macOS" }, architecture: "arm" }), { os: "mac", arch: "arm64" });
  assert.deepEqual(detectPlatform({ userAgent: UA.macChrome, uaData: { platform: "macOS" }, architecture: "x86" }), { os: "mac", arch: "x64" });
});

test("detects Windows, Linux and its architecture", () => {
  assert.deepEqual(detectPlatform({ userAgent: UA.windowsChrome }), { os: "windows", arch: "x64" });
  assert.deepEqual(detectPlatform({ userAgent: UA.windowsEdge }), { os: "windows", arch: "x64" });
  assert.deepEqual(detectPlatform({ userAgent: UA.linuxFirefox, platform: "Linux x86_64" }), { os: "linux", arch: "x64" });
  assert.deepEqual(detectPlatform({ userAgent: UA.linuxArm, platform: "Linux aarch64" }), { os: "linux", arch: "arm64" });
});

test("detects Android before Linux, iPhone and iPadOS before macOS", () => {
  assert.equal(detectPlatform({ userAgent: UA.androidChrome, platform: "Linux armv81" }).os, "android");
  assert.equal(detectPlatform({ userAgent: UA.iphone, platform: "iPhone", maxTouchPoints: 5 }).os, "ios");
  // iPadOS Safari sends a Mac UA; only the touch screen gives it away.
  assert.equal(detectPlatform({ userAgent: UA.ipadDesktop, platform: "MacIntel", maxTouchPoints: 5 }).os, "ios");
  assert.equal(detectPlatform({ userAgent: UA.chromebook }).os, "chromeos");
  assert.equal(detectPlatform({ userAgent: "" }).os, "unknown");
  assert.equal(detectPlatform().os, "unknown");
});

// ── Asset picking ───────────────────────────────────────────────────────

test("Android gets the APK first", () => {
  assert.deepEqual(pickAssets({ os: "android", arch: "arm64" }, ALL_ASSETS), { primary: ["android"], notice: null });
});

test("macOS offers Apple Silicon first with Intel beside it", () => {
  assert.deepEqual(pickAssets({ os: "mac", arch: null }, ALL_ASSETS), { primary: ["darwin-arm64", "darwin-x64"], notice: "mac_arch" });
  assert.deepEqual(pickAssets({ os: "mac", arch: "arm64" }, ALL_ASSETS).primary, ["darwin-arm64", "darwin-x64"]);
  // Only Chromium's "x86" puts Intel first.
  assert.deepEqual(pickAssets({ os: "mac", arch: "x64" }, ALL_ASSETS).primary, ["darwin-x64", "darwin-arm64"]);
});

test("macOS with only one build offers that one without the architecture note", () => {
  const { "darwin-x64": _, ...armOnly } = ALL_ASSETS;
  assert.deepEqual(pickAssets({ os: "mac", arch: null }, armOnly), { primary: ["darwin-arm64"], notice: null });
});

test("Windows and Linux pick their build", () => {
  assert.deepEqual(pickAssets({ os: "windows", arch: "x64" }, ALL_ASSETS).primary, ["win32-x64"]);
  assert.deepEqual(pickAssets({ os: "linux", arch: "x64" }, ALL_ASSETS).primary, ["linux-x64"]);
  assert.deepEqual(pickAssets({ os: "linux", arch: null }, ALL_ASSETS).primary, ["linux-x64"]);
  assert.deepEqual(pickAssets({ os: "linux", arch: "arm64" }, ALL_ASSETS).primary, ["linux-arm64"]);
});

test("iOS explains there is no iPhone app; unknown platforms get the list", () => {
  assert.deepEqual(pickAssets({ os: "ios", arch: null }, ALL_ASSETS), { primary: [], notice: "ios" });
  assert.deepEqual(pickAssets({ os: "unknown", arch: null }, ALL_ASSETS), { primary: [], notice: "unknown" });
  assert.deepEqual(pickAssets({ os: "chromeos", arch: "x64" }, ALL_ASSETS), { primary: [], notice: "unknown" });
});

test("a platform missing from the release says so", () => {
  const { android: _a, ...noAndroid } = ALL_ASSETS;
  assert.deepEqual(pickAssets({ os: "android", arch: null }, noAndroid), { primary: [], notice: "not_built" });
  assert.deepEqual(pickAssets({ os: "windows", arch: "x64" }, {}), { primary: [], notice: "not_built" });
  assert.deepEqual(pickAssets({ os: "linux", arch: "arm64" }, { "linux-x64": ALL_ASSETS["linux-x64"] }), { primary: [], notice: "not_built" });
  assert.deepEqual(pickAssets({ os: "mac", arch: null }, null), { primary: [], notice: "not_built" });
});

// ── Manifests ───────────────────────────────────────────────────────────

const BASE = "https://raw.githubusercontent.com/wenzi7777/New-Horizons-Gateway/main/releases";

test("each product has its manifest, following the channel", () => {
  assert.deepEqual(PRODUCTS.map((p) => p.id), ["studio", "headless", "pocket"]);
  assert.equal(manifestUrlFor(productById("studio"), "stable"), `${BASE}/studio-latest.json`);
  assert.equal(manifestUrlFor("studio", "beta"), `${BASE}/studio-beta.json`);
  assert.equal(manifestUrlFor("headless", "stable"), `${BASE}/gateway-bin-latest.json`);
  assert.equal(manifestUrlFor("headless", " BETA "), `${BASE}/gateway-bin-beta.json`);
  assert.equal(manifestUrlFor("pocket", "nightly"), `${BASE}/pocket-latest.json`);
});

test("products ship for their platforms", () => {
  assert.deepEqual(productById("studio").keys, ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"]);
  assert.deepEqual(productById("headless").keys, ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64", "linux-arm64"]);
  assert.deepEqual(productById("pocket").keys, ["android"]);
  assert.equal(productById("nope"), null);
});

test("parses a manifest with every platform", () => {
  const body = JSON.stringify({
    version: " v2.0.0 ",
    notes_url: "https://raw.githubusercontent.com/wenzi7777/New-Horizons-Gateway/v2.0.0/releases/notes/v2.0.0.md",
    assets: Object.fromEntries(Object.entries(ALL_ASSETS).map(([k, v]) => [k, { ...v, sha256: v.sha256.toUpperCase() }])),
  });
  const manifest = parseManifest(body);
  assert.equal(manifest.version, "v2.0.0");
  assert.equal(Object.keys(manifest.assets).length, 6);
  assert.equal(manifest.assets["win32-x64"].sha256, "ab".repeat(32)); // lower-cased
  assert.deepEqual(manifest.rejected, {});
  // Only the product's own keys are read.
  assert.deepEqual(Object.keys(parseManifest(body, productById("pocket").keys).assets), ["android"]);
});

test("manifest validation mirrors parseBinManifest's errors", () => {
  assert.throws(() => parseManifest("not json"), /invalid_manifest/);
  assert.throws(() => parseManifest("[]"), /invalid_manifest/);
  assert.throws(() => parseManifest(JSON.stringify({ assets: {} })), /manifest_missing_version/);
  assert.throws(() => parseManifest(JSON.stringify({ version: "v2.0.0" })), /manifest_missing_assets/);
  assert.throws(() => parseManifest(JSON.stringify({ version: "v2.0.0", assets: [] })), /manifest_missing_assets/);

  assert.throws(() => parseAsset("x"), /manifest_invalid_asset/);
  assert.throws(() => parseAsset({ sha256: "a", size: 1 }), /manifest_missing_url/);
  assert.throws(() => parseAsset({ url: "u", size: 1 }), /manifest_missing_sha256/);
  assert.throws(() => parseAsset({ url: "u", sha256: "a" }), /manifest_missing_size/);
  assert.throws(() => parseAsset({ url: "u", sha256: "a", size: 0 }), /manifest_missing_size/);
  assert.throws(() => parseAsset({ url: "u", sha256: "a", size: 1.5 }), /manifest_missing_size/);
  assert.throws(() => parseAsset({ url: "u", sha256: "a", size: "big" }), /manifest_missing_size/);
  // Python float() accepts numeric strings.
  assert.equal(parseAsset({ url: "u", sha256: "a", size: "1024" }).size, 1024);
});

test("a bad or absent asset drops only that platform", () => {
  const manifest = parseManifest({
    version: "v2.0.0",
    assets: { "darwin-arm64": ALL_ASSETS["darwin-arm64"], "win32-x64": { url: "u", sha256: "a", size: -1 }, android: null, "freebsd-x64": ALL_ASSETS.android },
  });
  assert.deepEqual(Object.keys(manifest.assets), ["darwin-arm64"]);
  assert.deepEqual(manifest.rejected, { "win32-x64": "manifest_missing_size" });
});

// ── Product states ──────────────────────────────────────────────────────

test("a published manifest makes the product ready", () => {
  const view = productView(productById("studio"), { status: "ok", body: JSON.stringify({ version: "v2.0.0", assets: ALL_ASSETS }) });
  assert.equal(view.kind, "ready");
  assert.deepEqual(Object.keys(view.manifest.assets), ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"]);
});

test("before the first release the product says it is coming, never breaks", () => {
  const pocket = productById("pocket");
  assert.deepEqual(productView(pocket, { status: "missing" }), { kind: "coming", issue: null });
  assert.deepEqual(productView(pocket, undefined), { kind: "coming", issue: null });
  // A manifest without this product's platform is not a release of it yet.
  assert.deepEqual(productView(pocket, { status: "ok", body: JSON.stringify({ version: "v1.0.0", assets: { "linux-x64": ALL_ASSETS["linux-x64"] } }) }), {
    kind: "coming",
    issue: "manifest_no_assets",
  });
});

test("fetch failures and broken manifests are errors with their code", () => {
  const headless = productById("headless");
  assert.deepEqual(productView(headless, { status: "error", error: "network_error" }), { kind: "error", error: "network_error" });
  assert.deepEqual(productView(headless, { status: "error" }), { kind: "error", error: "fetch_failed" });
  assert.deepEqual(productView(headless, { status: "ok", body: "<html>" }), { kind: "error", error: "invalid_manifest" });
  assert.deepEqual(productView(headless, { status: "ok", body: "{}" }), { kind: "error", error: "manifest_missing_version" });
});

test("the recommended product follows the platform", () => {
  assert.equal(recommendedProduct({ os: "android" }), "pocket");
  for (const os of ["mac", "windows", "linux"]) assert.equal(recommendedProduct({ os }), "studio");
  for (const os of ["ios", "chromeos", "unknown"]) assert.equal(recommendedProduct({ os }), null);
  assert.equal(recommendedProduct(null), null);
});

// ── Links, sizes, language ──────────────────────────────────────────────

test("release links", () => {
  assert.equal(releasePageUrl("studio", "v2.0.0"), "https://github.com/wenzi7777/New-Horizons-Gateway/releases/tag/studio-v2.0.0");
  assert.equal(releasePageUrl("studio", "2.0.0"), "https://github.com/wenzi7777/New-Horizons-Gateway/releases/tag/studio-v2.0.0");
  assert.equal(releasePageUrl("studio", ""), "https://github.com/wenzi7777/New-Horizons-Gateway/releases");
  assert.equal(releasePageUrl("pocket", "v1.0.0"), "https://github.com/wenzi7777/New-Horizons-Gateway/releases");
  const raw = "https://raw.githubusercontent.com/wenzi7777/New-Horizons-Gateway/v1.1.3/releases/notes/v1.1.3.md";
  assert.equal(renderedUrl(raw), "https://github.com/wenzi7777/New-Horizons-Gateway/blob/v1.1.3/releases/notes/v1.1.3.md");
  assert.equal(renderedUrl("https://example.invalid/x"), "https://example.invalid/x");
  assert.equal(localizedNotesUrl(raw, "ja"), raw.replace(/\.md$/, ".ja.md"));
  assert.equal(localizedNotesUrl(raw, "en"), raw.replace(/\.md$/, ".en.md"));
  assert.equal(localizedNotesUrl(raw, "zh-CN"), "");
  assert.equal(localizedNotesUrl(raw.replace(/\.md$/, ".ja.md"), "en"), "");
  assert.equal(localizedNotesUrl("", "ja"), "");
});

test("file names and sizes", () => {
  assert.equal(fileNameFromUrl("https://github.com/o/r/releases/download/studio-v2.0.0/NH-Studio-2.0.0-win-x64.exe"), "NH-Studio-2.0.0-win-x64.exe");
  assert.equal(fileNameFromUrl("not a url"), "nh-studio");
  assert.equal(fileNameFromUrl("https://example.invalid/"), "nh-studio");
  assert.equal(studioAssetName("v2.0.0", "darwin-arm64"), "NH-Studio-2.0.0-mac-arm64.dmg");
  assert.equal(studioAssetName("2.0.0", "darwin-x64"), "NH-Studio-2.0.0-mac-x64.dmg");
  assert.equal(studioAssetName("v2.0.0", "win32-x64"), "NH-Studio-2.0.0-win-x64.exe");
  assert.equal(studioAssetName("v2.0.0", "linux-x64"), "NH-Studio-2.0.0-linux-x86_64.AppImage");
  assert.equal(studioAssetName("v2.0.0", "android"), "");
  assert.equal(headlessAssetName("win32-x64"), "nh-studio-headless-win32-x64.exe");
  assert.equal(headlessAssetName("linux-arm64"), "nh-studio-headless-linux-arm64");
  assert.equal(formatSize(112_345_678), "107 MB");
  assert.equal(formatSize(5_500_000), "5.2 MB");
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(0), "");
});

test("language: remembered choice, else the browser's", () => {
  assert.equal(pickLanguage("ja", ["en-US"]), "ja");
  assert.equal(pickLanguage(null, ["ja-JP", "en"]), "ja");
  assert.equal(pickLanguage(null, ["zh-TW"]), "zh-CN");
  assert.equal(pickLanguage(null, ["zh-Hans-CN"]), "zh-CN");
  assert.equal(pickLanguage(null, ["en-GB", "ja"]), "en");
  assert.equal(pickLanguage(null, ["fr-FR"]), "en");
  assert.equal(pickLanguage("de", []), "en");
  assert.equal(pickLanguage(undefined, undefined), "en");
});
