// New Horizons download page: fetches each product's release manifest from
// the repo, highlights the product and build that suit the visitor and lists
// every build. The decisions (products, platform, which asset, manifest
// rules) live in download.js; this file only reads the browser and draws.
import {
  PLATFORM_OS,
  PRODUCTS,
  detectPlatform,
  fileNameFromUrl,
  formatSize,
  headlessAssetName,
  localizedNotesUrl,
  manifestUrlFor,
  normalizeChannel,
  osSection,
  pickAssets,
  pickLanguage,
  productView,
  recommendedProduct,
  phoneQrUrl,
  releasePageUrl,
  renderedUrl,
  showsPhoneQr,
  virusTotalBadge,
} from "./download.js?v=__BUILD__";
import { qrSvg } from "./qr.js?v=__BUILD__";
import { STRINGS } from "./i18n.js?v=__BUILD__";

const LANGUAGE_KEY = "nh-download-language";
const CHANNEL_KEY = "nh-download-channel";
const FETCH_TIMEOUT_MS = 15000;

const $ = (id) => document.getElementById(id);

// Lucide icons, drawn as the Gateway web UI draws them (app.js ICONS).
const ICON_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const THEME_ICON_ATTRS = 'width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const ICONS = {
  sun: `<svg ${THEME_ICON_ATTRS}><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`,
  moon: `<svg ${THEME_ICON_ATTRS}><path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/></svg>`,
  auto: `<svg ${THEME_ICON_ATTRS}><path d="M12 2v2"/><path d="M14.837 16.385a6 6 0 1 1-7.223-7.222c.624-.147.97.66.715 1.248a4 4 0 0 0 5.26 5.259c.589-.255 1.396.09 1.248.715"/><path d="M16 12a4 4 0 0 0-4-4"/><path d="m19 5-1.256 1.256"/><path d="M20 12h2"/></svg>`,
  download: `<svg ${ICON_ATTRS}><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>`,
  copy: `<svg ${ICON_ATTRS}><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`,
  check: `<svg ${ICON_ATTRS} stroke-width="2.6"><path d="M20 6 9 17l-5-5"/></svg>`,
  shield: `<svg ${ICON_ATTRS}><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg>`,
};

// ── State ─────────────────────────────────────────────────────────────────

function readStored(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private windows may refuse storage; the choice lasts this visit.
  }
}

const query = new URLSearchParams(window.location.search);
let language = pickLanguage(readStored(LANGUAGE_KEY), navigator.languages || [navigator.language]);
let channel = normalizeChannel(query.get("channel") || readStored(CHANNEL_KEY));
let platform = detectPlatform({
  userAgent: navigator.userAgent,
  platform: navigator.platform,
  maxTouchPoints: navigator.maxTouchPoints,
  uaData: navigator.userAgentData,
});
let views = {}; // product id -> productView() result (absent while loading)
let loadToken = 0;

// ── i18n ──────────────────────────────────────────────────────────────────

function tr(key, vars) {
  const table = STRINGS[language] || STRINGS.en;
  let value = table[key] ?? STRINGS.en[key] ?? key;
  if (vars) for (const [name, v] of Object.entries(vars)) value = value.split(`{${name}}`).join(String(v));
  return value;
}

/** Text with `code` spans, built as nodes (never innerHTML). URLs in code become links. */
function fillText(node, value) {
  node.textContent = "";
  String(value)
    .split("`")
    .forEach((part, index) => {
      if (!part) return;
      if (index % 2 === 0) {
        node.append(part);
        return;
      }
      const code = document.createElement("code");
      code.textContent = part;
      if (/^https?:\/\//.test(part)) {
        const link = document.createElement("a");
        link.href = part;
        link.className = "link";
        link.append(code);
        node.append(link);
      } else {
        node.append(code);
      }
    });
}

