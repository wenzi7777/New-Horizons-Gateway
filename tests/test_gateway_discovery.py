import json
import socket
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from newhorizons_gateway.discovery import DiscoveryResponder  # noqa: E402
from newhorizons_gateway.state import GatewayState  # noqa: E402


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

    def test_gateway_handover_rejects_old_gateway_and_attaches_target_after_heartbeat(self):
        uid = "3CDC7545CCD0"
        target_state = GatewayState()
        claim = target_state.create_claim(uid, ttl_ms=30000)
        gateway_a = DiscoveryResponder(
            "127.0.0.1",
            0,
            gateway_id="gw-a",
            udp_port=13250,
            priority=100,
        )
        gateway_b = DiscoveryResponder(
            "127.0.0.1",
            0,
            gateway_id="gw-b",
            udp_port=13250,
            priority=100,
            active_claim=target_state.active_claim_for,
            on_request=target_state.record_findme_request,
        )
        gateway_a.start()
        gateway_b.start()
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.settimeout(1.0)
            discover = findme_discover(
                device_uid=uid,
                mode="normal",
                preferred_gateway_id="gw-b",
                claim_id=claim["claim_id"],
            )
            sock.sendto(discover, ("127.0.0.1", gateway_a.bound_port))
            reply_a = json.loads(sock.recvfrom(1024)[0].decode())
            sock.sendto(discover, ("127.0.0.1", gateway_b.bound_port))
            reply_b = json.loads(sock.recvfrom(1024)[0].decode())
        finally:
            gateway_a.stop()
            gateway_b.stop()
            sock.close()

        self.assertFalse(reply_a["accept"])
        self.assertEqual(reply_a["reason"], "device_switching_gateway")
        self.assertTrue(reply_b["accept"])
        self.assertEqual(reply_b["claim_id"], claim["claim_id"])
        self.assertGreater(reply_b["priority"], 100)
        self.assertEqual(target_state.active_claim_for(uid)["state"], "created")

        target_state.record_heartbeat(uid, {}, ("192.0.2.10", 13250))

        attached = target_state.active_claim_for(uid)
        self.assertIsNotNone(attached)
        self.assertEqual(attached["state"], "attached")
        self.assertEqual(
            target_state.snapshot([])["devices"][0]["claim_id"],
            claim["claim_id"],
        )


    def test_offer_mirrors_discover_claim_id_when_claim_record_is_absent(self):
        """When the upstream has expired or failed the claim record, the gateway must
        still echo the device's own claim_id back so the firmware's claimId_ check passes."""
        responder = DiscoveryResponder(
            "127.0.0.1",
            0,
            gateway_id="gw-b",
            udp_port=13250,
            priority=100,
            active_claim=lambda uid: None,  # simulates upstream marking claim as failed
        )
        responder.start()
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.settimeout(1.0)
            sock.sendto(
                findme_discover(
                    device_uid="3CDC7545CCD0",
                    mode="normal",
                    preferred_gateway_id="gw-b",
                    claim_id="abc123",
                ),
                ("127.0.0.1", responder.bound_port),
            )
            data, _addr = sock.recvfrom(1024)
        finally:
            responder.stop()
            sock.close()

        reply = json.loads(data.decode())
        self.assertTrue(reply["accept"])
        self.assertEqual(reply["claim_id"], "abc123")
        self.assertGreater(reply["priority"], 100)

    def test_offer_does_not_mirror_claim_id_when_not_preferred_gateway(self):
        """claim_id mirroring must not occur when the device is switching to a different gateway."""
        responder = DiscoveryResponder(
            "127.0.0.1",
            0,
            gateway_id="gw-a",
            udp_port=13250,
            priority=100,
            active_claim=lambda uid: None,
        )
        responder.start()
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.settimeout(1.0)
            sock.sendto(
                findme_discover(
                    device_uid="3CDC7545CCD0",
                    mode="normal",
                    preferred_gateway_id="gw-b",  # switching AWAY from gw-a
                    claim_id="abc123",
                ),
                ("127.0.0.1", responder.bound_port),
            )
            data, _addr = sock.recvfrom(1024)
        finally:
            responder.stop()
            sock.close()

        reply = json.loads(data.decode())
        self.assertFalse(reply["accept"])
        self.assertEqual(reply["reason"], "device_switching_gateway")
        self.assertNotIn("claim_id", reply)


if __name__ == "__main__":
    unittest.main()
