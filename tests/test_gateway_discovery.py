import json
import socket
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from newhorizons_gateway.discovery import DiscoveryResponder  # noqa: E402


def findme_discover(**payload):
    data = {"type": "findme_discover", **payload}
    return json.dumps(data, separators=(",", ":")).encode()


class GatewayDiscoveryTest(unittest.TestCase):
    def test_discovery_responder_replies_with_json_local_ports(self):
        responder = DiscoveryResponder(
            "127.0.0.1",
            0,
            gateway_id="gw-test",
            udp_port=13250,
            priority=80,
        )
        responder.start()
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.settimeout(1.0)
            sock.sendto(
                findme_discover(device_uid="3CDC7545CCD0", mode="normal"),
                ("127.0.0.1", responder.bound_port),
            )
            data, _addr = sock.recvfrom(1024)
        finally:
            responder.stop()
            sock.close()

        payload = json.loads(data.decode())
        self.assertEqual(payload["type"], "findme_offer")
        self.assertEqual(payload["gateway_id"], "gw-test")
        self.assertEqual(payload["gateway_name"], "New Horizons Gateway")
        self.assertTrue(payload["accept"])
        self.assertEqual(payload["udp_port"], 13250)

    def test_discovery_responder_rejects_denied_device(self):
        responder = DiscoveryResponder(
            "127.0.0.1",
            0,
            gateway_id="gw-test",
            udp_port=13250,
            is_denied=lambda uid: uid == "3CDC7545CCD0",
        )
        responder.start()
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.settimeout(1.0)
            sock.sendto(
                findme_discover(device_uid="3CDC7545CCD0", mode="normal"),
                ("127.0.0.1", responder.bound_port),
            )
            data, _addr = sock.recvfrom(1024)
        finally:
            responder.stop()
            sock.close()

        reply = json.loads(data.decode())
        self.assertFalse(reply["accept"])
        self.assertEqual(reply["reason"], "device_rejected")

    def test_discovery_declines_when_device_has_preferred_gateway_id_for_another_gateway(self):
        responder = DiscoveryResponder(
            "127.0.0.1",
            0,
            gateway_id="gw-a",
            udp_port=13250,
            priority=100,
        )
        responder.start()
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.settimeout(1.0)
            sock.sendto(
                findme_discover(device_uid="3CDC7545CCD0", mode="normal", preferred_gateway_id="gw-b"),
                ("127.0.0.1", responder.bound_port),
            )
            data, _addr = sock.recvfrom(1024)
        finally:
            responder.stop()
            sock.close()

        reply = json.loads(data.decode())
        self.assertEqual(reply["type"], "findme_offer")
        self.assertFalse(reply["accept"])
        self.assertEqual(reply["reason"], "device_switching_gateway")
        self.assertEqual(reply["gateway_id"], "gw-a")

    def test_discovery_responds_normally_when_preferred_gateway_id_matches_self(self):
        responder = DiscoveryResponder(
            "127.0.0.1",
            0,
            gateway_id="gw-a",
            udp_port=13250,
            priority=100,
        )
        responder.start()
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.settimeout(1.0)
            sock.sendto(
                findme_discover(device_uid="3CDC7545CCD0", mode="normal", preferred_gateway_id="gw-a"),
                ("127.0.0.1", responder.bound_port),
            )
            data, _addr = sock.recvfrom(1024)
        finally:
            responder.stop()
            sock.close()

        reply = json.loads(data.decode())
        self.assertTrue(reply["accept"])

    def test_discovery_responds_normally_when_preferred_gateway_id_is_empty(self):
        responder = DiscoveryResponder(
            "127.0.0.1",
            0,
            gateway_id="gw-a",
            udp_port=13250,
            priority=100,
        )
        responder.start()
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.settimeout(1.0)
            sock.sendto(
                findme_discover(device_uid="3CDC7545CCD0", mode="normal"),
                ("127.0.0.1", responder.bound_port),
            )
            data, _addr = sock.recvfrom(1024)
        finally:
            responder.stop()
            sock.close()

        reply = json.loads(data.decode())
        self.assertTrue(reply["accept"])

    def test_discovery_responder_marks_matching_claim_offer(self):
        responder = DiscoveryResponder(
            "127.0.0.1",
            0,
            gateway_id="gw-test",
            udp_port=13250,
            priority=80,
            active_claim=lambda uid: {"claim_id": "claim-1"} if uid == "3CDC7545CCD0" else None,
        )
        responder.start()
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.settimeout(1.0)
            sock.sendto(
                findme_discover(
                    device_uid="3CDC7545CCD0",
                    mode="normal",
                    preferred_gateway_id="gw-test",
                    claim_id="claim-1",
                ),
                ("127.0.0.1", responder.bound_port),
            )
            data, _addr = sock.recvfrom(1024)
        finally:
            responder.stop()
            sock.close()

        reply = json.loads(data.decode())
        self.assertTrue(reply["accept"])
        self.assertEqual(reply["claim_id"], "claim-1")
        self.assertGreater(reply["priority"], 80)


if __name__ == "__main__":
    unittest.main()
