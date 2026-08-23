import struct
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from newhorizons_gateway.arduino_protocol import (  # noqa: E402
    PACKET_FLAG_HEARTBEAT,
    decode_json_line,
    encode_command_line,
    is_arduino_heartbeat_packet,
    is_arduino_stream_packet,
    packet_device_uid,
)


class ArduinoProtocolTest(unittest.TestCase):
    def test_encode_command_line_uses_new_protocol_envelope(self):
        line = encode_command_line({"command": "check_update", "request_id": "req-1"})

        self.assertTrue(line.endswith(b"\n"))
        decoded = decode_json_line(line)
        self.assertEqual(decoded["protocol"], "NHO/Arduino/1")
        self.assertEqual(decoded["command"], "check_update")
        self.assertEqual(decoded["request_id"], "req-1")

    def test_decode_json_line_rejects_wrong_protocol(self):
        with self.assertRaisesRegex(ValueError, "unsupported_protocol"):
            decode_json_line(b'{"protocol":"NHCP/1","command":"status"}\n')

    def test_identifies_arduino_v3_stream_packet(self):
        packet = bytearray(20 + 4)
        struct.pack_into("<HBB", packet, 0, 0xA55A, 3, 0)
        packet[4:10] = bytes.fromhex("3CDC7545CCD0")
        struct.pack_into("<IIH", packet, 10, 1, 2, 4)

        self.assertTrue(is_arduino_stream_packet(packet))
        self.assertEqual(packet_device_uid(packet), "3CDC7545CCD0")

        packet[2] = 2
        self.assertFalse(is_arduino_stream_packet(packet))

    def test_identifies_arduino_v3_heartbeat_packet(self):
        packet = bytearray(20)
        struct.pack_into("<HBB", packet, 0, 0xA55A, 3, PACKET_FLAG_HEARTBEAT)
        packet[4:10] = bytes.fromhex("3CDC7545CCD0")
        struct.pack_into("<IIH", packet, 10, 9, 5000, 0)

        self.assertTrue(is_arduino_stream_packet(packet))
        self.assertTrue(is_arduino_heartbeat_packet(packet))
        self.assertEqual(packet_device_uid(packet), "3CDC7545CCD0")

        matrix_packet = bytearray(20 + 4)
        struct.pack_into("<HBB", matrix_packet, 0, 0xA55A, 3, 0)
        matrix_packet[4:10] = bytes.fromhex("3CDC7545CCD0")
        struct.pack_into("<IIH", matrix_packet, 10, 10, 5010, 4)
        self.assertFalse(is_arduino_heartbeat_packet(matrix_packet))

    def test_identifies_arduino_v5_stream_and_heartbeat_packets(self):
        stream_packet = bytearray(24 + 6)
        struct.pack_into("<HBB", stream_packet, 0, 0xA55A, 5, 0)
        stream_packet[4:10] = bytes.fromhex("9CCC01E2BD2C")
        struct.pack_into("<IQH", stream_packet, 10, 1, 1_725_000_000_000, 6)

        self.assertTrue(is_arduino_stream_packet(stream_packet))
        self.assertFalse(is_arduino_heartbeat_packet(stream_packet))
        self.assertEqual(packet_device_uid(stream_packet), "9CCC01E2BD2C")

        heartbeat_packet = bytearray(24)
        struct.pack_into("<HBB", heartbeat_packet, 0, 0xA55A, 5, PACKET_FLAG_HEARTBEAT)
        heartbeat_packet[4:10] = bytes.fromhex("9CCC01E2BD2C")
        struct.pack_into("<IQH", heartbeat_packet, 10, 2, 1_725_000_000_005, 0)

        self.assertTrue(is_arduino_stream_packet(heartbeat_packet))
        self.assertTrue(is_arduino_heartbeat_packet(heartbeat_packet))


if __name__ == "__main__":
    unittest.main()
