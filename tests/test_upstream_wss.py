import sys
import unittest
import base64
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from newhorizons_gateway.upstream_wss import PACKET_TEXT_PREFIX, UpstreamWSSClient  # noqa: E402


def json_text(payload):
    return json.dumps(payload, separators=(",", ":"))


class FakeWebSocket:
    def __init__(self, incoming=None):
        self.incoming = list(incoming or [])
        self.sent = []

    def send(self, payload):
        self.sent.append(payload)

    def recv(self):
        if not self.incoming:
            return None
        item = self.incoming.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item


class WebSocketTimeoutException(Exception):
    pass


class UpstreamWSSClientTest(unittest.TestCase):
    def test_default_binary_queue_covers_short_bursts(self):
        upstream = UpstreamWSSClient("ws://example.invalid", "gateway-test")

        for index in range(40):
            upstream.send_packet(bytes([index % 256]))

        status = upstream.status()
        self.assertEqual(status["data_queue_size"], 32)
        self.assertEqual(status["data_queue_dropped"], 8)
        self.assertEqual(status["data_packets_enqueued"], 40)

    def test_gateway_status_is_coalesced(self):
        upstream = UpstreamWSSClient("ws://example.invalid", "gateway-test")

        upstream.send_gateway_status({"seq": 1})
        upstream.send_gateway_status({"seq": 2})

        self.assertEqual(upstream.control_queue.qsize(), 1)
        item = upstream.control_queue.get_nowait()
        self.assertEqual(item["type"], "gateway_status")
        self.assertEqual(item["payload"]["seq"], 2)

    def test_control_messages_are_sent_as_json_text(self):
        upstream = UpstreamWSSClient("ws://example.invalid", "gateway-test")
        fake_ws = FakeWebSocket()
        upstream._ws = fake_ws

        upstream._send_json({"type": "gateway_status", "payload": {"seq": 2}})

        self.assertEqual(len(fake_ws.sent), 1)
        payload = json.loads(fake_ws.sent[0])
        self.assertEqual(payload["type"], "gateway_status")
        self.assertEqual(payload["payload"]["seq"], 2)

    def test_sensor_packets_are_sent_as_packet_text_envelope(self):
        upstream = UpstreamWSSClient("ws://example.invalid", "gateway-test")
        fake_ws = FakeWebSocket()
        upstream._ws = fake_ws

        upstream._send_binary(b"\x5a\xa5packet")

        self.assertEqual(len(fake_ws.sent), 1)
        self.assertTrue(fake_ws.sent[0].startswith(PACKET_TEXT_PREFIX))
        self.assertEqual(base64.b64decode(fake_ws.sent[0][len(PACKET_TEXT_PREFIX):]), b"\x5a\xa5packet")

    def test_json_command_from_backend_reaches_command_callback(self):
        commands = []
        upstream = UpstreamWSSClient(
            "ws://example.invalid",
            "gateway-test",
            on_command=lambda uid, payload: commands.append((uid, payload)),
        )
        fake_ws = FakeWebSocket([
            json_text({
                "type": "command",
                "device_uid": "3CDC7545CCD0",
                "payload": {"command": "status", "request_id": "req-1"},
            }),
            None,
        ])
        upstream._running.set()

        upstream._receive_loop(fake_ws)

        self.assertEqual(commands, [("3CDC7545CCD0", {"command": "status", "request_id": "req-1"})])

    def test_json_bytes_command_from_backend_reaches_command_callback(self):
        commands = []
        upstream = UpstreamWSSClient(
            "ws://example.invalid",
            "gateway-test",
            on_command=lambda uid, payload: commands.append((uid, payload)),
        )
        packet = json_text({
            "type": "command",
            "device_uid": "3CDC7545CCD0",
            "payload": {"command": "status", "request_id": "req-1"},
        }).encode()
        fake_ws = FakeWebSocket([packet, None])
        upstream._running.set()

        upstream._receive_loop(fake_ws)

        self.assertEqual(commands, [("3CDC7545CCD0", {"command": "status", "request_id": "req-1"})])

    def test_receive_timeout_does_not_drop_gateway_command_route(self):
        commands = []
        upstream = UpstreamWSSClient(
            "ws://example.invalid",
            "gateway-test",
            on_command=lambda uid, payload: commands.append((uid, payload)),
        )
        packet = json_text({
            "type": "command",
            "device_uid": "3CDC7545CCD0",
            "payload": {"command": "status", "request_id": "req-timeout"},
        })
        fake_ws = FakeWebSocket([
            WebSocketTimeoutException("Connection timed out"),
            packet,
            None,
        ])
        upstream._running.set()

        upstream._receive_loop(fake_ws)

        self.assertEqual(commands, [("3CDC7545CCD0", {"command": "status", "request_id": "req-timeout"})])


if __name__ == "__main__":
    unittest.main()
