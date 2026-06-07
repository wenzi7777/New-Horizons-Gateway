import unittest
import tempfile
from pathlib import Path

from newhorizons_gateway.config_store import GatewayConfigStore
from newhorizons_gateway.state import GatewayState
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


class GatewayWebUiTest(unittest.TestCase):
    def test_gateway_config_no_longer_persists_token(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            store = GatewayConfigStore(str(Path(tmpdir) / "gateway_config.json"))

            self.assertNotIn("auth_token", store.snapshot())

    def test_gateway_startup_has_no_token_env_override(self):
        compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
        host_script = (ROOT / "scripts" / "start.sh").read_text(encoding="utf-8")

        self.assertNotIn("NEWHORIZONS_GATEWAY_TOKEN", compose)
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

    def test_compose_does_not_force_production_mode_over_saved_config(self):
        compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")

        self.assertIn("NEWHORIZONS_GATEWAY_TARGET_MODE: ${NEWHORIZONS_GATEWAY_TARGET_MODE:-}", compose)

    def test_start_gateway_defaults_to_host_gateway_on_macos(self):
        # start.sh IS the host-mode script for macOS/Linux — no wrapper needed.
        script = (ROOT / "scripts" / "start.sh").read_text(encoding="utf-8")

        self.assertIn("Running on the host preserves the real device UDP source IP", script)
        self.assertIn("http://127.0.0.1:5052", script)

    def test_start_gateway_windows_script_uses_power_shell_background_process(self):
        script = (ROOT / "scripts" / "start.ps1").read_text(encoding="utf-8")

        self.assertIn('param(', script)
        self.assertIn('$Process = Start-Process', script)
        self.assertIn('http://127.0.0.1:5052', script)

    def test_host_gateway_script_runs_in_background_with_pid_tracking(self):
        # start.sh uses nohup + disown for a persistent background process on macOS/Linux.
        script = (ROOT / "scripts" / "start.sh").read_text(encoding="utf-8")

        self.assertIn("PID_FILE", script)
        self.assertIn("nohup", script)
        self.assertIn("disown", script)

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
        self.assertIn('id="refresh-now"', web_source)
        self.assertIn('id="discover-nearby"', web_source)
        self.assertIn('id="nearby-toggle"', web_source)
        self.assertIn('data-i18n="operations"', web_source)
        self.assertNotIn('id="toggle-nearby"', web_source)

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
