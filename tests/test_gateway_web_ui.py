import unittest
import tempfile
from pathlib import Path

from newhorizons_gateway.config_store import GatewayConfigStore
from newhorizons_gateway.state import GatewayState
from newhorizons_gateway.update_manager import ALLOWED_UPDATE_ENTRIES
from newhorizons_gateway.web import GatewayWebServer


ROOT = Path(__file__).resolve().parents[1]


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

    def restart(self):
        self.payload["phase"] = "restarting"
        return dict(self.payload)


class GatewayWebUiTest(unittest.TestCase):
    def test_gateway_config_no_longer_persists_token(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            store = GatewayConfigStore(str(Path(tmpdir) / "gateway_config.json"))

            self.assertNotIn("auth_token", store.snapshot())

    def test_gateway_startup_has_no_token_env_override(self):
        host_script = (ROOT / "scripts" / "start.sh").read_text(encoding="utf-8")

        self.assertNotIn("NEWHORIZONS_GATEWAY_TOKEN", host_script)

    def test_target_server_form_is_not_overwritten_while_dirty(self):
        web_source = (ROOT / "newhorizons_gateway" / "web.py").read_text(encoding="utf-8")

        self.assertIn("let targetSettingsDirty = false", web_source)
        self.assertIn("if (targetSettingsDirty) return;", web_source)
        self.assertIn('"target-mode").addEventListener("change"', web_source)
        self.assertIn("targetSettingsDirty = false;", web_source)

    def test_target_server_preview_updates_from_selected_mode(self):
        web_source = (ROOT / "newhorizons_gateway" / "web.py").read_text(encoding="utf-8")

        self.assertIn("const PRODUCTION_URL = \"__PRODUCTION_URL__\";", web_source)
        self.assertIn("const LOCAL_URL = \"__LOCAL_URL__\";", web_source)
        self.assertIn("function resolveTargetServerUrl()", web_source)
        self.assertIn("function updateTargetServerSummary()", web_source)
        self.assertIn('text("effective-server", resolveTargetServerUrl());', web_source)
        self.assertIn("updateTargetServerSummary();", web_source)

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
            "scripts/start.ps1",
            "scripts/stop.ps1",
            "scripts/start_docker.sh",
            "scripts/start_docker.ps1",
            "scripts/stop_docker.sh",
            "scripts/stop_docker.ps1",
        ]

        self.assertEqual([path for path in removed if (ROOT / path).exists()], [])
        self.assertFalse(any("docker" in entry.lower() for entry in ALLOWED_UPDATE_ENTRIES))

    def test_start_gateway_defaults_to_host_gateway_on_macos(self):
        # start.sh IS the host-mode script for macOS/Linux — no wrapper needed.
        script = (ROOT / "scripts" / "start.sh").read_text(encoding="utf-8")

        self.assertIn("Running on the host preserves the real device UDP source IP", script)
        self.assertIn("http://127.0.0.1:5052", script)

    def test_gateway_windows_docs_use_python_entrypoints(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")

        self.assertIn("python scripts/start.py", readme)
        self.assertIn("python scripts/stop.py", readme)
        self.assertNotIn("start.ps1", readme)
        self.assertNotIn("stop.ps1", readme)

    def test_host_gateway_script_runs_in_background_with_pid_tracking(self):
        # start.sh uses nohup + disown for a persistent background process on macOS/Linux.
        script = (ROOT / "scripts" / "start.sh").read_text(encoding="utf-8")

        self.assertIn("PID_FILE", script)
        self.assertIn("nohup", script)
        self.assertIn("disown", script)

    def test_host_start_scripts_detect_legacy_docker_port_conflicts(self):
        shell_script = (ROOT / "scripts" / "start.sh").read_text(encoding="utf-8")
        python_script = (ROOT / "scripts" / "start.py").read_text(encoding="utf-8")

        self.assertIn("Legacy Docker Gateway", shell_script)
        self.assertIn("22346", shell_script)
        self.assertIn("13250", shell_script)
        self.assertIn("5052", shell_script)
        self.assertIn("command -v ss", shell_script)
        self.assertIn("22346", python_script)
        self.assertIn("13250", python_script)
        self.assertIn("5052", python_script)

    def test_windows_python_launcher_shows_dedicated_gateway_console_banner(self):
        script = (ROOT / "scripts" / "start.py").read_text(encoding="utf-8")

        self.assertIn("New Horizons Gateway", script)
        self.assertIn("Closing this window stops Gateway", script)
        self.assertIn("Web UI", script)
        self.assertIn("CREATE_NEW_CONSOLE", script)
        self.assertNotIn("CREATE_NO_WINDOW", script)
        self.assertIn("console_status_path", script)
        self.assertIn("Status polls", script)

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
        web_source = (ROOT / "newhorizons_gateway" / "web.py").read_text(encoding="utf-8")

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

    def test_gateway_web_ui_removes_os_eyebrow_and_keeps_update_controls(self):
        web_source = (ROOT / "newhorizons_gateway" / "web.py").read_text(encoding="utf-8")

        self.assertNotIn('<div class="eyebrow">New Horizons OS</div>', web_source)
        self.assertIn('id="gateway-id-input"', web_source)
        self.assertIn('id="setup-wizard"', web_source)
        self.assertIn('id="setup-gateway-id-input"', web_source)
        self.assertIn('id="gateway-enabled"', web_source)
        self.assertIn('id="auto-gateway-id"', web_source)
        self.assertIn('id="check-update"', web_source)
        self.assertIn('id="download-update"', web_source)
        self.assertIn('id="apply-update"', web_source)
        self.assertIn('id="restart-gateway"', web_source)
        self.assertIn('id="refresh-now"', web_source)
        self.assertIn('id="discover-nearby"', web_source)
        self.assertIn('id="nearby-toggle"', web_source)
        self.assertIn('data-i18n="operations"', web_source)
        self.assertNotIn('id="toggle-nearby"', web_source)

    def test_gateway_web_ui_has_force_update_overlay_and_changelog_panel(self):
        web_source = (ROOT / "newhorizons_gateway" / "web.py").read_text(encoding="utf-8")

        self.assertIn('id="update-required-overlay"', web_source)
        self.assertIn('id="update-center"', web_source)
        self.assertIn('id="server-latest-version"', web_source)
        self.assertIn('id="manifest-latest-version"', web_source)
        self.assertIn('id="last-update-check"', web_source)
        self.assertIn('id="update-notes"', web_source)
        self.assertIn("required_update", web_source)
        self.assertIn("notes_markdown", web_source)

    def test_gateway_update_center_has_green_healthy_state(self):
        web_source = (ROOT / "newhorizons_gateway" / "web.py").read_text(encoding="utf-8")

        self.assertIn(".update-center.ok", web_source)
        self.assertIn("healthyUpdateCenter", web_source)
        self.assertIn('updateCenter.className = `panel span-12 update-center${healthyUpdateCenter ? " ok" : ""}`', web_source)

    def test_gateway_setup_wizard_prefetches_id_once_without_overwriting_input(self):
        web_source = (ROOT / "newhorizons_gateway" / "web.py").read_text(encoding="utf-8")

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
            manager = FakeUpdateManager({"phase": "idle", "required_update": False})
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

    def test_gateway_web_ui_moves_update_last_and_removes_token_controls(self):
        web_source = (ROOT / "newhorizons_gateway" / "web.py").read_text(encoding="utf-8")

        operations_index = web_source.index('data-i18n="operations"')
        claims_index = web_source.index('data-i18n="claims"')
        update_index = web_source.rindex('data-i18n="update"')

        self.assertLess(operations_index, claims_index)
        self.assertGreater(update_index, claims_index)
        self.assertNotIn('id="gateway-token-input"', web_source)
        self.assertNotIn('id="clear-gateway-token"', web_source)
        self.assertNotIn("auth_token_configured", web_source)
        self.assertNotIn("clear_auth_token", web_source)


if __name__ == "__main__":
    unittest.main()
