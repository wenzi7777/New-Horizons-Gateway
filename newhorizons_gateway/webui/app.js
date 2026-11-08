// NH Gateway local WebUI.
//
// Laid out like the Desktop app's Gateway dialog (GatewayManageModal):
// overview cards on top, sections in a sidebar (Overview / LAN devices /
// Connection / Software update). /api/status is polled every 2 s and the
// page is updated in place: text is only written when it changed and list
// rows are kept by key, so nothing is rebuilt (and nothing flashes) unless
// its data did. applyI18n() runs only on load and on a language switch,
// never from refresh().
(function () {
  "use strict";

  const I18N = window.NHG_I18N || { en: {} };
  const PRODUCTION_URL = "__PRODUCTION_URL__";
  const LOCAL_URL = "__LOCAL_URL__";
  const LANGUAGE_KEY = "newhorizons-gateway-language";
  const SECTIONS = ["overview", "devices", "connection", "update"];
  const GATEWAY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
  const POLL_MS = 2000;
  const UPDATE_PROGRESS_PHASES = ["checking", "downloading", "downloaded", "staging", "staged", "switch_pending", "restarting"];

  let language = initialLanguage();
  let lastData = null;
  let targetSettingsDirty = false;
  let setupGatewayIdSuggested = false;
  let wizardStep = 0;
  let wizardMode = "production";
  let formMode = "production";
  let updateLocked = false;
  let inFlight = 0;
  let requestSeq = 0;
  let renderedSeq = 0;
  let unreachable = false;
  // Device actions in flight, "serve:<uid>", so a poll keeps their label.
  const pending = new Set();

  const ICON_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  const THEME_ICON_ATTRS = 'width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  const ICONS = {
    alert: `<svg ${ICON_ATTRS}><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`,
    check: `<svg ${ICON_ATTRS} stroke-width="2.6"><path d="M20 6 9 17l-5-5"/></svg>`,
    x: `<svg ${ICON_ATTRS}><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
    // The theme toggle's three, as the Desktop's ThemeToggle draws them
    // (lucide Sun / Moon / SunMoon at 17 px, stroke 1.8).
    sun: `<svg ${THEME_ICON_ATTRS}><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`,
    moon: `<svg ${THEME_ICON_ATTRS}><path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/></svg>`,
    auto: `<svg ${THEME_ICON_ATTRS}><path d="M12 2v2"/><path d="M14.837 16.385a6 6 0 1 1-7.223-7.222c.624-.147.97.66.715 1.248a4 4 0 0 0 5.26 5.259c.589-.255 1.396.09 1.248.715"/><path d="M16 12a4 4 0 0 0-4-4"/><path d="m19 5-1.256 1.256"/><path d="M20 12h2"/></svg>`,
  };

  // ── Small helpers ───────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (error) { return null; }
  }

  function storageSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (error) { /* private window */ }
  }

  function normalizeLanguage(value) {
    const input = String(value || "").trim().toLowerCase();
    if (input === "ja" || input.startsWith("ja-")) return "ja";
    if (input === "zh" || input.startsWith("zh-cn") || input.startsWith("zh-hans") || input === "zh-sg") return "zh-CN";
    return "en";
  }

  function initialLanguage() {
    const stored = storageGet(LANGUAGE_KEY);
    if (stored) return normalizeLanguage(stored);
    const candidates = Array.isArray(navigator.languages) && navigator.languages.length ? navigator.languages : [navigator.language];
    return normalizeLanguage(candidates[0]);
  }

  function tr(key) {
    return (I18N[language] && I18N[language][key]) || (I18N.en && I18N.en[key]) || key;
  }

  function fmt(key, values) {
    let template = tr(key);
    Object.entries(values || {}).forEach(([name, value]) => {
      template = template.split(`{${name}}`).join(value === undefined || value === null || value === "" ? "-" : String(value));
    });
    return template;
  }

  function el(target) {
    return typeof target === "string" ? $(target) : target;
  }

  function setText(target, value, fallback = "-") {
    const node = el(target);
    if (!node) return;
    const text = value === undefined || value === null || value === "" ? fallback : String(value);
    if (node.textContent !== text) node.textContent = text;
  }

  function show(target, visible) {
    const node = el(target);
    if (node && node.hidden === Boolean(visible)) node.hidden = !visible;
  }

  function setClass(target, className) {
    const node = el(target);
    if (node && node.className !== className) node.className = className;
  }

  function setDisabled(target, disabled) {
    const node = el(target);
    if (node && node.disabled !== Boolean(disabled)) node.disabled = Boolean(disabled);
  }

  function setAttr(target, name, value) {
    const node = el(target);
    if (node && node.getAttribute(name) !== value) node.setAttribute(name, value);
  }

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([key, value]) => {
      if (value === undefined || value === null || value === false) return;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "hidden" || key === "disabled") node[key] = Boolean(value);
      else node.setAttribute(key, value === true ? "" : String(value));
    });
    children.flat().forEach((child) => {
      if (child === undefined || child === null || child === false) return;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return node;
  }

  // Keeps one DOM node per key in `container`, in `items` order: existing
  // nodes are updated in place, so hover/focus survive a poll.
  function syncList(container, items, keyOf, create, update) {
    if (!container) return;
    const existing = new Map();
    Array.from(container.children).forEach((node) => existing.set(node.dataset.key, node));
    let previous = null;
    items.forEach((item) => {
      const key = String(keyOf(item));
      let node = existing.get(key);
      if (node) existing.delete(key);
      else {
        node = create(item);
        node.dataset.key = key;
      }
      update(node, item);
      const anchor = previous ? previous.nextSibling : container.firstChild;
      if (node !== anchor) container.insertBefore(node, anchor);
      previous = node;
    });
    existing.forEach((node) => node.remove());
  }

  function field(node, name) {
    return node.querySelector(`[data-f="${name}"]`);
  }

  function displayVersion(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    return /^v/i.test(text) ? text : `v${text}`;
  }

  function hostOf(url) {
    try { return new URL(url).host || url; } catch (error) { return url || ""; }
  }

  function formatTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const today = new Date();
    return date.toDateString() === today.toDateString()
      ? date.toLocaleTimeString(language)
      : date.toLocaleString(language);
  }

  function targetLabel(mode) {
    return tr({ local: "targetLocal", manual: "targetManual" }[mode] || "targetProduction");
  }

  function errorText(error) {
    const code = String((error && (error.code || error.message)) || "error");
    const key = `err_${code}`;
    return tr(key) !== key ? tr(key) : fmt("errGeneric", { error: code });
  }

  // ── Localized update vocabulary ─────────────────────────────────────────
  function localizeSource(value) {
    const source = String(value || "").trim();
    if (source === "server_ws") return tr("sourceServerWs");
    if (source === "manifest") return tr("sourceManifest");
    return source || "-";
  }

  function localizePhaseCode(value) {
    const phase = String(value || "").trim();
    const keyMap = {
      idle: "phaseIdle", checking: "phaseChecking", checked: "phaseChecked",
      downloading: "phaseDownloading", downloaded: "phaseDownloaded", staging: "phaseStaging",
      staged: "phaseStaged", switch_pending: "phaseSwitchPending", restarting: "phaseRestarting", error: "phaseError",
    };
    return keyMap[phase] ? tr(keyMap[phase]) : (phase || "-");
  }

  function localizeProgressPhase(value) {
    const phase = String(value || "").trim();
    const keyMap = {
      idle: "phaseIdle", checking: "progressChecking", checked: "phaseChecked",
      downloading: "progressDownloading", downloaded: "progressDownloaded", staging: "progressStaging",
      staged: "progressStaged", switch_pending: "progressSwitching", restarting: "phaseRestarting", error: "progressFailed",
    };
    return keyMap[phase] ? tr(keyMap[phase]) : (phase || tr("phaseIdle"));
  }

  function localizeBootPhase(value) {
    const phase = String(value || "").trim();
    const keyMap = { idle: "bootIdle", pending_switch: "bootPendingSwitch", rolled_back: "bootRolledBack" };
    return keyMap[phase] ? tr(keyMap[phase]) : (phase || "-");
  }

  function localizeClaimState(value) {
    const state = String(value || "").trim();
    const keyMap = { created: "claimStateCreated", attached: "claimStateAttached", failed: "claimStateFailed", timeout: "claimStateTimeout" };
    return keyMap[state] ? tr(keyMap[state]) : (state || "-");
  }

  // ── API ─────────────────────────────────────────────────────────────────
  async function api(path, options) {
    const response = await fetch(path, Object.assign({ cache: "no-store" }, options || {}));
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      const error = new Error(payload.error || payload.message || response.statusText || "error");
      error.code = payload.error || payload.message || "";
      throw error;
    }
    return payload;
  }

  function post(path, body) {
    return api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  }

  // ── Feedback: toast, confirm dialog, busy buttons ──────────────────────
  let toastTimer = 0;

  function toast(message, kind = "success") {
    const old = document.querySelector(".toast");
    if (old) old.remove();
    const icon = h("span", { class: "toast-icon" });
    icon.innerHTML = kind === "error" ? ICONS.x : ICONS.check;
    const close = h("button", { class: "toast-close", type: "button", "aria-label": tr("close") });
    close.innerHTML = ICONS.x;
    const node = h("div", { class: `toast ${kind}`, role: kind === "error" ? "alert" : "status" }, icon, h("span", { class: "toast-text", text: message }), close);
    close.addEventListener("click", () => node.remove());
    document.body.appendChild(node);
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => node.remove(), kind === "error" ? 7000 : 4000);
  }

  // Resolves true on confirm. Esc or a click outside cancels; Enter presses
  // the focused button (the confirm button has focus to begin with).
  function confirmDialog({ title, message, confirmLabel, destructive = false }) {
    return new Promise((resolve) => {
      const previous = document.activeElement;
      const icon = h("div", { class: "modal-icon" });
      icon.innerHTML = ICONS.alert;
      const cancel = h("button", { class: "button", type: "button", text: tr("cancel") });
      const confirm = h("button", { class: `button ${destructive ? "danger-solid" : "primary"}`, type: "button", text: confirmLabel });
      const panel = h(
        "div",
        { class: "modal-panel confirm-modal-panel", role: "alertdialog", "aria-modal": "true", "aria-label": title },
        icon,
        h("h3", { text: title }),
        message ? h("p", { text: message }) : null,
        h("div", { class: "actions" }, cancel, confirm),
      );
      const backdrop = h("div", { class: "modal-backdrop top" }, panel);

      function finish(result) {
        document.removeEventListener("keydown", onKey, true);
        backdrop.remove();
        if (previous && typeof previous.focus === "function") previous.focus();
        resolve(result);
      }

      function onKey(event) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(false);
        } else if (event.key === "Tab") {
          event.preventDefault();
          (document.activeElement === confirm ? cancel : confirm).focus();
        }
      }

      backdrop.addEventListener("click", (event) => { if (event.target === backdrop) finish(false); });
      cancel.addEventListener("click", () => finish(false));
      confirm.addEventListener("click", () => finish(true));
      document.addEventListener("keydown", onKey, true);
      document.body.appendChild(backdrop);
      confirm.focus();
    });
  }

  // Runs `task` with `button` showing "Running…"; puts it back afterwards.
  async function withBusy(button, task) {
    if (!button || button.dataset.busy) return undefined;
    button.dataset.busy = "1";
    button.disabled = true;
    button.textContent = tr("running");
    try {
      return await task();
    } finally {
      delete button.dataset.busy;
      button.disabled = false;
      if (button.dataset.i18n) button.textContent = tr(button.dataset.i18n);
      if (lastData) render(lastData);
      else applyLock();
    }
  }

  // Release notes in the UI language (the Gateway downloads the .ja/.en
  // translations beside the original), else the Traditional Chinese
  // original, rendered as Markdown. Re-rendered only when the text changes.
  function notesFor(st) {
    const translations = st.notes_markdown_i18n || {};
    const key = language === "ja" ? "ja" : language === "en" ? "en" : "";
    return (key && translations[key]) || st.notes_markdown || "";
  }

  function renderNotes(id, st) {
    const node = $(id);
    if (!node) return;
    const source = notesFor(st);
    if (node.dataset.source === source && node.dataset.lang === language) return;
    node.dataset.source = source;
    node.dataset.lang = language;
    node.replaceChildren();
    if (!source) {
      const empty = document.createElement("p");
      empty.className = "notes-empty";
      empty.textContent = tr("noReleaseNotes");
      node.appendChild(empty);
      return;
    }
    node.appendChild(window.renderMarkdown(source));
  }

  function showFieldError(id, message) {
    setText(id, message, "");
    show(id, Boolean(message));
  }

  // ── i18n and theme ──────────────────────────────────────────────────────
  function applyI18n() {
    document.documentElement.lang = language;
    $("language-select").value = language;
    document.querySelectorAll("[data-i18n]").forEach((node) => {
      if (!node.dataset.busy) node.textContent = tr(node.dataset.i18n);
    });
    document.querySelectorAll("[data-i18n-aria]").forEach((node) => {
      node.setAttribute("aria-label", tr(node.dataset.i18nAria));
    });
    updateThemeButton();
  }

  function updateThemeButton(mode) {
    const button = $("theme-toggle");
    const current = mode || (window.NHGTheme ? window.NHGTheme.mode() : "auto");
    if (button.dataset.mode !== current) {
      button.dataset.mode = current;
      button.innerHTML = ICONS[{ light: "sun", dark: "moon" }[current] || "auto"];
    }
    // "Appearance: Auto · dark at 17:02", as the Desktop's ThemeToggle says it.
    const theme = window.NHGTheme ? window.NHGTheme : null;
    const modeLabel = tr({ light: "themeLight", dark: "themeDark" }[current] || "themeAuto");
    const next = current === "auto" && theme ? theme.nextChange() : null;
    const time = next ? next.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    const detail = time ? tr(theme.theme() === "light" ? "themeNextDark" : "themeNextLight").replace("{time}", time) : "";
    const label = `${tr("themeLabel")}: ${modeLabel}${detail ? ` · ${detail}` : ""}`;
    button.title = label;
    button.setAttribute("aria-label", label);
  }

  // ── Sections ────────────────────────────────────────────────────────────
  function sectionFromHash() {
    const id = String(window.location.hash || "").replace(/^#/, "");
    return SECTIONS.includes(id) ? id : "overview";
  }

  function showSection(id) {
    document.querySelectorAll("[data-section-panel]").forEach((panel) => show(panel, panel.dataset.sectionPanel === id));
    document.querySelectorAll("#section-nav [data-section]").forEach((button) => {
      const active = button.dataset.section === id;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
  }

  function goTo(id) {
    if (sectionFromHash() === id) showSection(id);
    else window.location.hash = id;
  }

  // ── Rendering ───────────────────────────────────────────────────────────
  const STATUS_TEXT = { online: "statusOnline", offline: "statusOffline", disabled: "statusDisabled", setup: "statusSetup", unreachable: "statusUnreachable" };

  function gatewayStatus(data) {
    const config = data.config || {};
    if (!String(config.gateway_id || "").trim()) return "setup";
    if (!config.enabled) return "disabled";
    return data.upstream && data.upstream.connected ? "online" : "offline";
  }

  // The Gateway's own server stopped answering (restarting or gone): the
  // overview's status card says so; the rest keeps the last view.
  function renderUnreachable() {
    setClass("card-status-dot", "status-dot offline");
    setText("card-status", tr(STATUS_TEXT.unreachable));
  }

  function render(data) {
    lastData = data;
    const config = data.config || {};
    const hasGatewayId = Boolean(String(config.gateway_id || "").trim());
    setText("app-version", displayVersion(data.version), "");
    show("setup-wizard", !hasGatewayId);
    show("dashboard", hasGatewayId);
    renderUpdate(data.update_state || {});
    if (!hasGatewayId) {
      updateWizardPreview();
      return;
    }
    wizardStep = 0;
    renderOverview(data);
    renderDevices(data);
    syncTargetSettings(config);
    updateConnectionForm();
  }

  function renderOverview(data) {
    const config = data.config || {};
    const upstream = data.upstream || {};
    const state = data.state || {};
    const update = data.update_state || {};
    const status = gatewayStatus(data);
    const serving = (state.devices || []).filter((item) => item.connected);
    const idleNearby = (state.nearby_devices || []).filter((item) => !item.serving && !item.denied);

    setClass("card-status-dot", `status-dot ${status}`);
    setText("card-status", tr(STATUS_TEXT[status]));
    setText("card-status-sub", status === "disabled" ? tr("statusDisabledSub") : hostOf(upstream.server_url || config.server_url));

    setText("card-version", displayVersion(update.current_version || data.version));
    const latest = displayVersion(update.latest_gateway_version || update.latest_version);
    const versionSub = $("card-version-sub");
    if (update.required_update) {
      setText(versionSub, fmt("updateRequiredShort", { version: latest }));
      setClass(versionSub, "accent");
    } else if (update.update_available) {
      setText(versionSub, fmt("updateAvailable", { version: displayVersion(update.latest_version || update.latest_gateway_version) }));
      setClass(versionSub, "accent");
    } else {
      setText(versionSub, update.last_checked_at ? tr("upToDateShort") : tr("updateNotChecked"));
      setClass(versionSub, "");
    }

    setText("card-target", targetLabel(config.target_mode));
    setText("card-target-sub", `FindMe ${config.listen_discovery_port || "-"} · UDP ${config.listen_udp_port || "-"}`);
    setText("card-serving", String(serving.length));
    setText("card-serving-sub", fmt("nearbyCount", { count: idleNearby.length }));

    show("overview-disabled", !config.enabled);
    const upstreamError = config.enabled && !upstream.connected ? String(upstream.last_error || "") : "";
    setText("overview-upstream-error", upstreamError ? fmt("upstreamErrorNotice", { error: upstreamError }) : "", "");
    show("overview-upstream-error", Boolean(upstreamError));

    setText("fact-gateway-id", config.gateway_id);
    setText("fact-server", upstream.server_url || config.server_url);
    setText("fact-ports", `FindMe ${config.listen_discovery_port || "-"} · UDP ${config.listen_udp_port || "-"}`);
    setText("fact-traffic", fmt("trafficValue", { in: Number(upstream.udp_in_fps || 0), out: Number(upstream.upstream_sent_fps || 0) }));
    setText("fact-queue-dropped", String(Number(upstream.data_queue_dropped || 0)));
    setText("fact-remote", tr(config.remote_management === false ? "remoteOff" : "remoteOn"));

    syncList($("overview-serving"), serving, (item) => item.device_uid, () => h("span", { class: "chip" }), (node, item) => {
      setText(node, deviceName(item));
    });
    show("overview-serving-empty", !serving.length);

    const badge = $("nav-devices-badge");
    setText(badge, String(idleNearby.length));
    show(badge, idleNearby.length > 0);
    show("nav-connection-dot", !config.enabled);
  }

  function deviceName(item) {
    return item.device_name && item.device_name !== item.device_uid ? item.device_name : item.device_uid;
  }

  function createDeviceRow() {
    return h(
      "li",
      { class: "device-row" },
      h(
        "div",
        { class: "device-main" },
        h("div", { class: "device-title" }, h("strong", { "data-f": "name" }), h("span", { class: "tag", "data-f": "tag", hidden: true })),
        h("span", { class: "device-uid mono", "data-f": "uid" }),
        h("span", { class: "device-detail", "data-f": "detail" }),
      ),
      h("div", { class: "actions", "data-f": "actions" }),
    );
  }

  function updateDeviceRow(row, item, details, tag, actions) {
    const name = deviceName(item);
    setText(field(row, "name"), name);
    setText(field(row, "uid"), name === item.device_uid ? "" : item.device_uid, "");
    show(field(row, "uid"), name !== item.device_uid);
    setText(field(row, "detail"), details.filter(Boolean).join(" · "), "");
    const tagNode = field(row, "tag");
    show(tagNode, Boolean(tag));
    if (tag) {
      setText(tagNode, tag.text);
      setClass(tagNode, `tag ${tag.kind}`);
      setAttr(tagNode, "title", tag.title || "");
    }
    syncActions(field(row, "actions"), item.device_uid, actions);
  }

  function syncActions(container, uid, specs) {
    const signature = specs.map((spec) => `${spec.action}:${spec.cls}`).join(",");
    if (container.dataset.sig !== signature) {
      container.replaceChildren(...specs.map((spec) => h("button", {
        type: "button",
        class: `button ${spec.cls}`,
        "data-action": spec.action,
        "data-uid": uid,
      })));
      container.dataset.sig = signature;
    }
    specs.forEach((spec, index) => {
      const button = container.children[index];
      const running = pending.has(`${spec.action}:${uid}`);
      setText(button, running ? tr("running") : tr(spec.label));
      setDisabled(button, running || updateLocked || Boolean(spec.disabled));
      setAttr(button, "title", spec.disabled && spec.why ? spec.why : "");
    });
  }

  function recentClaimFailure(claims, uid) {
    const claim = claims.find((item) => String(item.device_uid || "").toUpperCase() === uid);
    if (!claim || !["failed", "timeout"].includes(claim.state)) return null;
    const at = Date.parse(claim.updated_at || claim.requested_at || "");
    if (Number.isFinite(at) && Date.now() - at > 120000) return null;
    return claim;
  }

  function renderDevices(data) {
    const config = data.config || {};
    const state = data.state || {};
    const online = Boolean(data.upstream && data.upstream.connected);
    const serving = (state.devices || []).filter((item) => item.connected);
    const nearby = state.nearby_devices || [];
    const nearbyByUid = new Map(nearby.map((item) => [item.device_uid, item]));
    const idle = nearby.filter((item) => !item.serving && !item.denied);
    const denied = (state.denied_devices || []).map((uid) => nearbyByUid.get(uid) || { device_uid: uid });
    const claims = state.claims || [];

    show("devices-locked", updateLocked);
    show("devices-offline", !updateLocked && Boolean(config.enabled) && !online && idle.length > 0);

    syncList($("serving-list"), serving, (item) => item.device_uid, createDeviceRow, (row, item) => {
      updateDeviceRow(row, item, [
        item.mode,
        typeof item.wifi_rssi === "number" ? `${item.wifi_rssi} dBm` : "",
        fmt("detailPackets", { packets: Number(item.udp_packets || 0), dropped: Number(item.udp_dropped || 0) }),
      ], null, [{ action: "reject", label: "deny", cls: "tiny danger" }]);
    });
    show("serving-empty", !serving.length);

    syncList($("nearby-list"), idle, (item) => item.device_uid, createDeviceRow, (row, item) => {
      let tag = null;
      if (item.claim_state && item.claim_state !== "attached") {
        tag = { kind: "waiting", text: tr("claimPending") };
      } else {
        const failure = recentClaimFailure(claims, item.device_uid);
        if (failure) tag = { kind: "danger", text: tr("claimFailed"), title: failure.last_error || failure.state };
      }
      updateDeviceRow(row, item, [
        item.mode,
        item.addr,
        typeof item.wifi_rssi === "number" ? `${item.wifi_rssi} dBm` : "",
        item.last_findme_at ? fmt("lastSeenAt", { time: formatTime(item.last_findme_at) }) : "",
      ], tag, [
        { action: "serve", label: "serve", cls: "tiny primary", disabled: !online, why: tr("upstreamOfflineNotice") },
        { action: "reject", label: "deny", cls: "tiny" },
      ]);
    });
    show("nearby-empty", !idle.length);

    syncList($("denied-list"), denied, (item) => item.device_uid, createDeviceRow, (row, item) => {
      updateDeviceRow(row, item, [item.mode, item.addr], null, [{ action: "allow", label: "allow", cls: "tiny" }]);
    });
    show("denied-empty", !denied.length);

    syncList($("claim-body"), claims, (item) => item.claim_id || `${item.device_uid}-${item.requested_at}`, () => h(
      "tr",
      {},
      h("td", { "data-f": "time" }),
      h("td", { class: "mono", "data-f": "uid" }),
      h("td", { class: "mono", "data-f": "claim" }),
      h("td", { "data-f": "state" }),
      h("td", { class: "muted", "data-f": "error" }),
    ), (row, item) => {
      setText(field(row, "time"), formatTime(item.updated_at || item.requested_at));
      setText(field(row, "uid"), item.device_uid);
      setText(field(row, "claim"), item.claim_id);
      setText(field(row, "state"), localizeClaimState(item.state));
      setText(field(row, "error"), item.last_error, "");
    });
    show("claims-empty", !claims.length);
  }

  // ── Connection form ─────────────────────────────────────────────────────
  function setSegment(container, mode) {
    container.querySelectorAll("button[data-mode]").forEach((button) => {
      const active = button.dataset.mode === mode;
      button.classList.toggle("active", active);
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", active ? "true" : "false");
    });
  }

  function resolveUrl(mode, manual) {
    if (mode === "local") return LOCAL_URL;
    if (mode === "manual") return String(manual || "").trim();
    return PRODUCTION_URL;
  }

  function resolveTargetServerUrl() {
    return resolveUrl(formMode, $("manual-url").value);
  }

  function updateTargetServerSummary() {
    setText("effective-server", resolveTargetServerUrl());
  }

  // Polling never overwrites what the user is editing.
  function syncTargetSettings(config) {
    if (targetSettingsDirty) return;
    const idInput = $("gateway-id-input");
    if (idInput.value !== (config.gateway_id || "")) idInput.value = config.gateway_id || "";
    formMode = config.target_mode || "production";
    setSegment($("target-mode"), formMode);
    const manual = $("manual-url");
    if (manual.value !== (config.manual_url || "")) manual.value = config.manual_url || "";
    $("gateway-enabled").checked = Boolean(config.enabled);
    $("remote-management").checked = config.remote_management !== false;
  }

  function validateGatewayId(value) {
    const id = String(value || "").trim();
    if (!id) return tr("err_gateway_id_required");
    if (!GATEWAY_ID_PATTERN.test(id)) return tr("err_gateway_id_invalid");
    return "";
  }

  function validateManualUrl(mode, value) {
    if (mode !== "manual") return "";
    return /^wss?:\/\//i.test(String(value || "").trim()) ? "" : tr("err_invalid_manual_url");
  }

  function updateConnectionForm() {
    show("manual-url-field", formMode === "manual");
    updateTargetServerSummary();
    const idError = targetSettingsDirty ? validateGatewayId($("gateway-id-input").value) : "";
    const urlError = targetSettingsDirty ? validateManualUrl(formMode, $("manual-url").value) : "";
    showFieldError("gateway-id-error", idError);
    showFieldError("manual-url-error", urlError);
    $("gateway-id-input").classList.toggle("invalid", Boolean(idError));
    $("manual-url").classList.toggle("invalid", Boolean(urlError));
    show("settings-dirty", targetSettingsDirty);
    show("revert-settings", targetSettingsDirty);
    const save = $("save-settings");
    if (!save.dataset.busy) setDisabled(save, updateLocked || !targetSettingsDirty || Boolean(idError || urlError));
    setDisabled("auto-gateway-id", updateLocked);
    setDisabled("revert-settings", updateLocked);
  }

  function markDirty() {
    targetSettingsDirty = true;
    show("settings-message", false);
    updateConnectionForm();
  }

  async function saveSettings() {
    show("settings-message", false);
    await withBusy($("save-settings"), async () => {
      try {
        const payload = await post("/api/settings", {
          target_mode: formMode,
          manual_url: $("manual-url").value.trim(),
          gateway_id: $("gateway-id-input").value.trim(),
          enabled: $("gateway-enabled").checked,
          remote_management: $("remote-management").checked,
        });
        // Re-render from the saved config, not the last poll's (no flicker
        // back to the old values before the next poll lands).
        if (payload.config && lastData) lastData.config = payload.config;
        targetSettingsDirty = false;
        toast(tr("savedReconnecting"));
      } catch (error) {
        setText("settings-message", errorText(error));
        show("settings-message", true);
      }
    });
    refresh();
  }

  async function suggestGatewayId() {
    const payload = await post("/api/gateway-id/suggest");
    return String(payload.gateway_id || "");
  }

  // ── Software update ─────────────────────────────────────────────────────
  function setProgress(fillId, labelId, pct) {
    const value = Math.max(0, Math.min(100, Number(pct || 0)));
    const fill = $(fillId);
    if (fill && fill.style.width !== `${value}%`) fill.style.width = `${value}%`;
    setText(labelId, `${value}%`);
  }

  function renderUpdate(st) {
    const current = displayVersion(st.current_version);
    const serverLatest = displayVersion(st.latest_gateway_version);
    const manifestLatest = displayVersion(st.latest_version);
    const required = Boolean(st.required_update);
    const available = Boolean(st.update_available);
    const updating = Boolean(st.busy);
    const phase = st.phase || "idle";
    const latest = required ? (serverLatest || manifestLatest) : (manifestLatest || serverLatest);
    const healthyUpdateCenter = !required && !st.last_error && (!serverLatest || serverLatest === current);
    const canStartUpdate = !updating && (required || available);
    const showProgress = updating || UPDATE_PROGRESS_PHASES.includes(phase);

    setText("current-version-label", current);
    setText("latest-version-label", latest || (st.last_checked_at ? current : ""));
    setClass("update-center", `settings-card update-status update-center${healthyUpdateCenter ? " ok" : ""}`);

    let bannerKind = "";
    let banner = tr("updateNotChecked");
    if (updating) banner = localizeProgressPhase(phase);
    else if (st.last_error) { bannerKind = "error"; banner = fmt("updateCheckFailed", { error: st.last_error }); }
    else if (required) { bannerKind = "error"; banner = fmt("updateRequiredShort", { version: latest }); }
    else if (available) { bannerKind = "available"; banner = fmt("updateAvailable", { version: latest }); }
    else if (st.last_checked_at) { bannerKind = "ok"; banner = tr("upToDate"); }
    setClass("update-banner", `update-status-line ${bannerKind}`.trim());
    setText("update-banner", banner);

    for (const id of ["start-update", "overlay-start-update"]) {
      const button = $(id);
      if (button.dataset.busy) continue;
      setText(button, updating ? tr("updating") : tr("updateNow"));
      setDisabled(button, !canStartUpdate);
    }
    setClass("start-update", `button${canStartUpdate ? " primary" : ""}`);
    for (const id of ["check-update", "overlay-check-update", "restart-gateway", "overlay-restart-gateway"]) {
      if (!$(id).dataset.busy) setDisabled(id, updating);
    }

    show("update-progress-wrap", showProgress);
    show("overlay-progress-wrap", showProgress);
    setText("update-progress-phase", localizeProgressPhase(phase));
    setText("overlay-update-progress-phase", localizeProgressPhase(phase));
    setProgress("update-progress", "update-progress-label", st.progress_pct);
    setProgress("overlay-update-progress", "overlay-update-progress-label", st.progress_pct);
    show("restart-row", Boolean(st.restart_required) && !updating);
    show("overlay-restart-gateway", Boolean(st.restart_required));

    const channel = $("update-channel");
    if (document.activeElement !== channel && !channel.dataset.busy) channel.value = st.update_channel === "beta" ? "beta" : "stable";
    setText("channel-hint", tr(st.update_channel === "beta" ? "channelBetaActive" : "channelHint"));

    renderNotes("update-notes", st);
    renderNotes("overlay-update-notes", st);

    setText("server-latest-version", serverLatest);
    setText("manifest-latest-version", manifestLatest);
    setText("update-source", localizeSource(st.update_signal_source));
    setText("update-phase", localizePhaseCode(phase));
    setText("active-slot-version", st.active_slot ? `${st.active_slot} · ${current || "-"}` : "");
    setText("pending-slot-version", st.pending_slot ? `${st.pending_slot} · ${displayVersion(st.target_version) || "-"}` : "");
    const boot = localizeBootPhase(st.boot_phase || "idle");
    setText("boot-phase-label", st.rollback_reason ? `${boot} (${st.rollback_reason})` : boot);
    setText("last-update-check", formatTime(st.last_checked_at));
    setText("auto-check-interval", st.auto_check_interval_sec ? fmt("everySeconds", { seconds: Number(st.auto_check_interval_sec) }) : "");

    const navDot = $("nav-update-dot");
    show(navDot, required || available);
    setClass(navDot, `nav-dot${required ? " warning" : ""}`);

    // The required-update dialog.
    const overlay = $("update-required-overlay");
    const opening = overlay.hidden && required;
    setText("overlay-current-version", current);
    setText("overlay-server-latest", serverLatest || manifestLatest);
    let overlayKind = "notice";
    let overlayBanner = tr("overlayIdleHint");
    if (updating) overlayBanner = localizeProgressPhase(phase);
    else if (st.last_error) { overlayKind = "notice error"; overlayBanner = fmt("updateCheckFailed", { error: st.last_error }); }
    setClass("overlay-update-banner", overlayKind);
    setText("overlay-update-banner", overlayBanner);
    setGatewayLock(required);
    if (opening) $("overlay-start-update").focus();
  }

  // While an update is required the server refuses settings and device
  // changes (409 update_required); the page says so and disables them.
  function setGatewayLock(locked) {
    updateLocked = Boolean(locked);
    show("update-required-overlay", updateLocked);
    $("topbar").inert = updateLocked;
    document.querySelector("main").inert = updateLocked;
    applyLock();
  }

  function applyLock() {
    [
      "setup-auto-gateway-id", "wiz-next-0", "wiz-next-1", "wiz-back-1", "wiz-back-2", "setup-save-id",
      "discover-nearby",
    ].forEach((id) => {
      const node = $(id);
      if (node && !node.dataset.busy) setDisabled(node, updateLocked);
    });
    updateConnectionForm();
  }

  async function checkForUpdate(button) {
    await withBusy(button, async () => {
      try {
        const payload = await post("/api/update/check");
        const st = payload.update_state || {};
        if (lastData) lastData.update_state = st;
        if (st.last_error) toast(fmt("updateCheckFailed", { error: st.last_error }), "error");
        else if (st.required_update || st.update_available) toast(fmt("updateAvailable", { version: displayVersion(st.latest_version || st.latest_gateway_version) }));
        else toast(tr("upToDate"));
      } catch (error) {
        toast(errorText(error), "error");
      }
    });
  }

  async function startUpdate(button, ask) {
    if (ask && !(await confirmDialog({ title: tr("updateConfirmTitle"), message: tr("updateConfirmMessage"), confirmLabel: tr("updateNow") }))) return;
    await withBusy(button, async () => {
      try {
        await post("/api/update/start");
        toast(tr("updateStarted"));
      } catch (error) {
        toast(errorText(error), "error");
      }
    });
    refresh();
  }

  async function restartGateway(button) {
    if (!(await confirmDialog({ title: tr("restartConfirmTitle"), message: tr("restartConfirmMessage"), confirmLabel: tr("restart") }))) return;
    await withBusy(button, async () => {
      try {
        await post("/api/update/restart");
        toast(tr("restartSent"));
      } catch (error) {
        toast(errorText(error), "error");
      }
    });
  }

  async function changeChannel(select) {
    const previous = (lastData && lastData.update_state && lastData.update_state.update_channel) === "beta" ? "beta" : "stable";
    const channel = select.value === "beta" ? "beta" : "stable";
    if (channel === previous) return;
    if (channel === "beta") {
      const ok = await confirmDialog({ title: tr("channelBetaConfirmTitle"), message: tr("channelBetaConfirmMessage"), confirmLabel: tr("channelSwitchBeta") });
      if (!ok) {
        select.value = previous;
        return;
      }
    }
    select.dataset.busy = "1";
    select.disabled = true;
    try {
      await post("/api/update/channel", { channel });
      toast(fmt("channelSaved", { channel: tr(channel === "beta" ? "channelBeta" : "channelStable") }));
    } catch (error) {
      select.value = previous;
      toast(errorText(error), "error");
    } finally {
      delete select.dataset.busy;
      select.disabled = false;
      select.blur();
      refresh();
    }
  }

  // ── Devices ─────────────────────────────────────────────────────────────
  async function deviceAction(action, uid, button) {
    if (action === "reject" && button.closest("#serving-list")) {
      const ok = await confirmDialog({
        title: tr("refuseServingTitle"),
        message: fmt("refuseServingMessage", { device: uid }),
        confirmLabel: tr("deny"),
        destructive: true,
      });
      if (!ok) return;
    }
    const key = `${action}:${uid}`;
    if (pending.has(key)) return;
    pending.add(key);
    if (lastData) renderDevices(lastData);
    try {
      await post(`/api/devices/${encodeURIComponent(uid)}/${action}`);
      toast(fmt(action === "serve" ? "serveRequested" : "deviceActionDone", { device: uid }));
    } catch (error) {
      toast(errorText(error), "error");
    } finally {
      pending.delete(key);
      if (lastData) renderDevices(lastData);
      refresh();
    }
  }

  // ── Setup wizard ────────────────────────────────────────────────────────
  function wizSetStep(step) {
    wizardStep = step;
    [0, 1, 2].forEach((index) => {
      show(`wiz-step-${index}`, index === step);
      setClass(`wiz-pip${index}`, index === step ? "active" : index < step ? "done" : "");
    });
    if (step === 2) {
      setText("wiz-confirm-id", $("setup-gateway-id-input").value.trim());
      setText("wiz-confirm-mode", targetLabel(wizardMode));
    }
    updateWizardPreview();
  }

  function updateWizardPreview() {
    show("wiz-manual-wrap", wizardMode === "manual");
    const url = resolveUrl(wizardMode, $("wiz-manual-url").value);
    setText("wiz-url-preview", url);
    setText("wiz-confirm-url", url);
  }

  async function finishSetup(button) {
    showFieldError("wiz-msg-2", "");
    await withBusy(button, async () => {
      try {
        const payload = await post("/api/settings", {
          gateway_id: $("setup-gateway-id-input").value.trim(),
          target_mode: wizardMode,
          manual_url: $("wiz-manual-url").value.trim(),
          enabled: true,
        });
        if (payload.config && lastData) lastData.config = payload.config;
        targetSettingsDirty = false;
        toast(tr("setupDone"));
        window.location.hash = "overview";
      } catch (error) {
        showFieldError("wiz-msg-2", errorText(error));
      }
    });
    refresh();
  }

  // ── Polling ─────────────────────────────────────────────────────────────
  async function refresh() {
    const seq = ++requestSeq;
    inFlight += 1;
    try {
      const data = await api("/api/status");
      if (seq < renderedSeq) return;
      renderedSeq = seq;
      unreachable = false;
      render(data);
      const hasGatewayId = Boolean(String((data.config || {}).gateway_id || "").trim());
      if (!hasGatewayId && !setupGatewayIdSuggested) {
        setupGatewayIdSuggested = true;
        try {
          const payload = await post("/api/gateway-id/suggest");
          if (!String(document.getElementById("setup-gateway-id-input").value || "").trim()) {
            document.getElementById("setup-gateway-id-input").value = payload.gateway_id || "";
          }
        } catch (error) {
          // Offline: the user types one, or presses Generate later.
        }
      }
    } catch (error) {
      // The Gateway itself is restarting or gone: say so, keep the last view.
      unreachable = true;
      renderUnreachable();
    } finally {
      inFlight -= 1;
    }
  }

  // ── Wiring ──────────────────────────────────────────────────────────────
  function wire() {
    $("theme-toggle").addEventListener("click", () => window.NHGTheme && window.NHGTheme.cycle());
    $("language-select").addEventListener("change", (event) => {
      language = normalizeLanguage(event.target.value);
      storageSet(LANGUAGE_KEY, language);
      applyI18n();
      if (lastData) render(lastData);
      else wizSetStep(wizardStep);
    });

    document.addEventListener("click", (event) => {
      const nav = event.target.closest("[data-goto], #section-nav [data-section]");
      if (nav) {
        goTo(nav.dataset.goto || nav.dataset.section);
        return;
      }
      const action = event.target.closest("button[data-action][data-uid]");
      if (action && !action.disabled) deviceAction(action.dataset.action, action.dataset.uid, action);
    });
    window.addEventListener("hashchange", () => showSection(sectionFromHash()));

    // Connection
    $("connection-form").addEventListener("submit", (event) => {
      event.preventDefault();
      if (!$("save-settings").disabled) saveSettings();
    });
    $("target-mode").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-mode]");
      if (!button || updateLocked) return;
      formMode = button.dataset.mode;
      setSegment($("target-mode"), formMode);
      markDirty();
      if (formMode === "manual") $("manual-url").focus();
    });
    ["gateway-id-input", "manual-url"].forEach((id) => $(id).addEventListener("input", markDirty));
    ["gateway-enabled", "remote-management"].forEach((id) => $(id).addEventListener("change", markDirty));
    $("auto-gateway-id").addEventListener("click", (event) => withBusy(event.currentTarget, async () => {
      try {
        $("gateway-id-input").value = await suggestGatewayId();
        markDirty();
      } catch (error) {
        toast(errorText(error), "error");
      }
    }));
    $("revert-settings").addEventListener("click", () => {
      targetSettingsDirty = false;
      show("settings-message", false);
      if (lastData) syncTargetSettings(lastData.config || {});
      updateConnectionForm();
    });

    // Devices
    $("discover-nearby").addEventListener("click", (event) => withBusy(event.currentTarget, async () => {
      try {
        await post("/api/discover");
        toast(tr("discoverSent"));
      } catch (error) {
        toast(errorText(error), "error");
      }
    }).then(refresh));

    // Update
    $("check-update").addEventListener("click", (event) => checkForUpdate(event.currentTarget));
    $("overlay-check-update").addEventListener("click", (event) => checkForUpdate(event.currentTarget));
    $("start-update").addEventListener("click", (event) => startUpdate(event.currentTarget, true));
    // The required-update dialog is already the question: no second one.
    $("overlay-start-update").addEventListener("click", (event) => startUpdate(event.currentTarget, false));
    $("restart-gateway").addEventListener("click", (event) => restartGateway(event.currentTarget));
    $("overlay-restart-gateway").addEventListener("click", (event) => restartGateway(event.currentTarget));
    $("update-channel").addEventListener("change", (event) => changeChannel(event.currentTarget));

    // Wizard
    $("setup-auto-gateway-id").addEventListener("click", (event) => withBusy(event.currentTarget, async () => {
      try {
        $("setup-gateway-id-input").value = await suggestGatewayId();
        setupGatewayIdSuggested = true;
        showFieldError("setup-message", "");
      } catch (error) {
        showFieldError("setup-message", errorText(error));
      }
    }));
    $("setup-gateway-id-input").addEventListener("keydown", (event) => {
      if (event.key === "Enter") $("wiz-next-0").click();
    });
    $("wiz-next-0").addEventListener("click", () => {
      const message = validateGatewayId($("setup-gateway-id-input").value);
      showFieldError("setup-message", message);
      if (!message) wizSetStep(1);
    });
    $("wiz-target-mode").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-mode]");
      if (!button) return;
      wizardMode = button.dataset.mode;
      setSegment($("wiz-target-mode"), wizardMode);
      showFieldError("wiz-msg-1", "");
      updateWizardPreview();
      if (wizardMode === "manual") $("wiz-manual-url").focus();
    });
    $("wiz-manual-url").addEventListener("input", updateWizardPreview);
    $("wiz-next-1").addEventListener("click", () => {
      const message = validateManualUrl(wizardMode, $("wiz-manual-url").value);
      showFieldError("wiz-msg-1", message);
      if (!message) wizSetStep(2);
    });
    $("wiz-back-1").addEventListener("click", () => wizSetStep(0));
    $("wiz-back-2").addEventListener("click", () => wizSetStep(1));
    $("setup-save-id").addEventListener("click", (event) => finishSetup(event.currentTarget));

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refresh();
    });

    // Sticky offsets follow the real topbar height (it wraps on phones).
    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        document.documentElement.style.setProperty("--topbar-height", `${$("topbar").offsetHeight}px`);
      }).observe($("topbar"));
    }
  }

  function init() {
    document.querySelectorAll("[data-icon]").forEach((node) => {
      node.innerHTML = ICONS[node.dataset.icon] || "";
    });
    applyI18n();
    // After applyI18n(), so the buttons start with translated option text.
    if (window.NHGSelect) window.NHGSelect.enhanceAll();
    if (window.NHGTheme) window.NHGTheme.start((mode) => updateThemeButton(mode));
    setSegment($("wiz-target-mode"), wizardMode);
    setSegment($("target-mode"), formMode);
    wizSetStep(0);
    showSection(sectionFromHash());
    wire();
    refresh();
    window.setInterval(() => {
      if (inFlight === 0 && !document.hidden) refresh();
    }, POLL_MS);
  }

  init();
})();
