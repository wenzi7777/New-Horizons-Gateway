import re
import unittest
import tempfile
from pathlib import Path

from newhorizons_gateway.config_store import GatewayConfigStore
from newhorizons_gateway.state import GatewayState
from newhorizons_gateway.update_manager import ALLOWED_UPDATE_ENTRIES
from newhorizons_gateway.web import GatewayWebServer


ROOT = Path(__file__).resolve().parents[1]

WEBUI = ROOT / "newhorizons_gateway" / "webui"


def webui(name):
    return (WEBUI / name).read_text(encoding="utf-8")


def webui_source():
    return "\n".join(webui(name) for name in ("index.html", "app.css", "app.js", "i18n.js", "theme.js", "select.js"))


def function_body(source, signature):
    """The text between `signature`'s opening brace and its matching close."""
    start = source.index(signature) + len(signature)
    depth = 1
    for index in range(start, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[start:index]
    raise AssertionError(f"unbalanced {signature}")


def i18n_tables():
    """{language: set(keys)} parsed from webui/i18n.js."""
    text = webui("i18n.js")
    tables = {}
    for match in re.finditer(r'^  ("?)([A-Za-z-]+)\1: \{\n(.*?)^  \},', text, re.M | re.S):
        keys = re.findall(r'^    (?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*)):', match.group(3), re.M)
        tables[match.group(2)] = {quoted or plain for quoted, plain in keys}
    return tables


class FakeUpstream:
    gateway_id = "local-gateway"

    def __init__(self):
        self.updated = []

    def status(self):
        return {"connected": False, "last_error": ""}

    def is_connected(self):
        return False

    def update_server(self, server_url, auth_token=None):
        self.updated.append((server_url, auth_token))

    def send_claim_request(self, *_args, **_kwargs):
        return None


class FakeUDPControl:
    def __init__(self):
        self.direct = []

    def snapshot(self):
        return {}

    def send_command_to(self, device_uid, addr, payload):
        self.direct.append((device_uid, addr, payload))
        return True


class FakeUpdateManager:
    def __init__(self, payload=None):
        self.payload = dict(payload or {})
        self.refresh_calls = 0

    def maybe_refresh(self):
        self.refresh_calls += 1
        return dict(self.payload)

    def state(self):
        return dict(self.payload)

    def check(self):
        self.payload["phase"] = "checked"
        return dict(self.payload)

    def download(self):
        self.payload["phase"] = "downloaded"
        return dict(self.payload)

    def apply(self):
        self.payload["phase"] = "applied"
        return dict(self.payload)

    def start_update(self):
        self.payload["phase"] = "downloading"
        self.payload["busy"] = True
        return dict(self.payload)

    def restart(self):
        self.payload["phase"] = "restarting"
        return dict(self.payload)


class GatewayWebUiTest(unittest.TestCase):
    def test_gateway_config_no_longer_persists_token(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            store = GatewayConfigStore(str(Path(tmpdir) / "gateway_config.json"))

            self.assertNotIn("auth_token", store.snapshot())

    def test_gateway_startup_has_no_token_env_override(self):
        host_script = (ROOT / "scripts" / "start.py").read_text(encoding="utf-8")

        self.assertNotIn("NEWHORIZONS_GATEWAY_TOKEN", host_script)

    def test_target_server_form_is_not_overwritten_while_dirty(self):
        app = webui("app.js")

        self.assertIn("let targetSettingsDirty = false", app)
        self.assertIn("if (targetSettingsDirty) return;", function_body(app, "function syncTargetSettings(config) {"))
        self.assertIn('$(id).addEventListener("input", markDirty)', app)
        self.assertIn("targetSettingsDirty = false;", app)

    def test_target_server_preview_updates_from_selected_mode(self):
        app = webui("app.js")

        self.assertIn("const PRODUCTION_URL = \"__PRODUCTION_URL__\";", app)
        self.assertIn("const LOCAL_URL = \"__LOCAL_URL__\";", app)
        self.assertIn("function resolveTargetServerUrl()", app)
        self.assertIn("function updateTargetServerSummary()", app)
        self.assertIn('setText("effective-server", resolveTargetServerUrl());', app)
        self.assertIn("updateTargetServerSummary();", app)

    def test_local_target_uses_host_backend_address(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            store = GatewayConfigStore(str(Path(tmpdir) / "gateway_config.json"))

            saved = store.save({"target_mode": "local"})

        self.assertEqual(saved["server_url"], "ws://127.0.0.1:5051/newhorizons/gateway/ws")

    def test_gateway_distribution_is_host_only(self):
        removed = [
            "Dockerfile",
            "docker-compose.yml",
            "docker-compose.container-discovery.yml",
            ".dockerignore",
            "scripts/discovery_proxy.py",
            "scripts/start.sh",
            "scripts/stop.sh",
            "scripts/start.ps1",
            "scripts/stop.ps1",
            "scripts/start_docker.sh",
            "scripts/start_docker.ps1",
            "scripts/stop_docker.sh",
            "scripts/stop_docker.ps1",
        ]

        self.assertEqual([path for path in removed if (ROOT / path).exists()], [])
        self.assertFalse(any("docker" in entry.lower() for entry in ALLOWED_UPDATE_ENTRIES))

    def test_python_start_gateway_defaults_to_host_gateway_on_macos(self):
        python_script = (ROOT / "scripts" / "start.py").read_text(encoding="utf-8")

        self.assertIn("GatewayBootloader", python_script)
        self.assertIn("slot_a", python_script)
        self.assertIn("start_runtime.py", python_script)

    def test_gateway_windows_docs_use_python_entrypoints(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")

        self.assertIn("python scripts/start.py", readme)
        self.assertIn("python scripts/stop.py", readme)
        self.assertNotIn("start.sh", readme)
        self.assertNotIn("stop.sh", readme)
        self.assertNotIn("start.ps1", readme)
        self.assertNotIn("stop.ps1", readme)

    def test_python_launcher_runs_foreground_tui_on_macos(self):
        bootloader_script = (ROOT / "scripts" / "start.py").read_text(encoding="utf-8")
        runtime_script = (ROOT / "scripts" / "start_runtime.py").read_text(encoding="utf-8")

        self.assertIn("GatewayBootloader", bootloader_script)
        self.assertIn("GatewayConsoleApp", runtime_script)
        self.assertNotIn("nohup", runtime_script)
        self.assertNotIn("disown", runtime_script)

    def test_python_start_script_detects_legacy_docker_port_conflicts(self):
        python_script = (ROOT / "scripts" / "start.py").read_text(encoding="utf-8")

        self.assertIn("22346", python_script)
        self.assertIn("13250", python_script)
        self.assertIn("5052", python_script)

    def test_windows_python_launcher_shows_dedicated_gateway_console_banner(self):
        bootloader_script = (ROOT / "scripts" / "start.py").read_text(encoding="utf-8")
        runtime_script = (ROOT / "scripts" / "start_runtime.py").read_text(encoding="utf-8")

        self.assertIn("NH Gateway", runtime_script)
        self.assertIn("Closing this window stops Gateway", runtime_script)
        self.assertIn("Web UI", runtime_script)
        self.assertIn("CREATE_NEW_CONSOLE", bootloader_script)
        self.assertNotIn("CREATE_NO_WINDOW", bootloader_script)
        self.assertIn("console_status_path", runtime_script)
        self.assertIn("Status polls", runtime_script)

    def test_windows_python_launcher_uses_textual_tui(self):
        script = (ROOT / "scripts" / "start_runtime.py").read_text(encoding="utf-8")
        tui_source = (ROOT / "newhorizons_gateway" / "gateway_tui.py").read_text(encoding="utf-8")
        requirements = (ROOT / "requirements.txt").read_text(encoding="utf-8")
        pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")

        self.assertIn("GatewayConsoleApp", script)
        self.assertIn("newhorizons_gateway.gateway_tui", script)
        self.assertIn("from textual.app import App", tui_source)
        self.assertIn("Log", tui_source)
        self.assertIn("Header", tui_source)
        self.assertIn("Footer", tui_source)
        self.assertIn("textual", requirements)
        self.assertIn("textual", pyproject)

    def test_gateway_tui_quit_path_notifies_shutdown_and_ctrl_c_binding(self):
        tui_source = (ROOT / "newhorizons_gateway" / "gateway_tui.py").read_text(encoding="utf-8")
        start_source = (ROOT / "scripts" / "start_runtime.py").read_text(encoding="utf-8")

        self.assertIn('BINDINGS = [("ctrl+c", "quit", "Quit")]', tui_source)
        self.assertIn("def action_quit", tui_source)
        self.assertIn("self._notify_exit()", tui_source)
        self.assertIn("stop_event.set()", start_source)
        self.assertIn("stream.detach_ui()", start_source)
        self.assertIn("gateway_thread.join(timeout=5.0)", start_source)

    def test_serve_device_queues_direct_standard_udp_command(self):
        upstream = FakeUpstream()
        upstream.is_connected = lambda: True
        state = GatewayState()
        state.record_findme_request(
            {"device_uid": "3CDC7545CCD0", "device_name": "Device", "mode": "normal"},
            ("192.168.1.152", 22346),
            accepted=True,
        )
        udp_control = FakeUDPControl()
        with tempfile.TemporaryDirectory() as tmpdir:
            store = GatewayConfigStore(str(Path(tmpdir) / "gateway_config.json"))
            store.save({"gateway_id": "gw-target", "enabled": True})
            server = GatewayWebServer("127.0.0.1", 0, store, state, upstream, udp_control)
            response = server.app.test_client().post("/api/devices/3CDC7545CCD0/serve")

        self.assertEqual(response.status_code, 200)
        claim = response.get_json()["claim"]
        self.assertEqual(len(udp_control.direct), 1)
        uid, addr, payload = udp_control.direct[0]
        self.assertEqual(uid, "3CDC7545CCD0")
        self.assertEqual(addr, ("192.168.1.152", 13250))
        self.assertEqual(payload["command"], "findme_switch_gateway")
        self.assertEqual(payload["request_id"], f"findme-claim-{claim['claim_id']}")
        self.assertEqual(payload["preferred_gateway_id"], "gw-target")
        self.assertEqual(payload["claim_id"], claim["claim_id"])
        self.assertEqual(payload["expires_at_ms"], claim["expires_at_ms"])

    def test_gateway_runtime_uses_udp_for_all_commands(self):
        # Gateway sends commands to devices via UDP only (no direct TCP from gateway).
        # The device's UDP command socket is the same socket used for sending stream
        # data (kUdpStreamPort=13250), so sessions must target addr not CONTROL_PORT.
        main_source = (ROOT / "newhorizons_gateway" / "main.py").read_text(encoding="utf-8")
        local_device_source = (ROOT / "newhorizons_gateway" / "local_device.py").read_text(encoding="utf-8")
        web_source = webui_source()

        self.assertNotIn("LocalTCPControlServer", main_source)
        self.assertNotIn("LocalTCPControlServer", local_device_source)
        self.assertNotIn("socketserver", local_device_source)
        self.assertNotIn("json.dumps", local_device_source)
        self.assertNotIn("send_control_command", main_source)
        self.assertNotIn("arduino_sessions", main_source)
        self.assertNotIn("CONTROL_PORT", main_source)
        self.assertIn("udp_commands.set_session", main_source)
        self.assertNotIn("udp_commands.set_session(device_uid, (addr[0], CONTROL_PORT))", main_source)
        self.assertNotIn("TCP control", web_source)

    def test_gateway_command_path_uses_udp_for_all_commands(self):
        # Commands from the upstream server are dispatched to the device via UDP.
        # Both binary packets (heartbeat/stream) and JSON control frames register the
        # session to addr directly: the device's UDP socket is bound to kUdpStreamPort
        # (13250) and receives commands on that same socket (ControlServer::serviceUdpCommand).
        main_source = (ROOT / "newhorizons_gateway" / "main.py").read_text(encoding="utf-8")

        self.assertNotIn("send_control_command", main_source)
        self.assertNotIn("arduino_addr = arduino_sessions.get(normalized_uid)", main_source)
        self.assertNotIn('transport_path": "arduino_tcp"', main_source)
        self.assertNotIn("udp_commands.set_session(device_uid, (addr[0], CONTROL_PORT))", main_source)
        self.assertIn("if udp_commands.send_command(normalized_uid, payload):", main_source)
        self.assertIn("udp_commands.set_session(device_uid, addr)", main_source)
        self.assertIn("arduino_hosts", main_source)
        self.assertNotIn("arduino_sessions", main_source)

    def test_gateway_web_ui_keeps_settings_and_update_controls(self):
        page = webui("index.html")

        self.assertNotIn('<div class="eyebrow">New Horizons OS</div>', page)
        for node_id in (
            "gateway-id-input", "setup-wizard", "setup-gateway-id-input", "gateway-enabled", "remote-management",
            "auto-gateway-id", "target-mode", "manual-url", "save-settings", "revert-settings",
            "check-update", "start-update", "restart-gateway", "update-progress", "overlay-update-progress",
            "discover-nearby", "serving-list", "nearby-list", "denied-list", "claim-body",
            "theme-toggle", "language-select",
        ):
            self.assertIn(f'id="{node_id}"', page, node_id)
        self.assertNotIn('id="download-progress"', page)
        self.assertNotIn('id="apply-progress"', page)

    def test_gateway_web_ui_has_force_update_overlay_and_changelog_panel(self):
        page = webui("index.html")
        app = webui("app.js")

        for node_id in (
            "update-required-overlay", "update-center", "active-slot-version", "pending-slot-version",
            "server-latest-version", "manifest-latest-version", "last-update-check", "update-notes",
            "overlay-update-notes", "overlay-start-update",
        ):
            self.assertIn(f'id="{node_id}"', page, node_id)
        self.assertIn("required_update", app)
        self.assertIn("notes_markdown", app)
        self.assertIn("function localizePhaseCode", app)
        self.assertIn("function localizeSource", app)
        # The required update locks the page: the dialog is modal and the rest inert.
        self.assertIn('role="alertdialog"', page)
        self.assertIn("function setGatewayLock(locked)", app)

    def test_gateway_update_center_has_green_healthy_state(self):
        app = webui("app.js")

        self.assertIn(".update-center.ok", webui("app.css"))
        self.assertIn("healthyUpdateCenter", app)
        self.assertIn('setClass("update-center", `settings-card update-status update-center${healthyUpdateCenter ? " ok" : ""}`);', app)

    def test_gateway_setup_wizard_prefetches_id_once_without_overwriting_input(self):
        web_source = webui("app.js")

        self.assertIn("let setupGatewayIdSuggested = false", web_source)
        self.assertIn("if (!hasGatewayId && !setupGatewayIdSuggested)", web_source)
        self.assertIn('document.getElementById("setup-gateway-id-input").value = payload.gateway_id || ""', web_source)
        self.assertIn("setupGatewayIdSuggested = true", web_source)

    def test_gateway_config_defaults_disabled_and_persists_enable_state(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "gateway_config.json"
            store = GatewayConfigStore(str(path))

            self.assertFalse(store.snapshot()["enabled"])
            self.assertEqual(store.snapshot()["gateway_id"], "")

            saved = store.save({"gateway_id": "nh-gateway-test", "enabled": True})
            self.assertTrue(saved["enabled"])
            self.assertEqual(saved["gateway_id"], "nh-gateway-test")

            reloaded = GatewayConfigStore(str(path))
            self.assertTrue(reloaded.snapshot()["enabled"])
            self.assertEqual(reloaded.snapshot()["gateway_id"], "nh-gateway-test")

    def test_gateway_settings_require_valid_id_before_enable(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            store = GatewayConfigStore(str(Path(tmpdir) / "gateway_config.json"))
            server = GatewayWebServer("127.0.0.1", 0, store, GatewayState(), FakeUpstream())
            client = server.app.test_client()

            missing = client.post("/api/settings", json={"enabled": True, "gateway_id": ""})
            bad = client.post("/api/settings", json={"enabled": True, "gateway_id": "bad id!"})
            good = client.post("/api/settings", json={"enabled": True, "gateway_id": "nh-gateway-test"})

            self.assertEqual(missing.status_code, 400)
            self.assertEqual(bad.status_code, 400)
            self.assertEqual(good.status_code, 200)
            self.assertTrue(good.get_json()["config"]["enabled"])

    def test_gateway_settings_callback_receives_saved_config(self):
        seen = []
        with tempfile.TemporaryDirectory() as tmpdir:
            store = GatewayConfigStore(str(Path(tmpdir) / "gateway_config.json"))
            server = GatewayWebServer("127.0.0.1", 0, store, GatewayState(), FakeUpstream(), on_config_saved=seen.append)
            client = server.app.test_client()

            response = client.post("/api/settings", json={"enabled": True, "gateway_id": "nh-gateway-test"})

            self.assertEqual(response.status_code, 200)
            self.assertEqual(seen[-1]["gateway_id"], "nh-gateway-test")
            self.assertTrue(seen[-1]["enabled"])

    def test_gateway_settings_save_remote_management_only_when_sent(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            store = GatewayConfigStore(str(Path(tmpdir) / "gateway_config.json"))
            server = GatewayWebServer("127.0.0.1", 0, store, GatewayState(), FakeUpstream())
            client = server.app.test_client()

            client.post("/api/settings", json={"gateway_id": "nh-gateway-test", "remote_management": False})
            self.assertFalse(store.snapshot()["remote_management"])
            # The setup wizard leaves the key out: the saved value stays.
            client.post("/api/settings", json={"gateway_id": "nh-gateway-test", "enabled": True})
            self.assertFalse(store.snapshot()["remote_management"])

    def test_gateway_web_ui_poll_does_not_reset_i18n_placeholders(self):
        page = webui("index.html")
        app = webui("app.js")
        # applyI18n() rewrites every [data-i18n] node: from the 2 s poll it
        # made the update overlay and panel flash.
        self.assertNotIn("applyI18n()", function_body(app, "async function refresh() {"))
        self.assertNotIn("applyI18n()", function_body(app, "function render(data) {"))
        for node_id in ("update-banner", "update-notes", "update-progress-phase", "latest-version-label",
                        "overlay-update-banner", "overlay-update-notes", "overlay-update-progress-phase"):
            self.assertNotRegex(page, r'id="%s"[^>]*data-i18n=' % node_id)
        # Lists are kept row by row instead of rebuilt with innerHTML.
        self.assertIn("function syncList(", app)
        self.assertNotIn(".innerHTML = `", app)

    def test_gateway_settings_enabled_save_does_not_require_token_flow(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            store = GatewayConfigStore(str(Path(tmpdir) / "gateway_config.json"))
            upstream = FakeUpstream()
            server = GatewayWebServer("127.0.0.1", 0, store, GatewayState(), upstream)
            client = server.app.test_client()

            response = client.post(
                "/api/settings",
                json={"gateway_id": "nh-gateway-test", "enabled": True, "manual_url": "ws://example/ws", "target_mode": "manual"},
            )

            self.assertEqual(response.status_code, 200)
            self.assertEqual(upstream.updated[-1][1], "")
            self.assertNotIn("auth_token", response.get_json()["config"])

    def test_status_route_refreshes_update_state(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            store = GatewayConfigStore(str(Path(tmpdir) / "gateway_config.json"))
            manager = FakeUpdateManager({"phase": "idle", "required_update": False, "active_slot": "slot_a", "inactive_slot": "slot_b", "pending_slot": ""})
            server = GatewayWebServer("127.0.0.1", 0, store, GatewayState(), FakeUpstream(), update_manager=manager)
            client = server.app.test_client()

            response = client.get("/api/status")

            self.assertEqual(response.status_code, 200)
            self.assertEqual(manager.refresh_calls, 1)
            self.assertEqual(response.get_json()["update_state"]["phase"], "idle")

    def test_update_required_blocks_non_update_routes(self):
        payload = {
            "phase": "checked",
            "required_update": True,
            "latest_gateway_version": "v9.9.9",
            "latest_version": "",
            "notes_markdown": "",
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            store = GatewayConfigStore(str(Path(tmpdir) / "gateway_config.json"))
            store.save({"gateway_id": "nh-gateway-test", "enabled": True})
            state = GatewayState()
            state.record_findme_request(
                {"device_uid": "3CDC7545CCD0", "device_name": "Device", "mode": "normal"},
                ("192.168.1.152", 22346),
                accepted=True,
            )
            upstream = FakeUpstream()
            upstream.is_connected = lambda: True
            server = GatewayWebServer(
                "127.0.0.1",
                0,
                store,
                state,
                upstream,
                FakeUDPControl(),
                update_manager=FakeUpdateManager(payload),
            )
            client = server.app.test_client()

            routes = [
                client.post("/api/settings", json={"gateway_id": "nh-gateway-test", "enabled": True}),
                client.post("/api/discover"),
                client.post("/api/devices/3CDC7545CCD0/reject"),
                client.post("/api/devices/3CDC7545CCD0/allow"),
                client.post("/api/devices/3CDC7545CCD0/serve"),
            ]

            for response in routes:
                self.assertEqual(response.status_code, 409)
                self.assertEqual(response.get_json(), {"ok": False, "error": "update_required"})

    def test_gateway_web_ui_sections_follow_the_desktop_dialog(self):
        page = webui("index.html")

        order = [page.index(f'data-section-panel="{name}"') for name in ("overview", "devices", "connection", "update")]
        self.assertEqual(order, sorted(order))
        for name in ("overview", "devices", "connection", "update"):
            self.assertIn(f'data-section="{name}"', page)
        self.assertNotIn('id="gateway-token-input"', page)
        self.assertNotIn('id="clear-gateway-token"', page)
        self.assertNotIn("auth_token_configured", webui_source())
        self.assertNotIn("clear_auth_token", webui_source())

    def test_webui_strings_exist_in_every_language(self):
        tables = i18n_tables()
        self.assertEqual(set(tables), {"en", "ja", "zh-CN"})
        self.assertEqual(tables["en"], tables["ja"], tables["en"] ^ tables["ja"])
        self.assertEqual(tables["en"], tables["zh-CN"], tables["en"] ^ tables["zh-CN"])

        page = webui("index.html")
        app = webui("app.js")
        used = set(re.findall(r'data-i18n(?:-aria)?="([^"]+)"', page))
        used |= set(re.findall(r'\b(?:tr|fmt)\("([^"]+)"', app))
        used |= set(re.findall(r'label: "([A-Za-z]+)"', app))
        used |= set(re.findall(r': "((?:phase|progress|boot|claimState|status|source|theme)[A-Z][A-Za-z]*)"', app))
        missing = sorted(key for key in used if key not in tables["en"])
        self.assertEqual(missing, [])

    def test_webui_files_are_served_without_cache(self):
        from newhorizons_gateway import __version__
        from newhorizons_gateway.config_store import PRODUCTION_URL
        from newhorizons_gateway.web import WEBUI_ASSETS

        with tempfile.TemporaryDirectory() as tmpdir:
            store = GatewayConfigStore(str(Path(tmpdir) / "gateway_config.json"))
            client = GatewayWebServer("127.0.0.1", 0, store, GatewayState(), FakeUpstream()).app.test_client()

            index = client.get("/")
            self.assertEqual(index.status_code, 200)
            self.assertEqual(index.headers["Cache-Control"], "no-cache")
            html = index.get_data(as_text=True)
            self.assertNotIn("__VERSION__", html)
            self.assertIn(f"/assets/app.js?v={__version__}", html)
            for name in re.findall(r'/assets/([\w.]+)\?v=', html):
                self.assertIn(name, WEBUI_ASSETS)
                response = client.get(f"/assets/{name}")
                self.assertEqual(response.status_code, 200, name)
                self.assertEqual(response.headers["Cache-Control"], "no-cache")

            app = client.get("/assets/app.js").get_data(as_text=True)
            self.assertNotIn("__PRODUCTION_URL__", app)
            self.assertIn(PRODUCTION_URL, app)
            self.assertEqual(client.get("/assets/web.py").status_code, 404)
            self.assertEqual(client.get("/assets/..%2Fweb.py").status_code, 404)

    def test_top_bar_has_no_status_pill(self):
        # The overview's status card already says online/offline.
        page = webui("index.html")
        app = webui("app.js")
        self.assertNotIn("topbar-status", page)
        self.assertNotIn("topbar-status", app)
        self.assertNotIn("topbar-center", webui("app.css"))
        self.assertIn('setText("card-status", tr(STATUS_TEXT.unreachable));', app)

    def test_theme_toggle_matches_the_desktop(self):
        app = webui("app.js")
        # lucide SunMoon / Moon as the Desktop's ThemeToggle draws them.
        self.assertIn('stroke-width="1.8"', app)
        self.assertIn("M14.837 16.385a6 6 0 1 1-7.223-7.222", app)
        self.assertIn("M20.985 12.486a9 9 0 1 1-9.473-9.472", app)
        self.assertIn('`${tr("themeLabel")}: ${modeLabel}', app)
        self.assertIn("nextChange: () =>", webui("theme.js"))
        i18n = webui("i18n.js")
        for key in ("themeLabel", "themeNextDark", "themeNextLight"):
            self.assertEqual(i18n.count(f"{key}:"), 3, key)

    def test_dropdowns_are_the_desktop_select(self):
        page = webui("index.html")
        select = webui("select.js")
        self.assertIn('<script src="/assets/select.js?v=__VERSION__"></script>', page)
        self.assertLess(page.index("/assets/select.js"), page.index("/assets/app.js"))
        self.assertIn("window.NHGSelect.enhanceAll();", webui("app.js"))
        # The native select stays the source of truth for app.js.
        self.assertIn('select.dispatchEvent(new Event("change", { bubbles: true }));', select)
        self.assertIn('Object.defineProperty(select, "value"', select)
        css = webui("app.css")
        for rule in (".nh-select-native { display: none; }", ".nh-select-menu {", ".nh-select-option.active"):
            self.assertIn(rule, css)
        # Checkboxes: the native box in the accent colour, no custom size.
        self.assertIn(".switch-row input { grid-row: span 2; margin: 3px 0 0; accent-color: var(--accent); cursor: pointer; }", css)

if __name__ == "__main__":
    unittest.main()
