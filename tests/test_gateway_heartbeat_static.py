import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAIN = ROOT / "newhorizons_gateway" / "main.py"


class GatewayHeartbeatStaticTest(unittest.TestCase):
    def test_gateway_handles_arduino_heartbeat_without_forwarding_packet(self):
        source = MAIN.read_text()

        self.assertIn("is_arduino_heartbeat_packet", source)
        self.assertIn("is_heartbeat = is_arduino_heartbeat_packet(payload)", source)
        self.assertIn('transport_path": "arduino_heartbeat"', source)
        self.assertIn("not is_heartbeat", source)
        self.assertIn("upstream.send_packet(payload)", source)


if __name__ == "__main__":
    unittest.main()
