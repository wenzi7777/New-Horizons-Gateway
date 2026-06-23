import tempfile
import unittest
from pathlib import Path
from unittest import mock


class GatewayBootloaderTest(unittest.TestCase):
    def test_bootstrap_slot_a_seeds_runtime_payload_from_app_root(self):
        from newhorizons_gateway.bootloader import GatewayBootloader

        with tempfile.TemporaryDirectory() as tmpdir:
            app_root = Path(tmpdir)
            (app_root / "README.md").write_text("root-readme", encoding="utf-8")
            (app_root / "requirements.txt").write_text("root-req", encoding="utf-8")
            (app_root / "pyproject.toml").write_text("root-proj", encoding="utf-8")
            package_dir = app_root / "newhorizons_gateway"
            package_dir.mkdir()
            (package_dir / "__init__.py").write_text('__version__ = "v0.5.0"\n', encoding="utf-8")
            scripts_dir = app_root / "scripts"
            scripts_dir.mkdir()
            (scripts_dir / "start_runtime.py").write_text("runtime", encoding="utf-8")

            bootloader = GatewayBootloader(app_root=app_root)
            slot_root = bootloader.bootstrap_slot("slot_a")

            self.assertEqual((slot_root / "README.md").read_text(encoding="utf-8"), "root-readme")
            self.assertEqual((slot_root / "scripts" / "start_runtime.py").read_text(encoding="utf-8"), "runtime")
            self.assertEqual((app_root / "README.md").read_text(encoding="utf-8"), "root-readme")

    def test_bootloader_awaits_health_and_commits_pending_slot(self):
        from newhorizons_gateway.boot_state import GatewayBootStateStore
        from newhorizons_gateway.bootloader import GatewayBootloader

        with tempfile.TemporaryDirectory() as tmpdir:
            app_root = Path(tmpdir)
            bootloader = GatewayBootloader(app_root=app_root, boot_timeout_sec=1)
            state_store = GatewayBootStateStore(bootloader.boot_state_path)
            state_store.mark_pending_switch(target_version="v9.9.9")
            bootloader.write_health({
                "slot": "slot_b",
                "version": "v9.9.9",
                "ready": True,
                "phase": "running",
                "web_port": 5052,
            })
            proc = mock.Mock()
            proc.poll.return_value = None

            with mock.patch.object(bootloader, "_probe_web_ready", return_value=True):
                committed = bootloader.await_pending_health(proc)

            self.assertTrue(committed)
            self.assertEqual(state_store.load()["active_slot"], "slot_b")
            self.assertEqual(state_store.load()["boot_phase"], "idle")

    def test_bootloader_rolls_back_when_pending_slot_never_becomes_healthy(self):
        from newhorizons_gateway.boot_state import GatewayBootStateStore
        from newhorizons_gateway.bootloader import GatewayBootloader

        with tempfile.TemporaryDirectory() as tmpdir:
            app_root = Path(tmpdir)
            bootloader = GatewayBootloader(app_root=app_root, boot_timeout_sec=0)
            state_store = GatewayBootStateStore(bootloader.boot_state_path)
            state_store.mark_pending_switch(target_version="v9.9.9")
            proc = mock.Mock()
            proc.poll.return_value = None

            with mock.patch.object(bootloader, "_probe_web_ready", return_value=False):
                committed = bootloader.await_pending_health(proc)

            self.assertFalse(committed)
            state = state_store.load()
            self.assertEqual(state["active_slot"], "slot_a")
            self.assertEqual(state["boot_phase"], "rolled_back")
            self.assertEqual(state["rollback_reason"], "health_timeout")
            proc.terminate.assert_called_once()


if __name__ == "__main__":
    unittest.main()
