import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from newhorizons_gateway.state import GatewayState  # noqa: E402


class GatewayStateTest(unittest.TestCase):
    def test_default_control_stale_window_covers_reboot_to_os_transition(self):
        state = GatewayState()

        self.assertGreaterEqual(state.control_stale_sec, 60.0)

    def test_control_attach_and_disconnect_update_findme_state(self):
        state = GatewayState()
        state.record_findme_request(
            {
                "device_uid": "3CDC7545CCD0",
                "device_name": "New Horizons OS-3CDC7545CCD0",
                "mode": "normal",
            },
            ("192.168.1.152", 12345),
            accepted=True,
        )

        state.record_control(
            "3CDC7545CCD0",
            "hello",
            {"device_uid": "3CDC7545CCD0", "mode": "normal"},
            ("192.168.1.152", 54321),
            connected=True,
        )
        snapshot = state.snapshot([])
        device = snapshot["devices"][0]
        self.assertEqual("attached", device["findme_state"])

        state.record_disconnect("3CDC7545CCD0")
        snapshot = state.snapshot([])
        device = snapshot["devices"][0]
        self.assertEqual("disconnected", device["findme_state"])

    def test_nearby_devices_marks_serving_and_denied(self):
        state = GatewayState()
        state.record_findme_request(
            {
                "device_uid": "3CDC7545CCD0",
                "device_name": "New Horizons OS-3CDC7545CCD0",
                "mode": "recovery",
            },
            ("192.168.1.152", 12345),
            accepted=True,
        )
        state.record_findme_request(
            {
                "device_uid": "AAAAAAAAAAAA",
                "device_name": "Other Device",
                "mode": "normal",
            },
            ("192.168.1.160", 12345),
            accepted=False,
            reason="device_rejected",
        )
        state.record_control(
            "3CDC7545CCD0",
            "hello",
            {"device_uid": "3CDC7545CCD0", "mode": "recovery"},
            ("192.168.1.152", 54321),
            connected=True,
        )

        snapshot = state.snapshot(["AAAAAAAAAAAA"])
        nearby = {item["device_uid"]: item for item in snapshot["nearby_devices"]}
        self.assertTrue(nearby["3CDC7545CCD0"]["serving"])
        self.assertFalse(nearby["3CDC7545CCD0"]["denied"])
        self.assertFalse(nearby["AAAAAAAAAAAA"]["serving"])
        self.assertTrue(nearby["AAAAAAAAAAAA"]["denied"])

    def test_stale_control_session_is_not_serving(self):
        now = 1000.0
        state = GatewayState(now=lambda: now, control_stale_sec=1.0)
        state.record_findme_request(
            {
                "device_uid": "3CDC7545CCD0",
                "device_name": "New Horizons OS-3CDC7545CCD0",
                "mode": "normal",
            },
            ("192.168.1.152", 12345),
            accepted=True,
        )
        state.record_control(
            "3CDC7545CCD0",
            "hello",
            {"device_uid": "3CDC7545CCD0", "mode": "normal"},
            ("192.168.1.152", 54321),
            connected=True,
        )

        self.assertTrue(state.is_serving("3CDC7545CCD0"))

        now = 1001.1
        snapshot = state.snapshot([])
        device = snapshot["devices"][0]
        nearby = {item["device_uid"]: item for item in snapshot["nearby_devices"]}

        self.assertFalse(device["connected"])
        self.assertEqual(device["findme_state"], "disconnected")
        self.assertFalse(nearby["3CDC7545CCD0"]["serving"])
        self.assertFalse(state.is_serving("3CDC7545CCD0"))

    def test_heartbeat_attaches_device_without_recent_findme(self):
        state = GatewayState()

        state.record_heartbeat(
            "3CDC7545CCD0",
            {
                "device_uid": "3CDC7545CCD0",
                "protocol": "NHO/Arduino/1",
                "transport_path": "arduino_heartbeat",
            },
            ("192.168.1.152", 22345),
        )

        snapshot = state.snapshot([])
        device = snapshot["devices"][0]
        self.assertTrue(device["connected"])
        self.assertEqual(device["findme_state"], "attached")
        self.assertEqual(device["transport_path"], "arduino_heartbeat")
        self.assertEqual(device["peer"], "192.168.1.152:22345")
        self.assertIn("last_heartbeat_at", device)

    def test_heartbeat_does_not_downgrade_findme_reported_mode(self):
        # FindMe discovery carries the device's authoritative mode (the firmware
        # updates it every loop). A binary heartbeat is only a liveness signal and
        # does not know the real mode, so it must never reset a known maintenance
        # mode back to normal (which caused the WebUI maintenance flicker).
        state = GatewayState()
        state.record_findme_request(
            {
                "device_uid": "3CDC7545CCD0",
                "device_name": "New Horizons OS-3CDC7545CCD0",
                "mode": "maintenance",
            },
            ("192.168.1.152", 22346),
            accepted=True,
        )

        state.record_heartbeat(
            "3CDC7545CCD0",
            {
                "device_uid": "3CDC7545CCD0",
                "mode": "normal",
                "protocol": "NHO/Arduino/1",
                "transport_path": "arduino_heartbeat",
            },
            ("192.168.1.152", 22345),
        )

        device = state.snapshot([])["devices"][0]
        self.assertEqual(device["mode"], "maintenance")

    def test_arduino_stream_requires_recent_accepted_findme(self):
        now = 1000.0
        state = GatewayState(now=lambda: now, findme_attach_window_sec=5.0)

        self.assertFalse(state.findme_allows_stream("3CDC7545CCD0", ("192.168.1.152", 13250)))

        state.record_findme_request(
            {
                "device_uid": "3CDC7545CCD0",
                "device_name": "New Horizons OS-3CDC7545CCD0",
                "mode": "normal",
            },
            ("192.168.1.152", 22346),
            accepted=False,
            reason="device_rejected",
        )
        self.assertFalse(state.findme_allows_stream("3CDC7545CCD0", ("192.168.1.152", 13250)))

        state.record_findme_request(
            {
                "device_uid": "3CDC7545CCD0",
                "device_name": "New Horizons OS-3CDC7545CCD0",
                "mode": "normal",
            },
            ("192.168.1.152", 22346),
            accepted=True,
        )
        self.assertTrue(state.findme_allows_stream("3CDC7545CCD0", ("192.168.1.152", 13250)))
        self.assertFalse(state.findme_allows_stream("3CDC7545CCD0", ("192.168.1.153", 13250)))

        now = 1006.0
        self.assertFalse(state.findme_allows_stream("3CDC7545CCD0", ("192.168.1.152", 13250)))


    def test_enter_maintenance_result_sets_gateway_mode_to_maintenance(self):
        state = GatewayState()
        state.record_heartbeat(
            "3CDC7545CCD0",
            {"device_uid": "3CDC7545CCD0", "device_name": "New Horizons OS-3CDC7545CCD0", "protocol": "NHO/Arduino/1", "transport_path": "arduino_heartbeat"},
            ("192.168.1.152", 22345),
        )
        self.assertEqual(state.snapshot([])["devices"][0]["mode"], "normal")
        state.record_control(
            "3CDC7545CCD0",
            "result",
            {"command": "enter_maintenance", "ok": True, "message": "maintenance_entered", "device_uid": "3CDC7545CCD0"},
            ("192.168.1.152", 13250),
        )
        self.assertEqual(state.snapshot([])["devices"][0]["mode"], "maintenance")

    def test_exit_maintenance_result_sets_gateway_mode_to_normal(self):
        state = GatewayState()
        state.record_findme_request(
            {"device_uid": "3CDC7545CCD0", "device_name": "New Horizons OS-3CDC7545CCD0", "mode": "maintenance"},
            ("192.168.1.152", 22346),
            accepted=True,
        )
        self.assertEqual(state.snapshot([])["devices"][0]["mode"], "maintenance")
        state.record_control(
            "3CDC7545CCD0",
            "result",
            {"command": "exit_maintenance", "ok": True, "message": "maintenance_exited", "device_uid": "3CDC7545CCD0"},
            ("192.168.1.152", 13250),
        )
        self.assertEqual(state.snapshot([])["devices"][0]["mode"], "normal")

    def test_failed_enter_maintenance_result_does_not_change_mode(self):
        state = GatewayState()
        state.record_heartbeat(
            "3CDC7545CCD0",
            {"device_uid": "3CDC7545CCD0", "protocol": "NHO/Arduino/1", "transport_path": "arduino_heartbeat"},
            ("192.168.1.152", 22345),
        )
        state.record_control(
            "3CDC7545CCD0",
            "result",
            {"command": "enter_maintenance", "ok": False, "status": "error", "device_uid": "3CDC7545CCD0"},
            ("192.168.1.152", 13250),
        )
        self.assertEqual(state.snapshot([])["devices"][0]["mode"], "normal")


if __name__ == "__main__":
    unittest.main()
