from __future__ import annotations

import json
import secrets
import threading
import urllib.error
import urllib.request
from typing import Any, Callable
from urllib.parse import urlparse

from flask import Flask, jsonify, request
from werkzeug.serving import make_server

from . import __version__
from .config_store import GatewayConfigStore, LOCAL_URL, PRODUCTION_URL, validate_gateway_id
from .state import GatewayState
from .update_manager import GatewayUpdateManager


ConfigCallback = Callable[[dict[str, Any]], None]


PAGE = """<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>New Horizons Gateway</title>
  <style>
    :root { color-scheme: light; --bg:#f7f7f3; --panel:#fffffb; --ink:#151816; --muted:#697068; --line:#d9ddd4; --green:#3f7b61; --danger:#b6554c; --warn:#b5842a; --blue:#3f648f; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--ink); }
    main { max-width:1180px; margin:0 auto; padding:28px 22px 44px; }
    h1 { margin:4px 0 22px; font-size:34px; letter-spacing:0; }
    h2 { margin:0 0 12px; font-size:20px; }
    .grid { display:grid; grid-template-columns:repeat(12, 1fr); gap:14px; }
    .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; box-shadow:0 1px 2px rgba(0,0,0,.03); }
    .span-4 { grid-column:span 4; } .span-6 { grid-column:span 6; } .span-8 { grid-column:span 8; } .span-12 { grid-column:span 12; }
    .stat { color:var(--muted); display:block; font-size:13px; margin-bottom:4px; }
    strong { font-size:18px; }
    .badge { display:inline-flex; align-items:center; min-height:30px; padding:3px 12px; border:1px solid var(--line); border-radius:999px; color:var(--muted); background:#f1f2ee; }
    .badge.ok { border-color:#aac9ba; color:var(--green); background:#f4fbf7; }
    .badge.err { border-color:#d9aaa4; color:var(--danger); background:#fff7f5; }
    .badge.warn { border-color:#e0c58b; color:var(--warn); background:#fffaf0; }
    .header-row, .section-head { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; align-items:end; }
    .field { display:grid; gap:6px; flex:1; min-width:180px; }
    .field.narrow { flex:0 0 160px; min-width:140px; }
    .switch-row { display:flex; gap:12px; align-items:center; min-height:42px; }
    .stack { display:grid; gap:14px; }
    .summary-grid { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:10px; }
    .summary-card { border:1px solid var(--line); border-radius:7px; padding:12px; background:#fcfcf8; }
    .summary-card strong { font-size:15px; }
    .button-row { display:flex; gap:10px; flex-wrap:wrap; }
    label { color:var(--muted); font-size:13px; }
    input, select { width:100%; min-height:42px; padding:8px 10px; border:1px solid var(--line); border-radius:7px; background:#fff; color:var(--ink); font:inherit; }
    input[type="checkbox"] { width:22px; min-height:22px; accent-color:var(--green); }
    button { min-height:42px; padding:8px 14px; border:1px solid var(--line); border-radius:7px; background:#fff; color:var(--ink); font:inherit; cursor:pointer; }
    button.primary { background:var(--green); color:white; border-color:var(--green); }
    button.secondary { color:var(--blue); border-color:#b8c7d9; background:#f7faff; }
    button.danger { color:var(--danger); border-color:#d9aaa4; }
    button:disabled { opacity:.55; cursor:not-allowed; }
    table { width:100%; border-collapse:collapse; }
    th, td { border-bottom:1px solid var(--line); padding:10px 8px; text-align:left; vertical-align:top; }
    th { color:var(--muted); font-weight:600; font-size:13px; }
    .muted { color:var(--muted); }
    .mono { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; }
    .notice { margin:10px 0 0; color:var(--muted); }
    .notice.error { color:var(--danger); }
    .notice.success { color:var(--green); }
    @media (max-width: 860px) { .span-4,.span-6,.span-8 { grid-column:span 12; } main { padding:18px 14px; } .header-row,.section-head { display:grid; } .summary-grid { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <main>
    <div class="header-row">
      <div>
        <h1>New Horizons Gateway</h1>
      </div>
      <div class="field narrow">
        <label data-i18n="language">Language</label>
        <select id="language-select">
          <option value="en">English</option>
          <option value="ja">日本語</option>
        </select>
      </div>
    </div>
    <section class="setup-wizard panel" id="setup-wizard" hidden>
      <span class="badge warn" data-i18n="firstRun">First setup</span>
      <h2 data-i18n="setupTitle">Set up Gateway ID</h2>
      <p class="muted" data-i18n="setupCopy">Create a unique Gateway ID before enabling upstream, UDP and FindMe services.</p>
      <div class="toolbar">
        <div class="field"><label data-i18n="gatewayId">Gateway ID</label><input id="setup-gateway-id-input" maxlength="64" placeholder="nh-gateway-xxxxxx"></div>
        <button id="setup-auto-gateway-id" data-i18n="autoSet">Auto set</button>
        <button class="primary" id="setup-save-id" data-i18n="continue">Continue</button>
      </div>
      <p class="notice" id="setup-message"></p>
    </section>
    <div class="grid" id="dashboard-grid">
      <section class="panel span-4"><span class="stat" data-i18n="gateway">Gateway</span><strong id="gateway-name">-</strong><p class="muted mono" id="gateway-id">-</p></section>
      <section class="panel span-4"><span class="stat" data-i18n="version">Version</span><strong id="gateway-version">-</strong><p class="muted mono" id="update-mini">-</p></section>
      <section class="panel span-4"><span class="stat" data-i18n="upstream">Upstream</span><span id="upstream-badge" class="badge">-</span><p class="muted mono" id="upstream-url">-</p></section>

      <section class="panel span-12" id="nearby-section">
        <h2 data-i18n="gatewaySettings">Gateway Settings</h2>
        <div class="toolbar">
          <div class="field"><label data-i18n="gatewayId">Gateway ID</label><input id="gateway-id-input" maxlength="64" placeholder="nh-gateway-xxxxxx"></div>
          <button id="auto-gateway-id" data-i18n="autoSet">Auto set</button>
          <div class="field narrow">
            <label data-i18n="enabled">Enabled</label>
            <div class="switch-row"><input id="gateway-enabled" type="checkbox"><span class="muted" data-i18n="enabledCopy">Start upstream, UDP and FindMe</span></div>
          </div>
          <button class="primary" id="save-settings" data-i18n="save">Save</button>
        </div>
        <p class="notice" id="settings-message"></p>
      </section>

      <section class="panel span-12">
        <h2 data-i18n="targetServer">Target Server</h2>
        <div class="stack">
          <div class="toolbar">
            <div class="field"><label data-i18n="mode">Mode</label><select id="target-mode"><option value="production" data-i18n="production">Production</option><option value="local" data-i18n="local">Local</option><option value="manual" data-i18n="manual">Manual</option></select></div>
            <div class="field"><label data-i18n="manualUrl">Manual WS/WSS URL</label><input id="manual-url" placeholder="ws://127.0.0.1:5051/newhorizons/gateway/ws"></div>
          </div>
          <div class="summary-grid">
            <div class="summary-card"><span class="stat" data-i18n="connectionMode">Connection mode</span><strong id="target-mode-summary">-</strong></div>
            <div class="summary-card"><span class="stat" data-i18n="effectiveServer">Effective server</span><strong class="mono" id="effective-server">-</strong></div>
            <div class="summary-card"><span class="stat" data-i18n="upstreamStatus">Upstream status</span><strong id="upstream-summary">-</strong></div>
          </div>
        </div>
        <p class="muted"><span data-i18n="production">Production</span>: <span class="mono">__PRODUCTION__</span><br><span data-i18n="local">Local</span>: <span class="mono">__LOCAL__</span></p>
      </section>

      <section class="panel span-12">
        <div class="section-head">
          <div>
            <h2 data-i18n="operations">Operations</h2>
            <p class="muted" data-i18n="operationsCopy">Use discovery and claim actions here during local relay work. Update stays separated at the end.</p>
          </div>
          <div class="button-row">
            <button class="secondary" id="refresh-now" data-i18n="refreshNow">Refresh now</button>
            <button class="primary" id="discover-nearby" data-i18n="discoverDevices">Discover devices</button>
          </div>
        </div>
        <div class="summary-grid">
          <div class="summary-card"><span class="stat" data-i18n="servingDevices">Serving Devices</span><strong id="serving-count">0</strong></div>
          <div class="summary-card"><span class="stat" data-i18n="nearbyDevices">Nearby Devices / FindMe Discovery</span><strong id="nearby-count">0</strong></div>
          <div class="summary-card"><span class="stat" data-i18n="claims">Claims</span><strong id="claim-count">0</strong></div>
        </div>
      </section>

      <section class="panel span-4"><span class="stat" data-i18n="localServices">Local services</span><strong id="ports">-</strong><p class="muted" data-i18n="localServicesCopy">FindMe / UDP control and data</p><p class="muted mono" id="traffic-stats">-</p></section>
      <section class="panel span-8">
        <h2 data-i18n="servingDevices">Serving Devices</h2>
        <table><thead><tr><th data-i18n="device">Device</th><th data-i18n="mode">Mode</th><th>FindMe</th><th>UDP</th><th data-i18n="action">Action</th></tr></thead><tbody id="device-body"></tbody></table>
      </section>
      <section class="panel span-12">
        <div class="section-head">
          <div>
            <h2 data-i18n="nearbyDevices">Nearby Devices / FindMe Discovery</h2>
            <p class="muted" data-i18n="nearbyCopy">Recent FindMe broadcasts seen by this gateway. Use claim only for devices not currently served here.</p>
          </div>
          <button id="nearby-toggle" data-i18n="hideNearby">Hide nearby</button>
        </div>
        <div id="nearby-panel" hidden>
          <table><thead><tr><th data-i18n="device">Device</th><th data-i18n="mode">Mode</th><th data-i18n="address">Address</th><th data-i18n="state">State</th><th data-i18n="lastSeen">Last seen</th><th data-i18n="action">Action</th></tr></thead><tbody id="nearby-body"></tbody></table>
        </div>
      </section>
      <section class="panel span-12">
        <h2 data-i18n="claims">Claims</h2>
        <table><thead><tr><th data-i18n="time">Time</th><th data-i18n="device">Device</th><th>Claim</th><th data-i18n="status">Status</th><th data-i18n="error">Error</th></tr></thead><tbody id="claim-body"></tbody></table>
      </section>
      <section class="panel span-12">
        <div class="section-head">
          <div>
            <h2 data-i18n="update">Update</h2>
            <p class="muted" id="update-status">-</p>
          </div>
          <div class="toolbar">
            <button id="check-update" data-i18n="checkUpdate">Check for update</button>
            <button id="download-update" data-i18n="downloadUpdate">Download update</button>
            <button id="apply-update" data-i18n="applyUpdate">Apply update</button>
            <button id="restart-gateway" data-i18n="restartGateway">Restart Gateway</button>
          </div>
        </div>
        <p class="notice" id="update-message"></p>
      </section>
    </div>
  </main>
  <script>
    const I18N = {
      en: {
        action: "Action", address: "Address", allow: "Allow", applyUpdate: "Apply update", autoSet: "Auto set",
        checkUpdate: "Check for update", claims: "Claims", connectionMode: "Connection mode", continue: "Continue", denied: "Denied", device: "Device",
        discoverDevices: "Discover devices", downloadUpdate: "Download update", enabled: "Enabled",
        effectiveServer: "Effective server", enabledCopy: "Start upstream, UDP and FindMe", error: "Error", gateway: "Gateway", gatewayId: "Gateway ID",
        gatewaySettings: "Gateway Settings", language: "Language", lastSeen: "Last seen", localServices: "Local services",
        localServicesCopy: "FindMe / UDP control and data", manualUrl: "Manual WS/WSS URL", mode: "Mode",
        nearbyCopy: "Recent FindMe broadcasts seen by this gateway. Use claim only for devices not currently served here.",
        nearbyDevices: "Nearby Devices / FindMe Discovery", noActiveClaims: "No active claims.", noDevices: "No devices served yet.",
        hideNearby: "Hide nearby", local: "Local", manual: "Manual", noNearby: "No nearby FindMe requests yet.", offline: "offline", online: "online", operations: "Operations",
        operationsCopy: "Use discovery and claim actions here during local relay work. Update stays separated at the end.", packets: "packets", production: "Production", reject: "Reject", refresh: "Refresh", refreshNow: "Refresh now", restartGateway: "Restart Gateway",
        dropped: "dropped", queueDropped: "queue dropped", save: "Save", saved: "Saved", serveThisDevice: "Serve this device",
        serving: "Serving", servingDevices: "Serving Devices", setupCopy: "Create a unique Gateway ID before enabling upstream, UDP and FindMe services.",
        setupTitle: "Set up Gateway ID", firstRun: "First setup", state: "State", status: "Status", targetServer: "Target Server",
        time: "Time", upstream: "Upstream", upstreamSent: "Upstream sent", upstreamStatus: "Upstream status", udpIn: "UDP in", update: "Update", version: "Version",
      },
      ja: {
        action: "操作", address: "アドレス", allow: "許可", applyUpdate: "更新を適用", autoSet: "自動設定",
        checkUpdate: "更新を確認", claims: "要求", connectionMode: "接続モード", continue: "続行", denied: "拒否済み", device: "デバイス",
        discoverDevices: "デバイスを検出", downloadUpdate: "更新をダウンロード", enabled: "有効",
        effectiveServer: "実際の接続先", enabledCopy: "上流接続、UDP、FindMeを開始", error: "エラー", gateway: "ゲートウェイ", gatewayId: "Gateway ID",
        gatewaySettings: "ゲートウェイ設定", language: "言語", lastSeen: "最終確認", localServices: "ローカルサービス",
        localServicesCopy: "FindMe / UDP制御とデータ", manualUrl: "手動 WS/WSS URL", mode: "モード",
        nearbyCopy: "このゲートウェイが受信した最近の FindMe ブロードキャストです。ここで未提供のデバイスだけ要求できます。",
        nearbyDevices: "近くのデバイス / FindMe 検出", noActiveClaims: "有効な要求はありません。", noDevices: "提供中のデバイスはありません。",
        hideNearby: "非表示", local: "ローカル", manual: "手動", noNearby: "近くの FindMe 要求はありません。", offline: "オフライン", online: "オンライン", operations: "操作",
        operationsCopy: "ローカル中継で使う操作をここにまとめ、更新はページ末尾に分離します。", packets: "パケット", production: "本番", reject: "拒否", refresh: "更新", refreshNow: "今すぐ更新", restartGateway: "Gatewayを再起動",
        dropped: "破棄", queueDropped: "キュー破棄", save: "保存", saved: "保存しました", serveThisDevice: "このデバイスを提供",
        serving: "提供中", servingDevices: "提供中のデバイス", setupCopy: "上流接続、UDP、FindMe サービスを有効にする前に、一意な Gateway ID を設定してください。",
        setupTitle: "Gateway ID を設定", firstRun: "初回設定", state: "状態", status: "状態", targetServer: "接続先サーバー",
        time: "時刻", upstream: "上流接続", upstreamSent: "上流送信", upstreamStatus: "上流状態", udpIn: "UDP入力", update: "更新", version: "バージョン",
      },
    };
    let language = localStorage.getItem("newhorizons-gateway-language") || "en";
    let showNearby = false;
    let targetSettingsDirty = false;
    let setupGatewayIdSuggested = false;
    function tr(key) { return (I18N[language] && I18N[language][key]) || I18N.en[key] || key; }
    function updateNearbyToggleLabel() {
      const node = document.getElementById("nearby-toggle");
      if (node) node.textContent = showNearby ? tr("hideNearby") : tr("discoverDevices");
    }
    function applyI18n() {
      document.documentElement.lang = language;
      document.getElementById("language-select").value = language;
      document.querySelectorAll("[data-i18n]").forEach((node) => { node.textContent = tr(node.getAttribute("data-i18n")); });
      updateNearbyToggleLabel();
    }
    function esc(value) {
      return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    }
    async function api(path, options) {
      const res = await fetch(path, options);
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || payload.message || res.statusText);
      return payload;
    }
    function text(id, value) { document.getElementById(id).textContent = value || "-"; }
    function notice(id, message, cls = "") {
      const node = document.getElementById(id);
      node.textContent = message || "";
      node.className = `notice ${cls}`.trim();
    }
    function syncTargetSettings(config) {
      if (targetSettingsDirty) return;
      document.getElementById("target-mode").value = config.target_mode || "production";
      document.getElementById("manual-url").value = config.manual_url || "";
      document.getElementById("gateway-id-input").value = config.gateway_id || "";
      document.getElementById("gateway-enabled").checked = !!config.enabled;
    }
    function renderUpdate(state) {
      const current = state.current_version || "-";
      const latest = state.latest_version || "-";
      text("gateway-version", current);
      text("update-mini", `${state.phase || "idle"} / latest ${latest}`);
      text("update-status", `current ${current} / latest ${latest} / ${state.update_available ? "available" : "no update"}`);
      document.getElementById("download-update").disabled = !state.update_available && !state.zip_url;
      document.getElementById("apply-update").disabled = !state.downloaded;
      document.getElementById("restart-gateway").disabled = !state.restart_required;
    }
    async function refresh() {
      applyI18n();
      const data = await api("/api/status");
      const hasGatewayId = !!String(data.config.gateway_id || "").trim();
      document.getElementById("setup-wizard").hidden = hasGatewayId;
      document.getElementById("dashboard-grid").hidden = !hasGatewayId;
      if (hasGatewayId) setupGatewayIdSuggested = false;
      text("gateway-name", data.config.gateway_name);
      text("gateway-id", data.config.gateway_id);
      text("upstream-url", data.upstream.server_url);
      text("target-mode-summary", tr(data.config.target_mode || "production"));
      text("effective-server", data.config.server_url);
      text("upstream-summary", data.config.enabled ? (data.upstream.connected ? tr("online") : tr("offline")) : "disabled");
      text("ports", `FindMe ${data.config.listen_discovery_port} / UDP ${data.config.listen_udp_port}`);
      text("traffic-stats", `${tr("udpIn")} ${Number(data.upstream.udp_in_fps || 0)}/s / ${tr("upstreamSent")} ${Number(data.upstream.upstream_sent_fps || 0)}/s / ${tr("queueDropped")} ${Number(data.upstream.data_queue_dropped || 0)}`);
      const badge = document.getElementById("upstream-badge");
      badge.textContent = data.config.enabled ? (data.upstream.connected ? tr("online") : tr("offline")) : "disabled";
      badge.className = `badge ${!data.config.enabled ? "warn" : data.upstream.connected ? "ok" : "err"}`;
      syncTargetSettings(data.config || {});
      if (!targetSettingsDirty) document.getElementById("setup-gateway-id-input").value = data.config.gateway_id || "";
      if (!hasGatewayId && !setupGatewayIdSuggested) {
        setupGatewayIdSuggested = true;
        try {
          const payload = await api("/api/gateway-id/suggest", { method:"POST" });
          if (!String(document.getElementById("setup-gateway-id-input").value || "").trim()) {
            document.getElementById("setup-gateway-id-input").value = payload.gateway_id || "";
          }
        } catch (error) {
          notice("setup-message", error.message || String(error), "error");
        }
      }
      renderUpdate(data.update_state || {});
      const body = document.getElementById("device-body");
      body.innerHTML = "";
      const servingDevices = (data.state.devices || []).filter((item) => item.connected);
      text("serving-count", String(servingDevices.length));
      text("nearby-count", String((data.state.nearby_devices || []).length));
      text("claim-count", String((data.state.claims || []).length));
      for (const item of servingDevices) {
        const row = document.createElement("tr");
        const action = item.denied
          ? `<button data-allow="${esc(item.device_uid)}">${tr("allow")}</button>`
          : `<button class="danger" data-reject="${esc(item.device_uid)}">${tr("reject")}</button>`;
        row.innerHTML = `<td><strong>${esc(item.device_name || item.device_uid)}</strong><br><span class="muted mono">${esc(item.device_uid)}</span></td><td>${esc(item.mode || "-")}</td><td>${esc(item.findme_state || "attached")}<br><span class="muted">${esc(item.wifi_rssi ?? "-")}</span></td><td>${Number(item.udp_packets || 0)} ${tr("packets")}<br><span class="muted">${Number(item.udp_dropped || 0)} ${tr("dropped")}</span></td><td>${action}</td>`;
        body.appendChild(row);
      }
      if (!servingDevices.length) body.innerHTML = `<tr><td colspan="5" class="muted">${tr("noDevices")}</td></tr>`;
      document.getElementById("nearby-panel").hidden = !showNearby;
      updateNearbyToggleLabel();
      const nbody = document.getElementById("nearby-body");
      nbody.innerHTML = "";
      for (const item of data.state.nearby_devices || []) {
        const row = document.createElement("tr");
        let action = "";
        let state = item.serving ? tr("serving") : (item.denied ? tr("denied") : esc(item.findme_state || item.findme_reason || "-"));
        if (item.serving) action = `<span class="badge ok">${tr("serving")}</span>`;
        else if (item.denied) action = `<button data-allow="${esc(item.device_uid)}">${tr("allow")}</button>`;
        else if (data.upstream.connected) action = `<button data-serve="${esc(item.device_uid)}">${tr("serveThisDevice")}</button>`;
        else action = `<button disabled>${tr("serveThisDevice")}</button>`;
        row.innerHTML = `<td><strong>${esc(item.device_name || item.device_uid)}</strong><br><span class="mono muted">${esc(item.device_uid || "-")}</span></td><td>${esc(item.mode || "-")}</td><td>${esc(item.addr || "-")}</td><td>${state}</td><td>${esc(item.last_findme_at || "-")}</td><td>${action}</td>`;
        nbody.appendChild(row);
      }
      if (!(data.state.nearby_devices || []).length) nbody.innerHTML = `<tr><td colspan="6" class="muted">${tr("noNearby")}</td></tr>`;
      const cbody = document.getElementById("claim-body");
      cbody.innerHTML = "";
      for (const item of data.state.claims || []) {
        const row = document.createElement("tr");
        row.innerHTML = `<td>${esc(item.updated_at || item.requested_at || "-")}</td><td><span class="mono">${esc(item.device_uid || "-")}</span></td><td><span class="mono">${esc(item.claim_id || "-")}</span></td><td>${esc(item.state || "-")}</td><td>${esc(item.last_error || "")}</td>`;
        cbody.appendChild(row);
      }
      if (!(data.state.claims || []).length) cbody.innerHTML = `<tr><td colspan="5" class="muted">${tr("noActiveClaims")}</td></tr>`;
    }
    document.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const reject = target.getAttribute("data-reject");
      const allow = target.getAttribute("data-allow");
      const serve = target.getAttribute("data-serve");
      if (reject) await api(`/api/devices/${encodeURIComponent(reject)}/reject`, { method: "POST" });
      if (allow) await api(`/api/devices/${encodeURIComponent(allow)}/allow`, { method: "POST" });
      if (serve) await api(`/api/devices/${encodeURIComponent(serve)}/serve`, { method: "POST" });
      if (reject || allow || serve) refresh();
    });
    document.getElementById("save-settings").addEventListener("click", async () => {
      notice("settings-message", "");
      try {
        await api("/api/settings", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({
          target_mode: document.getElementById("target-mode").value,
          manual_url: document.getElementById("manual-url").value,
          gateway_id: document.getElementById("gateway-id-input").value,
          enabled: document.getElementById("gateway-enabled").checked,
        }) });
        targetSettingsDirty = false;
        notice("settings-message", tr("saved"), "success");
        refresh();
      } catch (error) {
        notice("settings-message", error.message || String(error), "error");
      }
    });
    document.getElementById("auto-gateway-id").addEventListener("click", async () => {
      try {
        const payload = await api("/api/gateway-id/suggest", { method:"POST" });
        document.getElementById("gateway-id-input").value = payload.gateway_id || "";
        targetSettingsDirty = true;
      } catch (error) {
        notice("settings-message", error.message || String(error), "error");
      }
    });
    document.getElementById("setup-auto-gateway-id").addEventListener("click", async () => {
      try {
        const payload = await api("/api/gateway-id/suggest", { method:"POST" });
        document.getElementById("setup-gateway-id-input").value = payload.gateway_id || "";
        setupGatewayIdSuggested = true;
      } catch (error) {
        notice("setup-message", error.message || String(error), "error");
      }
    });
    document.getElementById("setup-save-id").addEventListener("click", async () => {
      notice("setup-message", "");
      try {
        await api("/api/settings", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({
          target_mode: document.getElementById("target-mode").value,
          manual_url: document.getElementById("manual-url").value,
          gateway_id: document.getElementById("setup-gateway-id-input").value,
          enabled: false,
        }) });
        targetSettingsDirty = false;
        refresh();
      } catch (error) {
        notice("setup-message", error.message || String(error), "error");
      }
    });
    document.getElementById("target-mode").addEventListener("change", () => { targetSettingsDirty = true; });
    document.getElementById("manual-url").addEventListener("input", () => { targetSettingsDirty = true; });
    document.getElementById("gateway-id-input").addEventListener("input", () => { targetSettingsDirty = true; });
    document.getElementById("gateway-enabled").addEventListener("change", () => { targetSettingsDirty = true; });
    async function updateAction(path) {
      notice("update-message", "");
      try {
        const payload = await api(path, { method:"POST" });
        renderUpdate(payload.update_state || payload);
        notice("update-message", (payload.update_state || payload).phase || "ok", "success");
      } catch (error) {
        notice("update-message", error.message || String(error), "error");
      }
    }
    document.getElementById("check-update").addEventListener("click", () => updateAction("/api/update/check"));
    document.getElementById("download-update").addEventListener("click", () => updateAction("/api/update/download"));
    document.getElementById("apply-update").addEventListener("click", () => updateAction("/api/update/apply"));
    document.getElementById("restart-gateway").addEventListener("click", () => updateAction("/api/update/restart"));
    document.getElementById("refresh-now").addEventListener("click", () => refresh());
    document.getElementById("discover-nearby").addEventListener("click", async () => {
      showNearby = true;
      await refresh();
      const panel = document.getElementById("nearby-section");
      if (panel) panel.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    document.getElementById("nearby-toggle").addEventListener("click", () => {
      showNearby = !showNearby;
      refresh();
    });
    document.getElementById("language-select").addEventListener("change", (event) => {
      language = event.target.value === "ja" ? "ja" : "en";
      localStorage.setItem("newhorizons-gateway-language", language);
      refresh();
    });
    applyI18n();
    refresh();
    setInterval(refresh, 2000);
  </script>
</body>
</html>""".replace("__PRODUCTION__", PRODUCTION_URL).replace("__LOCAL__", LOCAL_URL)


