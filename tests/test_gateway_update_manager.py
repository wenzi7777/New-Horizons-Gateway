import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from newhorizons_gateway import __version__
from newhorizons_gateway.update_manager import GatewayUpdateManager


class GatewayUpdateManagerTest(unittest.TestCase):
    def test_state_exposes_slot_boot_metadata(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            manager = GatewayUpdateManager(app_root=tmpdir, staging_root=Path(tmpdir) / "updates")

            state = manager.state()

        self.assertEqual(state["active_slot"], "slot_a")
        self.assertEqual(state["inactive_slot"], "slot_b")
        self.assertEqual(state["pending_slot"], "")
        self.assertEqual(state["boot_phase"], "idle")
        self.assertEqual(state["rollback_reason"], "")
        self.assertFalse(state["health_ready"])

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

    def test_start_update_downloads_and_stages_package_into_inactive_slot_then_requests_switch(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            app_root = tmp_path / "app"
            app_root.mkdir()
            (app_root / "README.md").write_text("old", encoding="utf-8")
            (app_root / "requirements.txt").write_text("old-req", encoding="utf-8")
            (app_root / "pyproject.toml").write_text("old-proj", encoding="utf-8")
            package_dir = app_root / "newhorizons_gateway"
            package_dir.mkdir()
            (package_dir / "__init__.py").write_text('__version__ = "v0.3.1"\n', encoding="utf-8")
            scripts_dir = app_root / "scripts"
            scripts_dir.mkdir()
            (scripts_dir / "start.py").write_text("old-start", encoding="utf-8")

            release_root = tmp_path / "release"
            release_pkg = release_root / "newhorizons_gateway"
            release_pkg.mkdir(parents=True)
            (release_pkg / "__init__.py").write_text('__version__ = "v9.9.9"\n', encoding="utf-8")
            release_scripts = release_root / "scripts"
            release_scripts.mkdir()
            (release_scripts / "start.py").write_text("new-start", encoding="utf-8")
            (release_root / "README.md").write_text("new-readme", encoding="utf-8")
            (release_root / "requirements.txt").write_text("new-req", encoding="utf-8")
            (release_root / "pyproject.toml").write_text("new-proj", encoding="utf-8")
            notes = tmp_path / "notes.md"
            notes.write_text("notes", encoding="utf-8")
            artifact = tmp_path / "gateway.zip"
            with zipfile.ZipFile(artifact, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for child in sorted(release_root.rglob("*")):
                    if child.is_dir():
                        continue
                    archive.write(child, child.relative_to(release_root).as_posix())
            manifest = tmp_path / "gateway-latest.json"
            manifest.write_text(json.dumps({
                "version": "v9.9.9",
                "zip_url": artifact.as_uri(),
                "sha256": __import__("hashlib").sha256(artifact.read_bytes()).hexdigest(),
                "notes_url": notes.as_uri(),
            }), encoding="utf-8")

            manager = GatewayUpdateManager(
                app_root=app_root,
                staging_root=tmp_path / "updates",
                manifest_url=manifest.as_uri(),
            )
            restart_requests = []
            manager.set_restart_callback(lambda: restart_requests.append("requested"))

            manager.set_server_latest_version("v9.9.9")
            manager.start_update()
            manager.wait_for_idle(timeout=5.0)
            state = manager.state()

            self.assertEqual(state["phase"], "switch_pending")
            self.assertEqual(state["active_slot"], "slot_a")
            self.assertEqual(state["pending_slot"], "slot_b")
            self.assertEqual(state["target_version"], "v9.9.9")
            self.assertEqual(state["download_progress_pct"], 100)
            self.assertEqual(state["apply_progress_pct"], 100)
            self.assertEqual(restart_requests, ["requested"])
            self.assertEqual((app_root / "README.md").read_text(encoding="utf-8"), "old")
            self.assertEqual((app_root / "scripts" / "start.py").read_text(encoding="utf-8"), "old-start")
            self.assertEqual((manager.slots_root / "slot_b" / "README.md").read_text(encoding="utf-8"), "new-readme")
            self.assertEqual((manager.slots_root / "slot_b" / "scripts" / "start.py").read_text(encoding="utf-8"), "new-start")

    def test_apply_does_not_move_live_directories_before_copying(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            app_root = tmp_path / "app"
            app_root.mkdir()
            package_dir = app_root / "newhorizons_gateway"
            package_dir.mkdir()
            (package_dir / "__init__.py").write_text('__version__ = "v0.3.3"\n', encoding="utf-8")
            scripts_dir = app_root / "scripts"
            scripts_dir.mkdir()
            (scripts_dir / "start.py").write_text("old-start", encoding="utf-8")
            (app_root / "README.md").write_text("old-readme", encoding="utf-8")
            (app_root / "requirements.txt").write_text("old-req", encoding="utf-8")
            (app_root / "pyproject.toml").write_text("old-proj", encoding="utf-8")

            release_root = tmp_path / "release"
            release_pkg = release_root / "newhorizons_gateway"
            release_pkg.mkdir(parents=True)
            (release_pkg / "__init__.py").write_text('__version__ = "v9.9.9"\n', encoding="utf-8")
            release_scripts = release_root / "scripts"
            release_scripts.mkdir()
            (release_scripts / "start.py").write_text("new-start", encoding="utf-8")
            (release_root / "README.md").write_text("new-readme", encoding="utf-8")
            (release_root / "requirements.txt").write_text("new-req", encoding="utf-8")
            (release_root / "pyproject.toml").write_text("new-proj", encoding="utf-8")
            notes = tmp_path / "notes.md"
            notes.write_text("notes", encoding="utf-8")
            artifact = tmp_path / "gateway.zip"
            with zipfile.ZipFile(artifact, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for child in sorted(release_root.rglob("*")):
                    if child.is_dir():
                        continue
                    archive.write(child, child.relative_to(release_root).as_posix())
            manifest = tmp_path / "gateway-latest.json"
            manifest.write_text(json.dumps({
                "version": "v9.9.9",
                "zip_url": artifact.as_uri(),
                "sha256": __import__("hashlib").sha256(artifact.read_bytes()).hexdigest(),
                "notes_url": notes.as_uri(),
            }), encoding="utf-8")

            manager = GatewayUpdateManager(
                app_root=app_root,
                staging_root=tmp_path / "updates",
                manifest_url=manifest.as_uri(),
            )
            manager.set_server_latest_version("v9.9.9")
            manager.check()
            manager.download()

            from newhorizons_gateway import update_manager as update_manager_module

            def forbid_directory_move(src, dst, *args, **kwargs):
                if Path(src).is_dir():
                    raise AssertionError(f"directory move attempted: {src}")
                return original_move(src, dst, *args, **kwargs)

            original_move = update_manager_module.shutil.move
            with mock.patch.object(update_manager_module.shutil, "move", side_effect=forbid_directory_move):
                state = manager.apply()

            self.assertEqual(state["phase"], "staged")
            self.assertEqual((app_root / "scripts" / "start.py").read_text(encoding="utf-8"), "old-start")
            self.assertEqual((manager.slots_root / "slot_b" / "scripts" / "start.py").read_text(encoding="utf-8"), "new-start")


if __name__ == "__main__":
    unittest.main()
