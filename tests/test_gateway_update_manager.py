import json
import tempfile
import unittest
from pathlib import Path

from newhorizons_gateway import __version__
from newhorizons_gateway.update_manager import GatewayUpdateManager


class GatewayUpdateManagerTest(unittest.TestCase):
    def test_server_version_newer_requires_update_without_manifest(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            manager = GatewayUpdateManager(app_root=tmpdir, staging_root=Path(tmpdir) / "updates")

            manager.set_server_latest_version("v9.9.9")
            state = manager.state()

            self.assertTrue(state["required_update"])
            self.assertEqual(state["latest_gateway_version"], "v9.9.9")
            self.assertEqual(state["update_signal_source"], "server_ws")
            self.assertEqual(state["latest_version"], "")

    def test_same_server_version_does_not_lock_gateway(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            manager = GatewayUpdateManager(app_root=tmpdir, staging_root=Path(tmpdir) / "updates")

            manager.set_server_latest_version(__version__)

            self.assertFalse(manager.state()["required_update"])

    def test_manifest_refresh_populates_notes_for_required_update(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            notes = tmp_path / "notes.md"
            notes.write_text("# Changes\n\n- Force OTA update\n", encoding="utf-8")
            manifest = tmp_path / "gateway-latest.json"
            manifest.write_text(json.dumps({
                "version": "v9.9.9",
                "zip_url": "https://example.com/newhorizons-gateway-v9.9.9.zip",
                "sha256": "abc123",
                "notes_url": notes.as_uri(),
            }), encoding="utf-8")

            manager = GatewayUpdateManager(
                app_root=tmpdir,
                staging_root=tmp_path / "updates",
                manifest_url=manifest.as_uri(),
            )

            manager.set_server_latest_version("v9.9.9")
            state = manager.maybe_refresh()

            self.assertTrue(state["required_update"])
            self.assertEqual(state["latest_version"], "v9.9.9")
            self.assertEqual(state["zip_url"], "https://example.com/newhorizons-gateway-v9.9.9.zip")
            self.assertEqual(state["notes_markdown"], "# Changes\n\n- Force OTA update\n")
            self.assertEqual(state["update_signal_source"], "server_ws")

    def test_manifest_failure_keeps_required_update_and_shows_empty_notes(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            manager = GatewayUpdateManager(
                app_root=tmpdir,
                staging_root=Path(tmpdir) / "updates",
                manifest_url=(Path(tmpdir) / "missing.json").as_uri(),
            )

            manager.set_server_latest_version("v9.9.9")
            state = manager.maybe_refresh()

            self.assertTrue(state["required_update"])
            self.assertEqual(state["notes_markdown"], "")
            self.assertEqual(state["phase"], "error")
            self.assertTrue(state["last_error"])


if __name__ == "__main__":
    unittest.main()