class GatewayWebServer:
    def __init__(
        self,
        host: str,
        port: int,
        config_store: GatewayConfigStore,
        state: GatewayState,
        upstream: Any,
        tcp_server: Any | None,
        udp_control: Any | None = None,
        *,
        on_config_saved: ConfigCallback | None = None,
        update_manager: GatewayUpdateManager | None = None,
    ) -> None:
        self.host = host
        self.port = int(port)
        self.config_store = config_store
        self.state = state
        self.upstream = upstream
        self.tcp_server = tcp_server
        self.udp_control = udp_control
        self.on_config_saved = on_config_saved
        self.update_manager = update_manager or GatewayUpdateManager()
        self.app = self._make_app()
        self._server: Any = None
        self._thread: threading.Thread | None = None

    def _make_app(self) -> Flask:
        app = Flask(__name__)

        @app.get("/")
        def index() -> str:
            return PAGE

        @app.get("/api/status")
        def status() -> Any:
            config = self.config_store.snapshot()
            return jsonify({
                "config": self._public_config(config),
                "version": __version__,
                "upstream": self.upstream.status(),
                "udp_control": self.udp_control.snapshot() if self.udp_control is not None else {},
                "state": self.state.snapshot(config.get("denied_devices", [])),
                "update_state": self.update_manager.state(),
            })

        @app.post("/api/settings")
        def settings() -> Any:
            body = request.get_json(silent=True) or {}
            try:
                patch = {
                    "target_mode": body.get("target_mode", "production"),
                    "manual_url": body.get("manual_url", ""),
                    "gateway_id": body.get("gateway_id", ""),
                    "enabled": bool(body.get("enabled", False)),
                }
                if patch["enabled"]:
                    validate_gateway_id(patch["gateway_id"])
                config = self.config_store.save(patch)
            except ValueError as exc:
                return jsonify({"ok": False, "error": str(exc)}), 400
            if self.on_config_saved is not None:
                self.on_config_saved(config)
            else:
                self.upstream.gateway_id = str(config.get("gateway_id") or "")
                self.upstream.update_server(str(config["server_url"]), "")
            return jsonify({"ok": True, "config": self._public_config(config)})

        @app.post("/api/gateway-id/suggest")
        def suggest_gateway_id() -> Any:
            try:
                return jsonify({"gateway_id": self._request_gateway_id_suggestion()})
            except Exception as exc:
                return jsonify({"ok": False, "error": str(exc)}), 503

        @app.post("/api/update/check")
        def update_check() -> Any:
            return jsonify({"ok": True, "update_state": self.update_manager.check()})

        @app.post("/api/update/download")
        def update_download() -> Any:
            return jsonify({"ok": True, "update_state": self.update_manager.download()})

        @app.post("/api/update/apply")
        def update_apply() -> Any:
            return jsonify({"ok": True, "update_state": self.update_manager.apply()})

        @app.post("/api/update/restart")
        def update_restart() -> Any:
            return jsonify({"ok": True, "update_state": self.update_manager.restart()})

        @app.post("/api/devices/<device_uid>/reject")
        def reject(device_uid: str) -> Any:
            config = self.config_store.deny(device_uid)
            if self.tcp_server is not None:
                self.tcp_server.close_device(device_uid)
            return jsonify({"ok": True, "denied_devices": config.get("denied_devices", [])})

        @app.post("/api/devices/<device_uid>/allow")
        def allow(device_uid: str) -> Any:
            config = self.config_store.allow(device_uid)
            return jsonify({"ok": True, "denied_devices": config.get("denied_devices", [])})

        @app.post("/api/devices/<device_uid>/serve")
        def serve(device_uid: str) -> Any:
            if self.config_store.is_denied(device_uid):
                return jsonify({"ok": False, "error": "device_denied"}), 409
            if not self.upstream.is_connected():
                return jsonify({"ok": False, "error": "upstream_offline"}), 503
            claim = self.state.create_claim(device_uid)
            self.state.update_claim(claim["claim_id"], state="sent")
            self.upstream.send_claim_request(claim["device_uid"], claim["claim_id"], int(claim["ttl_ms"]))
            updated = self.state.update_claim(claim["claim_id"], state="requested")
            return jsonify({"ok": True, "claim": updated or claim})

        return app

    @staticmethod
    def _public_config(config: dict[str, Any]) -> dict[str, Any]:
        return dict(config)

    def _request_gateway_id_suggestion(self) -> str:
        return validate_gateway_id(f"nh-gateway-{secrets.token_hex(3)}")

    def _confirm_gateway_id_available(self, gateway_id: str) -> None:
        try:
            payload = self._server_api_post("/api/gateways/suggest-id", {"gateway_id": gateway_id})
        except urllib.error.HTTPError as exc:
            if exc.code == 409:
                raise ValueError("gateway_id_in_use") from exc
            if exc.code in (401, 403):
                raise ValueError("gateway_token_unauthorized") from exc
            return
        except urllib.error.URLError:
            return
        if payload.get("available") is False:
            raise ValueError("gateway_id_in_use")

    def _server_api_post(self, api_path: str, body: dict[str, Any]) -> dict[str, Any]:
        config = self.config_store.snapshot()
        base_url = self._http_base_from_gateway_ws(str(config.get("server_url") or ""))
        url = f"{base_url}{api_path}"
        data = json.dumps(body, separators=(",", ":")).encode("utf-8")
        request_obj = urllib.request.Request(url, data=data, method="POST", headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request_obj, timeout=8) as response:
            payload = json.loads(response.read().decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("invalid_server_response")
        return payload

    @staticmethod
    def _http_base_from_gateway_ws(server_url: str) -> str:
        parsed = urlparse(server_url)
        scheme = "https" if parsed.scheme == "wss" else "http"
        path = parsed.path or ""
        suffix = "/gateway/ws"
        if path.endswith(suffix):
            path = path[: -len(suffix)]
        return f"{scheme}://{parsed.netloc}{path}"

    def start(self) -> None:
        if self._server is not None:
            return
        self._server = make_server(self.host, self.port, self.app, threaded=True)
        self._thread = threading.Thread(target=self._server.serve_forever, name="newhorizons-gateway-web", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        server = self._server
        thread = self._thread
        self._server = None
        self._thread = None
        if server is not None:
            server.shutdown()
        if thread is not None:
            thread.join(timeout=1.0)