function applyI18n() {
  document.documentElement.lang = language;
  document.title = tr("pageTitle");
  $("language-select").value = language;
  document.querySelectorAll("[data-i18n]").forEach((node) => fillText(node, tr(node.dataset.i18n)));
  document.querySelectorAll("[data-i18n-aria]").forEach((node) => node.setAttribute("aria-label", tr(node.dataset.i18nAria)));
  updateThemeButton();
  render();
}

// ── Theme toggle (the web UI's updateThemeButton) ────────────────────────

function updateThemeButton(mode) {
  const button = $("theme-toggle");
  const theme = window.NHGTheme || null;
  const current = mode || (theme ? theme.mode() : "auto");
  if (button.dataset.mode !== current) {
    button.dataset.mode = current;
    button.innerHTML = ICONS[{ light: "sun", dark: "moon" }[current] || "auto"];
  }
  // "Appearance: Auto · dark at 17:02", as the Desktop's ThemeToggle says it.
  const modeLabel = tr({ light: "themeLight", dark: "themeDark" }[current] || "themeAuto");
  const next = current === "auto" && theme ? theme.nextChange() : null;
  const time = next ? next.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const detail = time ? tr(theme.theme() === "light" ? "themeNextDark" : "themeNextLight").replace("{time}", time) : "";
  const label = `${tr("themeLabel")}: ${modeLabel}${detail ? ` · ${detail}` : ""}`;
  button.title = label;
  button.setAttribute("aria-label", label);
}

// ── Fetching ──────────────────────────────────────────────────────────────

async function fetchManifest(url) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: "no-cache", signal: controller.signal });
    if (response.status === 404) return { status: "missing" };
    if (!response.ok) return { status: "error", error: `HTTP ${response.status}` };
    return { status: "ok", body: await response.text() };
  } catch (error) {
    return { status: "error", error: error && error.name === "AbortError" ? "timeout" : "network_error" };
  } finally {
    window.clearTimeout(timer);
  }
}

/** Loads every product at once; each card fills in as its manifest arrives. */
function load() {
  const token = ++loadToken;
  views = {};
  $("state-offline").hidden = true;
  if (navigator.onLine === false) {
    $("state-offline").hidden = false;
    render();
    return;
  }
  render();
  for (const product of PRODUCTS) loadProduct(product, token);
}

async function loadProduct(product, token) {
  delete views[product.id];
  renderProduct(product);
  const result = await fetchManifest(manifestUrlFor(product, channel));
  if (token !== loadToken) return; // the channel changed meanwhile
  views[product.id] = productView(product, result);
  renderProduct(product);
  resolveNotesLink(product, token);
}

// Release notes: the translated file when there is one (vX.Y.Z.ja.md /
// .en.md), shown on github.com rather than as raw Markdown.
const notesCache = new Map();

async function resolveNotesLink(product, token) {
  const view = views[product.id];
  if (!view || view.kind !== "ready") return;
  const localized = localizedNotesUrl(view.manifest.notesUrl, language);
  if (localized && !notesCache.has(localized)) {
    let ok = false;
    try {
      const response = await fetch(localized, { method: "HEAD", cache: "no-cache" });
      ok = response.ok;
    } catch {
      ok = false;
    }
    notesCache.set(localized, ok);
    if (token !== loadToken) return;
  }
  renderNotesLink(product);
}

function renderNotesLink(product) {
  const view = views[product.id];
  const link = card(product).querySelector('[data-role="notes"]');
  const original = view && view.kind === "ready" ? view.manifest.notesUrl : "";
  const localized = localizedNotesUrl(original, language);
  const href = renderedUrl(localized && notesCache.get(localized) ? localized : original);
  if (href) link.href = href;
  else link.removeAttribute("href");
}

// ── Rendering ─────────────────────────────────────────────────────────────

const card = (product) => $(`product-${product.id}`);
const role = (node, name) => node.querySelector(`[data-role="${name}"]`);

