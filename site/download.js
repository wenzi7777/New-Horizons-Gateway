// The download page's logic that does not touch the DOM: the products, which
// platform the visitor is on, which assets to offer and how a manifest is
// read. A plain ES module so the browser loads it as is and
// `node --test site/test/` imports the same file.
//
// Every product publishes the same manifest shape (the shape
// ts/packages/core/src/update/manifest.ts parseBinManifest reads):
//   { version, notes_url, assets: { <platform key>: { url, sha256, size } } }
// with the same Python-style "truthy, str(), strip()" text handling and error
// codes. The page reads every platform at once, so an asset that would make
// parseBinManifest throw for its platform is left out (and reported in
// `rejected`) rather than failing the whole product.

export const REPO_URL = "https://github.com/wenzi7777/New-Horizons-Gateway";
export const RELEASES_URL = `${REPO_URL}/releases`;
export const MANIFEST_BASE_URL = "https://raw.githubusercontent.com/wenzi7777/New-Horizons-Gateway/main/releases";
export const CHANNELS = ["stable", "beta"];

/**
 * The products, in page order. `manifest` is the file stem under releases/
 * (<stem>-latest.json / <stem>-beta.json); `keys` the platforms it ships for.
 */
export const PRODUCTS = [
  { id: "studio", manifest: "studio", keys: ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"] },
  { id: "headless", manifest: "gateway-bin", keys: ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64", "linux-arm64"] },
  { id: "pocket", manifest: "pocket", keys: ["android"] },
];

export const productById = (id) => PRODUCTS.find((product) => product.id === id) || null;

/** Every platform key any product publishes, in list order. */
export const PLATFORM_KEYS = ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64", "linux-arm64", "android"];

/** Which install instructions belong to a platform key. */
export const PLATFORM_OS = {
  "darwin-arm64": "mac",
  "darwin-x64": "mac",
  "win32-x64": "windows",
  "linux-x64": "linux",
  "linux-arm64": "linux",
  android: "android",
};

export function normalizeChannel(value) {
  const channel = String(value == null ? "" : value).trim().toLowerCase();
  return CHANNELS.includes(channel) ? channel : "stable";
}

/** releases/<stem>-latest.json, or <stem>-beta.json on the beta channel. */
export function manifestUrlFor(product, channel, baseUrl = MANIFEST_BASE_URL) {
  const stem = typeof product === "string" ? (productById(product) || { manifest: product }).manifest : product.manifest;
  return `${baseUrl}/${stem}-${normalizeChannel(channel) === "beta" ? "beta" : "latest"}.json`;
}

// ── Python-style value handling (ts/packages/core/src/py.ts) ──────────────

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

function pyTruthy(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function pyStr(value) {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "nan";
    if (value === Infinity) return "inf";
    if (value === -Infinity) return "-inf";
    return String(value);
  }
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

const text = (value) => (pyTruthy(value) ? pyStr(value) : "").trim();

const FLOAT_RE = /^\s*[+-]?(?:(?:[0-9]+(?:_[0-9]+)*(?:\.(?:[0-9]+(?:_[0-9]+)*)?)?|\.[0-9]+(?:_[0-9]+)*)(?:[eE][+-]?[0-9]+(?:_[0-9]+)*)?|inf|infinity|nan)\s*$/i;

function pyFloat(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  if (typeof value === "string" && FLOAT_RE.test(value)) {
    const body = value.trim().replace(/_/g, "").toLowerCase();
    const sign = body.startsWith("-") ? -1 : 1;
    const bare = body.replace(/^[+-]/, "");
    if (bare === "inf" || bare === "infinity") return sign * Infinity;
    if (bare === "nan") return NaN;
    return Number(body);
  }
  throw new Error("not_a_number");
}

// ── Manifests ────────────────────────────────────────────────────────────

function decode(body) {
  if (isPlainObject(body)) return body;
  let decoded;
  try {
    decoded = JSON.parse(String(body));
  } catch {
    throw new Error("invalid_manifest");
  }
  if (!isPlainObject(decoded)) throw new Error("invalid_manifest");
  return decoded;
}

/** One asset entry, exactly as parseBinManifest checks it. Throws its error codes. */
export function parseAsset(entry) {
  if (!isPlainObject(entry)) throw new Error("manifest_invalid_asset");
  const url = text(entry.url);
  if (!url) throw new Error("manifest_missing_url");
  const sha256 = text(entry.sha256).toLowerCase();
  if (!sha256) throw new Error("manifest_missing_sha256");
  let size;
  try {
    size = pyFloat(entry.size);
  } catch {
    throw new Error("manifest_missing_size");
  }
  if (!Number.isInteger(size) || size <= 0) throw new Error("manifest_missing_size");
  return { url, sha256, size };
}

/**
 * A product manifest, every platform at once:
 *   { version, notesUrl, assets: { <key>: {url, sha256, size} }, rejected: { <key>: errorCode } }
 * Throws Error('invalid_manifest' | 'manifest_missing_version' | 'manifest_missing_assets').
 * Only `keys` are read (default: every key any product uses); null/absent
 * entries mean "not built for it".
 */
export function parseManifest(body, keys = PLATFORM_KEYS) {
  const decoded = decode(body);
  const version = text(decoded.version);
  if (!version) throw new Error("manifest_missing_version");
  if (!isPlainObject(decoded.assets)) throw new Error("manifest_missing_assets");
  const assets = {};
  const rejected = {};
  for (const key of keys) {
    const entry = decoded.assets[key];
    if (entry === undefined || entry === null) continue;
    try {
      assets[key] = parseAsset(entry);
    } catch (error) {
      rejected[key] = error.message;
    }
  }
  return { version, notesUrl: text(decoded.notes_url), assets, rejected };
}

/**
 * What one product's card shows, from its fetch:
 *   { status: "ok", body } | { status: "missing" } (HTTP 404) | { status: "error", error }
 * Returns { kind: "ready", manifest } when the manifest parses and has at
 * least one asset; { kind: "coming", issue } when nothing is published yet
 * (404, or a manifest with no usable asset); { kind: "error", error } else.
 */
export function productView(product, result) {
  if (!result || result.status === "missing") return { kind: "coming", issue: null };
  if (result.status !== "ok") return { kind: "error", error: result.error || "fetch_failed" };
  let manifest;
  try {
    manifest = parseManifest(result.body, product.keys);
  } catch (error) {
    return { kind: "error", error: error.message };
  }
  if (Object.keys(manifest.assets).length === 0) return { kind: "coming", issue: "manifest_no_assets" };
  return { kind: "ready", manifest };
}

/** Which product suits the visitor: the phone app on Android, the desktop app on a computer. */
export function recommendedProduct(platform) {
  const os = platform && platform.os;
  if (os === "android") return "pocket";
  if (os === "mac" || os === "windows" || os === "linux") return "studio";
  return null;
}

// ── Platform detection ──────────────────────────────────────────────────

/**
 * The visitor's platform from what the browser says:
 *   detectPlatform({ userAgent, platform, maxTouchPoints, uaData, architecture })
 * `uaData` is navigator.userAgentData (its `platform` and `mobile`);
 * `architecture` is its high-entropy "architecture" when it was asked
 * ("arm" | "x86" | ""). Returns { os, arch } with
 * os: "mac" | "windows" | "linux" | "android" | "ios" | "chromeos" | "unknown",
 * arch: "arm64" | "x64" | null (null = the browser does not say).
 */
export function detectPlatform(env = {}) {
  const ua = String(env.userAgent || "");
  const navPlatform = String(env.platform || "");
  const hint = env.uaData && typeof env.uaData.platform === "string" ? env.uaData.platform.toLowerCase() : "";
  const architecture = String(env.architecture || "").toLowerCase();
  const touch = Number(env.maxTouchPoints) || 0;

  let os = "unknown";
  if (hint) {
    if (hint === "android") os = "android";
    else if (hint === "macos") os = "mac";
    else if (hint === "windows") os = "windows";
    else if (hint === "chrome os" || hint === "chromeos") os = "chromeos";
    else if (hint === "linux") os = "linux";
    else if (hint === "ios") os = "ios";
  }
  if (os === "unknown") {
    if (/Android/i.test(ua)) os = "android";
    else if (/iPhone|iPad|iPod/i.test(ua)) os = "ios";
    // iPadOS Safari asks for the desktop site: a Mac with a touch screen.
    else if (/Macintosh|Mac OS X/i.test(ua)) os = touch > 1 ? "ios" : "mac";
    else if (/Windows/i.test(ua)) os = "windows";
    else if (/CrOS/.test(ua)) os = "chromeos";
    else if (/Linux|X11/i.test(ua)) os = "linux";
  }

  let arch = null;
  if (architecture === "arm") arch = "arm64";
  else if (architecture === "x86") arch = "x64";
  else if (/aarch64|arm64|armv8/i.test(ua) || /aarch64|arm64|armv8/i.test(navPlatform)) arch = "arm64";
  else if (/x86_64|x86-64|amd64|Win64|x64|WOW64/i.test(ua) || /x86_64|amd64/i.test(navPlatform)) arch = "x64";
  return { os, arch };
}

/**
 * The download buttons for a platform: { primary: [keys], notice }.
 * `primary` holds the keys to offer first, best guess first, filtered to
 * what the manifest has. Notices: "ios" (no iPhone app), "mac_arch" (we
 * cannot tell Apple Silicon from Intel, so both are offered), "not_built"
 * (this release has no build for the visitor's platform), "unknown".
 */
export function pickAssets(platform, assets) {
  const has = (key) => Boolean(assets && assets[key]);
  const os = platform && platform.os;
  const arch = platform && platform.arch;
  let wanted;
  let notice = null;
  switch (os) {
    case "android":
      wanted = ["android"];
      break;
    case "mac":
      // Browsers on Apple Silicon report an Intel Mac. Chromium's
      // high-entropy architecture is the only hint, and only "x86" changes
      // the default; both always sit side by side.
      wanted = arch === "x64" ? ["darwin-x64", "darwin-arm64"] : ["darwin-arm64", "darwin-x64"];
      notice = "mac_arch";
      break;
    case "windows":
      wanted = ["win32-x64"];
      break;
    case "linux":
      wanted = arch === "arm64" ? ["linux-arm64", "linux-x64"] : ["linux-x64", "linux-arm64"];
      wanted = [wanted[0]];
      break;
    case "ios":
      return { primary: [], notice: "ios" };
    default:
      return { primary: [], notice: "unknown" };
  }
  const primary = wanted.filter(has);
  if (primary.length === 0) return { primary: [], notice: "not_built" };
  if (os === "mac" && primary.length < 2) notice = null;
  return { primary, notice };
}

/** The install-instructions section to open first for a platform. */
export function osSection(platform) {
  const os = platform && platform.os;
  return ["mac", "windows", "linux", "android"].includes(os) ? os : null;
}

// ── Links and formatting ────────────────────────────────────────────────

const bareVersion = (version) => text(version).replace(/^v/i, "");

/**
 * Where a product's release lives on GitHub. NH Studio is tagged
 * studio-v<version>; the other products, and an unknown version, get the
 * list of all releases.
 */
export function releasePageUrl(productId, version) {
  const bare = bareVersion(version);
  if (productId === "studio" && bare) return `${RELEASES_URL}/tag/${encodeURIComponent(`studio-v${bare}`)}`;
  return RELEASES_URL;
}

/** The file electron-builder names an NH Studio build (NH-Studio-2.0.0-mac-arm64.dmg). */
export function studioAssetName(version, key) {
  const names = { "darwin-arm64": "mac-arm64.dmg", "darwin-x64": "mac-x64.dmg", "win32-x64": "win-x64.exe", "linux-x64": "linux-x86_64.AppImage" };
  return names[key] ? `NH-Studio-${bareVersion(version)}-${names[key]}` : "";
}

/** The file a headless build is published as (nh-studio-headless-win32-x64.exe). */
export function headlessAssetName(key) {
  return `nh-studio-headless-${key}${key.startsWith("win32") ? ".exe" : ""}`;
}

/**
 * A raw.githubusercontent.com Markdown file as GitHub renders it
 * (github.com/<owner>/<repo>/blob/<ref>/<path>); other URLs unchanged.
 */
export function renderedUrl(url) {
  const match = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(String(url || ""));
  return match ? `https://github.com/${match[1]}/${match[2]}/blob/${match[3]}/${match[4]}` : String(url || "");
}

/**
 * Release notes beside the original (vX.Y.Z.md, Traditional Chinese):
 * vX.Y.Z.ja.md / vX.Y.Z.en.md when translated (manifest.ts localizedNotesUrl).
 * zh-CN readers get the original. "" when there is no such variant.
 */
export function localizedNotesUrl(notesUrl, language) {
  const lang = language === "ja" ? "ja" : language === "en" ? "en" : "";
  if (!lang) return "";
  const match = /^(.*\/v[^/?#]+?)\.md([?#][^\n]*)?$/.exec(text(notesUrl));
  if (!match || /\.(ja|en)$/.test(match[1])) return "";
  return `${match[1]}.${lang}.md${match[2] || ""}`;
}

/** The file name a download URL saves as (its last path segment). */
export function fileNameFromUrl(url, fallback = "nh-studio") {
  try {
    const path = new URL(url).pathname;
    const name = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
    return name || fallback;
  } catch {
    return fallback;
  }
}

/** 112345678 → "107.1 MB" (binary units, as Finder and Explorer roughly show it). */
export function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** The page language: a remembered choice, else the browser's languages. */
export const LANGUAGES = ["en", "ja", "zh-CN"];

export function pickLanguage(stored, browserLanguages) {
  if (LANGUAGES.includes(stored)) return stored;
  for (const raw of browserLanguages || []) {
    const lang = String(raw || "").toLowerCase();
    if (lang.startsWith("ja")) return "ja";
    if (lang.startsWith("zh")) return "zh-CN";
    if (lang.startsWith("en")) return "en";
  }
  return "en";
}
