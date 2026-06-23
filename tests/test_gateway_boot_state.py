import tempfile
import unittest
from pathlib import Path


class GatewayBootStateTest(unittest.TestCase):
    def test_default_boot_state_uses_slot_a_and_empty_pending(self):
        from newhorizons_gateway.boot_state import GatewayBootStateStore

        with tempfile.TemporaryDirectory() as tmpdir:
            store = GatewayBootStateStore(Path(tmpdir) / "boot_state.json")
            state = store.load()

        self.assertEqual(state["active_slot"], "slot_a")
        self.assertEqual(state["pending_slot"], "")
        self.assertEqual(state["previous_slot"], "")
        self.assertEqual(state["boot_phase"], "idle")
        self.assertEqual(state["rollback_reason"], "")
        self.assertEqual(store.inactive_slot(state), "slot_b")

    def test_mark_pending_switch_targets_inactive_slot_and_records_version(self):
        from newhorizons_gateway.boot_state import GatewayBootStateStore

        with tempfile.TemporaryDirectory() as tmpdir:
            store = GatewayBootStateStore(Path(tmpdir) / "boot_state.json")
            state = store.mark_pending_switch(target_version="v9.9.9")

        self.assertEqual(state["active_slot"], "slot_a")
        self.assertEqual(state["pending_slot"], "slot_b")
        self.assertEqual(state["previous_slot"], "slot_a")
        self.assertEqual(state["target_version"], "v9.9.9")
        self.assertEqual(state["boot_phase"], "pending_switch")

    def test_commit_pending_promotes_new_slot_and_clears_transition_state(self):
        from newhorizons_gateway.boot_state import GatewayBootStateStore

        with tempfile.TemporaryDirectory() as tmpdir:
            store = GatewayBootStateStore(Path(tmpdir) / "boot_state.json")
            store.mark_pending_switch(target_version="v9.9.9")
            state = store.commit_pending()

        self.assertEqual(state["active_slot"], "slot_b")
        self.assertEqual(state["pending_slot"], "")
        self.assertEqual(state["previous_slot"], "")
        self.assertEqual(state["boot_phase"], "idle")
        self.assertEqual(state["target_version"], "v9.9.9")
        self.assertEqual(store.inactive_slot(state), "slot_a")

    def test_rollback_restores_previous_slot_and_records_reason(self):
        from newhorizons_gateway.boot_state import GatewayBootStateStore

        with tempfile.TemporaryDirectory() as tmpdir:
            store = GatewayBootStateStore(Path(tmpdir) / "boot_state.json")
            store.mark_pending_switch(target_version="v9.9.9")
            state = store.rollback_pending("health_timeout")

        self.assertEqual(state["active_slot"], "slot_a")
        self.assertEqual(state["pending_slot"], "")
        self.assertEqual(state["previous_slot"], "")
        self.assertEqual(state["boot_phase"], "rolled_back")
        self.assertEqual(state["rollback_reason"], "health_timeout")

    def test_health_ready_requires_matching_slot_version_and_ready_flag(self):
        from newhorizons_gateway.boot_state import health_payload_ready

        payload = {
            "slot": "slot_b",
            "version": "v9.9.9",
            "ready": True,
            "phase": "running",
            "web_port": 5052,
        }

        self.assertTrue(health_payload_ready(payload, slot_name="slot_b", version="v9.9.9"))
        self.assertFalse(health_payload_ready(payload, slot_name="slot_a", version="v9.9.9"))
        self.assertFalse(health_payload_ready(payload, slot_name="slot_b", version="v1.0.0"))
        self.assertFalse(health_payload_ready({**payload, "ready": False}, slot_name="slot_b", version="v9.9.9"))


if __name__ == "__main__":
    unittest.main()