function render() {
  updateChannelControl();
  // The product that suits this device goes first and is marked.
  const recommended = recommendedProduct(platform);
  const container = $("products");
  const ordered = [...PRODUCTS].sort((a, b) => (a.id === recommended ? -1 : b.id === recommended ? 1 : 0));
  for (const product of ordered) container.append(card(product));
  $("ios-note").hidden = platform.os !== "ios";
  // Nothing to migrate on a phone.
  $("migrate-panel").hidden = platform.os === "android" || platform.os === "ios";
  setCommand("py-stop", "python3 scripts/stop.py");
  renderPhoneQr();
  for (const product of PRODUCTS) renderProduct(product);
  openInstructions();
}

function renderProduct(product) {
  const node = card(product);
  const view = views[product.id];
  const offline = !$("state-offline").hidden;
  const isRecommended = recommendedProduct(platform) === product.id;
  role(node, "badge").hidden = !isRecommended;
  node.classList.toggle("is-recommended", isRecommended);
  role(node, "loading").hidden = Boolean(view) || offline;
  role(node, "coming").hidden = !view || view.kind !== "coming";
  role(node, "error").hidden = !view || view.kind !== "error";
  role(node, "ready").hidden = !view || view.kind !== "ready";
  role(node, "version").textContent = view && view.kind === "ready" ? ` · ${tr("versionLabel")} ${view.manifest.version}` : "";
  if (view && view.kind === "error") role(node, "error-detail").textContent = view.error;
  if (view && view.kind === "ready") renderReady(product, node, view.manifest);
  renderCommands(product, view && view.kind === "ready" ? view.manifest : null);
}

function renderReady(product, node, manifest) {
  // Only the product meant for this device gets the big buttons; the others
  // still highlight the visitor's row in their list.
  const pick = pickAssets(platform, manifest.assets);
  const isRecommended = recommendedProduct(platform) === product.id;
  const primary = isRecommended || product.id === "headless" ? pick.primary : [];
  const actions = role(node, "primary");
  actions.textContent = "";
  primary.forEach((key, index) => actions.append(downloadLink(key, manifest.assets[key], index === 0 && isRecommended)));
  actions.hidden = primary.length === 0;

  const notice = role(node, "notice");
  const noticeKey = isRecommended ? { mac_arch: "macArchNote", not_built: "notBuiltNote" }[pick.notice] : null;
  notice.hidden = !noticeKey;
  if (noticeKey) fillText(notice, tr(noticeKey));

  const list = role(node, "assets");
  list.textContent = "";
  for (const key of product.keys) list.append(assetRow(key, manifest.assets[key], manifest.version, primary.includes(key)));
  if (product.keys.length === 1 && primary.length) list.hidden = true;
  else list.hidden = false;
  // The list carries each build's scan badge; when it is hidden (Pocket on
  // Android), the badge goes beside the big button instead.
  if (list.hidden) for (const key of primary) appendScanBadge(actions, manifest.assets[key]);

  role(node, "release").href = releasePageUrl(product.id, manifest.version);
  renderNotesLink(product);
}

function downloadLink(key, asset, primary) {
  const link = document.createElement("a");
  link.className = `button${primary ? " primary large" : " large"}`;
  link.href = asset.url;
  link.setAttribute("download", "");
  link.innerHTML = ICONS.download;
  link.append(primary ? tr("downloadFor", { platform: tr(`platform.${key}`) }) : tr("alsoFor", { platform: tr(`platform.${key}`) }));
  return link;
}

