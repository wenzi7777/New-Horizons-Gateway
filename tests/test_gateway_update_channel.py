"""Gateway self-update channels (stable / beta) and the version order."""
import json
import tempfile
import unittest
from pathlib import Path

from newhorizons_gateway import __version__
from newhorizons_gateway.config_store import GatewayConfigStore
from newhorizons_gateway.update_manager import GatewayUpdateManager
from newhorizons_gateway.upstream_wss import UpstreamWSSClient
from newhorizons_gateway.versioning import (
    compare_versions,
    is_prerelease,
    manifest_url_for,
    normalize_channel,
)

ROOT = Path(__file__).resolve().parents[1]
SHARED_FIXTURE = ROOT.parent / "NewHorizonsOS-OTA" / "spec" / "fixtures" / "versions.json"


def sign(value: int) -> int:
    return (value > 0) - (value < 0)


class VersioningTest(unittest.TestCase):
    @unittest.skipUnless(SHARED_FIXTURE.exists(), "NewHorizonsOS-OTA not checked out alongside")
    def test_matches_the_shared_version_vectors(self):
        fixture = json.loads(SHARED_FIXTURE.read_text(encoding="utf-8"))
        for case in fixture["compare"]:
            self.assertEqual(sign(compare_versions(case["a"], case["b"])), case["order"], case)
        for case in fixture["prerelease"]:
            self.assertEqual(is_prerelease(case["version"]), case["prerelease"], case)

    def test_beta_sorts_below_its_release(self):
        self.assertLess(compare_versions("v0.7.0-beta.1", "v0.7.0"), 0)
        self.assertGreater(compare_versions("v0.7.0-beta.1", "v0.6.9"), 0)

    def test_channel_manifests(self):
        self.assertTrue(manifest_url_for("stable").endswith("/releases/gateway-latest.json"))
        self.assertTrue(manifest_url_for("beta").endswith("/releases/gateway-beta.json"))
        # Anything unknown falls back to stable, never onto prereleases.
        self.assertEqual(normalize_channel("nightly"), "stable")
        self.assertEqual(normalize_channel(None), "stable")
        self.assertEqual(normalize_channel("BETA"), "beta")


class UpdateManagerChannelTest(unittest.TestCase):
    def make(self, tmpdir, **kwargs):
        return GatewayUpdateManager(app_root=tmpdir, staging_root=Path(tmpdir) / "updates", **kwargs)

    def test_defaults_to_stable(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            manager = self.make(tmpdir)
            self.assertEqual(manager.update_channel, "stable")
            self.assertTrue(manager.manifest_url.endswith("gateway-latest.json"))
            self.assertEqual(manager.state()["update_channel"], "stable")

    def test_beta_channel_reads_the_beta_manifest(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            manager = self.make(tmpdir, channel="beta")
            self.assertTrue(manager.manifest_url.endswith("gateway-beta.json"))

    def test_explicit_manifest_overrides_channel(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            manager = self.make(tmpdir, manifest_url="file:///tmp/custom.json", channel="beta")
            self.assertEqual(manager.manifest_url, "file:///tmp/custom.json")

    def test_prerelease_of_current_version_is_not_an_update(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            manager = self.make(tmpdir)
            manager.set_server_latest_version(f"{__version__}-beta.1")
            self.assertFalse(manager.state()["required_update"])

    def test_switching_back_to_stable_drops_the_beta_requirement(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            manager = self.make(tmpdir, channel="beta")
            manager.set_server_latest_version("v99.0.0-beta.1")
            self.assertTrue(manager.state()["required_update"])
            state = manager.set_channel("stable")
            self.assertFalse(state["required_update"])
            self.assertEqual(state["latest_gateway_version"], "")
            self.assertEqual(state["update_channel"], "stable")
            self.assertTrue(state["manifest_url"].endswith("gateway-latest.json"))


class ConfigChannelTest(unittest.TestCase):
    def test_config_defaults_and_normalizes_channel(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "config.json"
            store = GatewayConfigStore(str(path))
            self.assertEqual(store.snapshot()["update_channel"], "stable")
            self.assertEqual(store.save({"update_channel": "beta"})["update_channel"], "beta")
            self.assertEqual(GatewayConfigStore(str(path)).snapshot()["update_channel"], "beta")
            self.assertEqual(store.save({"update_channel": "weird"})["update_channel"], "stable")


class HelloChannelTest(unittest.TestCase):
    def test_hello_announces_the_channel(self):
        upstream = UpstreamWSSClient("ws://example.invalid", "gateway-test")
        self.assertEqual(upstream._hello_payload()["update_channel"], "stable")
        upstream.set_update_channel("beta")  # not connected: just remembered
        hello = upstream._hello_payload()
        self.assertEqual(hello["type"], "hello")
        self.assertEqual(hello["update_channel"], "beta")
        self.assertEqual(hello["version"], __version__)


class WebChannelStaticTest(unittest.TestCase):
    def test_web_ui_offers_the_channel_switch(self):
        web = (ROOT / "newhorizons_gateway" / "web.py").read_text(encoding="utf-8")
        self.assertIn('<select id="update-channel">', web)
        self.assertIn('@app.post("/api/update/channel")', web)
        for key in ("updateChannel:", "channelStable:", "channelBeta:", "channelHint:", "channelBetaConfirm:"):
            self.assertEqual(web.count(key), 3, key)  # en, ja, zh-CN


if __name__ == "__main__":
    unittest.main()
