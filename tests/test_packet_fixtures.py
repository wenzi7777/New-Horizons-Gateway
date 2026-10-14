"""The Gateway's packet checks against packets the firmware encoder built.

The Gateway does not decode sensor data; it only has to recognise a stream
packet and read its device UID. NewHorizonsOS-OTA/spec/fixtures/packets.json
is generated from the firmware's PacketV5Codec.cpp.
"""
import json
import unittest
from pathlib import Path

from newhorizons_gateway.arduino_protocol import (
    is_arduino_heartbeat_packet,
    is_arduino_stream_packet,
    packet_device_uid,
)

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT.parent / "NewHorizonsOS-OTA" / "spec" / "fixtures" / "packets.json"


@unittest.skipUnless(FIXTURE.exists(), "NewHorizonsOS-OTA not checked out alongside")
class FirmwarePacketFixtureTest(unittest.TestCase):
    def test_gateway_recognises_every_firmware_packet(self):
        fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(fixture["packets"]), 5)
        for case in fixture["packets"]:
            with self.subTest(case["name"]):
                packet = bytes.fromhex(case["hex"])
                self.assertTrue(is_arduino_stream_packet(packet))
                self.assertFalse(is_arduino_heartbeat_packet(packet))
                self.assertEqual(packet_device_uid(packet), case["expect"]["device_uid"])


if __name__ == "__main__":
    unittest.main()