function assetRow(key, asset, version, recommended) {
  const row = document.createElement("li");
  row.className = `asset-row${recommended ? " recommended" : ""}${asset ? "" : " missing"}`;

  const info = document.createElement("div");
  info.className = "asset-info";
  const name = document.createElement("strong");
  name.textContent = tr(`platform.${key}`);
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = asset ? [version, formatSize(asset.size), fileNameFromUrl(asset.url)].join(" · ") : tr("notBuilt");
  info.append(name, meta);
  if (asset) appendScanBadge(info, asset);
  if (asset) info.append(shaRow(asset.sha256, tr("copySha", { platform: tr(`platform.${key}`) })));
  row.append(info);

  if (asset) {
    const link = document.createElement("a");
    link.className = "button";
    link.href = asset.url;
    link.setAttribute("download", "");
    link.setAttribute("aria-label", `${tr("download")}: ${tr(`platform.${key}`)}`);
    link.innerHTML = ICONS.download;
    link.append(tr("download"));
    row.append(link);
  }
  return row;
}

/** "Scanned by VirusTotal" linking to the report; nothing when the manifest has no scan. */
function appendScanBadge(parent, asset) {
  const badge = virusTotalBadge(asset);
  if (!badge) return;
  const link = document.createElement("a");
  link.className = `scan-badge ${badge.tone}`;
  link.href = badge.href;
  link.target = "_blank";
  link.rel = "noopener";
  link.title = tr(badge.titleKey, badge.vars);
  link.innerHTML = ICONS.shield;
  link.append(tr(badge.labelKey, badge.vars));
  parent.append(link);
}

// The page's own address as a QR code, so a phone can open it (computers only).
let qrRendered = "";
function renderPhoneQr() {
  const panel = $("phone-qr");
  const href = showsPhoneQr(platform) ? phoneQrUrl(window.location.href) : "";
  panel.hidden = !href;
  if (!href) return;
  const key = `${href}|${language}`;
  if (qrRendered === key) return;
  qrRendered = key;
  try {
    $("phone-qr-code").innerHTML = qrSvg(href, { label: tr("qrLabel") });
  } catch {
    panel.hidden = true; // an address too long for the encoder: no code
  }
}

function shaRow(sha256, copyLabel) {
  const wrap = document.createElement("div");
  wrap.className = "sha";
  const label = document.createElement("span");
  label.className = "sha-label";
  label.textContent = "SHA-256";
  const value = document.createElement("code");
  value.className = "mono sha-value";
  value.textContent = sha256;
  wrap.append(label, value, copyButton(sha256, copyLabel));
  return wrap;
}

function copyButton(textToCopy, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-button copy-button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = ICONS.copy;
  button.addEventListener("click", async () => {
    const ok = await copyText(textToCopy);
    toast(tr(ok ? "copied" : "copyFailed"));
    if (ok) {
      button.innerHTML = ICONS.check;
      window.setTimeout(() => (button.innerHTML = ICONS.copy), 1400);
    }
  });
  return button;
}

async function copyText(value) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the selection fallback.
  }
  try {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.className = "offscreen";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

let toastTimer = 0;
function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (node.hidden = true), 1800);
}

function setCommand(name, command) {
  document.querySelectorAll(`[data-cmd="${name}"]`).forEach((node) => {
    node.textContent = "";
    const code = document.createElement("code");
    code.className = "mono";
    code.textContent = command;
    node.append(code, copyButton(command, tr("copyCommand")));
  });
}

function renderCommands(product, manifest) {
  const fileFor = (keys) => {
    const key = keys.find((k) => manifest && manifest.assets[k]) || keys[0];
    return manifest && manifest.assets[key] ? fileNameFromUrl(manifest.assets[key].url, key) : null;
  };
  if (product.id === "studio") {
    const appImage = shellQuote(fileFor(["linux-x64"]) || "NH-Studio-*.AppImage").replace(/'(NH-Studio-\*\.AppImage)'/, "$1");
    setCommand("studio-linux", `chmod +x ${appImage} && ./${appImage}`);
  } else if (product.id === "headless") {
    const macKeys = platform.arch === "x64" ? ["darwin-x64", "darwin-arm64"] : ["darwin-arm64", "darwin-x64"];
    const linuxKeys = platform.arch === "arm64" ? ["linux-arm64", "linux-x64"] : ["linux-x64", "linux-arm64"];
    const mac = shellQuote(fileFor(macKeys) || headlessAssetName(macKeys[0]));
    const linux = shellQuote(fileFor(linuxKeys) || headlessAssetName(linuxKeys[0]));
    const win = fileFor(["win32-x64"]) || headlessAssetName("win32-x64");
    setCommand("mac-chmod", `chmod +x ${mac}`);
    setCommand("mac-xattr", `xattr -d com.apple.quarantine ${mac}`);
    setCommand("mac-run", `./${mac}`);
    setCommand("win-run", `.\\${win}`);
    setCommand("linux-run", `chmod +x ${linux} && ./${linux}`);
    const own = platform.os === "windows" ? `.\\${win}` : `./${platform.os === "linux" ? linux : mac}`;
    setCommand("headless-bench", `${own} --bench`);
  }
}

