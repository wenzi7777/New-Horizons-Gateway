import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from newhorizons_gateway.udp_control import UDPCommandDispatcher  # noqa: E402


class Clock:
    def __init__(self) -> None:
        self.value = 1000.0

    def now(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


class UDPCommandDispatcherTest(unittest.TestCase):
    def test_command_is_retried_until_ack(self):
        clock = Clock()
        sent = []
        dispatcher = UDPCommandDispatcher(lambda packet, addr: sent.append((packet, addr)), now=clock.now)
        dispatcher.set_session("3CDC7545CCD0", ("192.168.50.32", 43309))

        self.assertTrue(dispatcher.send_command("3c:dc:75:45:cc:d0", {"command": "status", "request_id": "req-1"}))
        self.assertEqual(len(sent), 1)

        clock.advance(dispatcher.RESEND_INTERVAL_SEC)
        dispatcher.service()

        self.assertEqual(len(sent), 2)
        self.assertEqual(sent[0][1], ("192.168.50.32", 43309))
        first = json.loads(sent[0][0].decode())
        second = json.loads(sent[1][0].decode())
        self.assertEqual(first["seq"], second["seq"])
        self.assertEqual(second["payload"]["command"], "status")
        self.assertEqual(dispatcher.snapshot()["commands_retried"], 1)

    def test_commands_to_device_use_json_command_names(self):
        clock = Clock()
        sent = []
        dispatcher = UDPCommandDispatcher(lambda packet, addr: sent.append((packet, addr)), now=clock.now)
        dispatcher.set_session("3CDC7545CCD0", ("192.168.50.32", 43309))

        dispatcher.send_command("3CDC7545CCD0", {"command": "status", "request_id": "req-status"})

        frame = json.loads(sent[0][0].decode())
        self.assertEqual(frame["type"], "command")
        self.assertEqual(frame["device_uid"], "3CDC7545CCD0")
        self.assertEqual(frame["payload"]["command"], "status")

    def test_ack_stops_retries_until_result_clears_pending(self):
        clock = Clock()
        sent = []
        dispatcher = UDPCommandDispatcher(lambda packet, addr: sent.append((packet, addr)), now=clock.now)
        dispatcher.set_session("3CDC7545CCD0", ("192.168.50.32", 43309))
        dispatcher.send_command("3CDC7545CCD0", {"command": "status", "request_id": "req-2"})
        frame = json.loads(sent[0][0].decode())

        dispatcher.handle_ack("3CDC7545CCD0", {"device_uid": "3CDC7545CCD0", "ack": frame["seq"], "request_id": "req-2"})
        clock.advance(dispatcher.RESEND_INTERVAL_SEC * 3)
        dispatcher.service()

        self.assertEqual(len(sent), 1)
        self.assertEqual(dispatcher.snapshot()["commands_acked"], 1)
        self.assertEqual(dispatcher.snapshot()["pending"], 1)

        dispatcher.handle_result("3CDC7545CCD0", {"request_id": "req-2"})

        self.assertEqual(dispatcher.snapshot()["pending"], 0)

    def test_unacked_command_timeout_emits_delivery_error(self):
        clock = Clock()
        sent = []
        timeouts = []
        dispatcher = UDPCommandDispatcher(
            lambda packet, addr: sent.append((packet, addr)),
            on_delivery_timeout=lambda uid, payload: timeouts.append((uid, payload)),
            now=clock.now,
        )
        dispatcher.set_session("3CDC7545CCD0", ("192.168.50.32", 43309))
        dispatcher.send_command(
            "3CDC7545CCD0",
            {"command": "status", "request_id": "req-3", "expires_at_ms": int((clock.now() + 1) * 1000)},
        )

        clock.advance(1.1)
        dispatcher.service()

        self.assertEqual(timeouts, [("3CDC7545CCD0", {"command": "status", "request_id": "req-3", "expires_at_ms": 1001000})])
        self.assertEqual(dispatcher.snapshot()["pending"], 0)
        self.assertEqual(dispatcher.snapshot()["commands_timeout"], 1)

    def test_stale_session_rejects_command_without_retrying(self):
        clock = Clock()
        sent = []
        dispatcher = UDPCommandDispatcher(
            lambda packet, addr: sent.append((packet, addr)),
            now=clock.now,
            session_ttl_sec=1.0,
        )
        dispatcher.set_session("3CDC7545CCD0", ("192.168.50.32", 43309))

        clock.advance(1.1)

        self.assertFalse(dispatcher.send_command("3CDC7545CCD0", {"command": "memory_status", "request_id": "req-memory"}))
        self.assertEqual(sent, [])
        self.assertEqual(dispatcher.snapshot()["sessions"], 0)


if __name__ == "__main__":
    unittest.main()
