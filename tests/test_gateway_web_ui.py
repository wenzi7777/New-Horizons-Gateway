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
    def test_target_server_form_is_not_overwritten_while_dirty(self):
        web_source = (ROOT / "newhorizons_gateway" / "web.py").read_text(encoding="utf-8")

        self.assertIn("let targetSettingsDirty = false", web_source)
        self.assertIn("if (targetSettingsDirty) return;", web_source)
        self.assertIn('"target-mode").addEventListener("change"', web_source)
        self.assertIn("targetSettingsDirty = false;", web_source)

    def test_compose_does_not_force_production_mode_over_saved_config(self):
        compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")

        self.assertIn("NEWHORIZONS_GATEWAY_TARGET_MODE: ${NEWHORIZONS_GATEWAY_TARGET_MODE:-}", compose)

    def test_start_gateway_defaults_to_host_gateway_on_macos(self):
        script = (ROOT / "scripts" / "start_gateway.sh").read_text(encoding="utf-8")

        self.assertIn('HOST_GATEWAY=1', script)
        self.assertIn('exec "${SCRIPT_DIR}/start_gateway_host.sh"', script)
        self.assertIn("--docker", script)

    def test_host_gateway_script_uses_screen_for_persistent_background_run(self):
        script = (ROOT / "scripts" / "start_gateway_host.sh").read_text(encoding="utf-8")

        self.assertIn("SESSION_NAME=", script)
        self.assertIn("screen -dmS", script)
        self.assertIn("screen:${SESSION_NAME}", script)

    def test_gateway_runtime_is_udp_only_by_default(self):
        main_source = (ROOT / "newhorizons_gateway" / "main.py").read_text(encoding="utf-8")
        local_device_source = (ROOT / "newhorizons_gateway" / "local_device.py").read_text(encoding="utf-8")
        web_source = (ROOT / "newhorizons_gateway" / "web.py").read_text(encoding="utf-8")

        self.assertNotIn("LocalTCPControlServer", main_source)
        self.assertNotIn("LocalTCPControlServer", local_device_source)
        self.assertNotIn("socketserver", local_device_source)
        self.assertNotIn("json.dumps", local_device_source)
        self.assertNotIn("tcp_server.send_command", main_source)
        self.assertNotIn("TCP control", web_source)
        self.assertNotIn("TCP</th>", web_source)

    def test_gateway_web_ui_removes_os_eyebrow_and_adds_id_enable_update_controls(self):
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

    def test_gateway_config_defaults_disabled_and_persists_enable_state(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "gateway_config.json"
            store = GatewayConfigStore(str(path))

            self.assertFalse(store.snapshot()["enabled"])

            saved = store.save({"gateway_id": "nh-gateway-test", "enabled": True})
            self.assertTrue(saved["enabled"])
            self.assertEqual(saved["gateway_id"], "nh-gateway-test")

            reloaded = GatewayConfigStore(str(path))
            self.assertTrue(reloaded.snapshot()["enabled"])
            self.assertEqual(reloaded.snapshot()["gateway_id"], "nh-gateway-test")

    def test_gateway_settings_require_valid_id_before_enable(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            store = GatewayConfigStore(str(Path(tmpdir) / "gateway_config.json"))
            server = GatewayWebServer("127.0.0.1", 0, store, GatewayState(), FakeUpstream(), None)
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
            server = GatewayWebServer("127.0.0.1", 0, store, GatewayState(), FakeUpstream(), None, on_config_saved=seen.append)
            client = server.app.test_client()

            response = client.post("/api/settings", json={"enabled": True, "gateway_id": "nh-gateway-test"})

            self.assertEqual(response.status_code, 200)
            self.assertEqual(seen[-1]["gateway_id"], "nh-gateway-test")
            self.assertTrue(seen[-1]["enabled"])


if __name__ == "__main__":
    unittest.main()