// Open the visitor's own instructions once; after that the visitor decides.
let openedSection = false;
function openInstructions() {
  if (openedSection) return;
  openedSection = true;
  const section = osSection(platform);
  document.querySelectorAll("details.disclosure[data-os]").forEach((node) => {
    node.open = node.dataset.os === section;
  });
}

function shellQuote(name) {
  return /^[A-Za-z0-9._+-]+$/.test(name) ? name : `'${name.replace(/'/g, "'\\''")}'`;
}

// ── Events ────────────────────────────────────────────────────────────────

function updateChannelControl() {
  document.querySelectorAll("#channel-control button[data-channel]").forEach((button) => {
    const active = button.dataset.channel === channel;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", active ? "true" : "false");
    button.tabIndex = active ? 0 : -1;
  });
  $("channel-hint").hidden = channel !== "beta";
}

function setChannel(next) {
  next = normalizeChannel(next);
  if (next === channel) return;
  channel = next;
  writeStored(CHANNEL_KEY, channel);
  const url = new URL(window.location.href);
  if (channel === "beta") url.searchParams.set("channel", "beta");
  else url.searchParams.delete("channel");
  window.history.replaceState(null, "", url);
  updateChannelControl();
  renderPhoneQr(); // the code follows the address (?channel=beta)
  load();
}

function bind() {
  $("theme-toggle").addEventListener("click", () => window.NHGTheme && window.NHGTheme.cycle());
  $("language-select").addEventListener("change", (event) => {
    language = pickLanguage(event.target.value, []);
    writeStored(LANGUAGE_KEY, language);
    applyI18n();
    for (const product of PRODUCTS) resolveNotesLink(product, loadToken);
  });
  const control = $("channel-control");
  control.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-channel]");
    if (button) setChannel(button.dataset.channel);
  });
  // A radio group: arrow keys move the choice, as native radios do.
  control.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const next = channel === "stable" ? "beta" : "stable";
    setChannel(next);
    control.querySelector(`[data-channel="${next}"]`).focus();
  });
  for (const product of PRODUCTS) {
    role(card(product), "retry").addEventListener("click", () => loadProduct(product, loadToken));
  }
  $("retry-offline").addEventListener("click", load);
  window.addEventListener("online", () => {
    if (!$("state-offline").hidden) load();
  });
}

async function refineArchitecture() {
  // Chromium can say "arm" or "x86" when asked; nothing else can.
  const data = navigator.userAgentData;
  if (!data || typeof data.getHighEntropyValues !== "function") return;
  try {
    const values = await data.getHighEntropyValues(["architecture"]);
    const refined = detectPlatform({
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
      uaData: data,
      architecture: values.architecture,
    });
    if (refined.os !== platform.os || refined.arch !== platform.arch) {
      platform = refined;
      render();
    }
  } catch {
    // Not offered: keep the low-entropy guess.
  }
}

bind();
applyI18n();
if (window.NHGTheme) window.NHGTheme.start((mode) => updateThemeButton(mode));
load();
refineArchitecture();

// Exposed for debugging in the console only.
window.NHGDownload = { platform: () => platform, views: () => views, PLATFORM_OS };
