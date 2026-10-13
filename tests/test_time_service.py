import struct
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from newhorizons_gateway.local_device import packet_device_uid  # noqa: E402
from newhorizons_gateway.time_service import (  # noqa: E402
    TIME_RESP_LEN,
    build_time_response,
    is_time_request,
)

EPOCH_US = 1_760_000_000 * 1_000_000


def time_request(seq: int, t1: int) -> bytes:
    # Byte for byte what the firmware's encodeEspNowTimeRequest() emits:
    # magic 0xE8, version 1, seq, flags 0, t1 (int64 little-endian).
    return bytes([0xE8, 1, seq, 0]) + struct.pack("<q", t1)


class TimeServiceTest(unittest.TestCase):
    def test_reply_layout_matches_the_firmware(self):
        reply = build_time_response(time_request(7, 123456789), EPOCH_US + 1000, clock=lambda: EPOCH_US + 1300)

        self.assertEqual(len(reply), TIME_RESP_LEN)
        # Offsets from EspNowTimeWire.h: magic, version, seq, flags, t1@4,
        # t2@12, t3@20, uncertainty_ms@28, reserved@30.
        self.assertEqual(reply[0], 0xE9)
        self.assertEqual(reply[1], 1)
        self.assertEqual(reply[2], 7)
        self.assertEqual(reply[3], 0x01 | (1 << 4))  # synced, source=sntp
        self.assertEqual(struct.unpack_from("<q", reply, 4)[0], 123456789)
        self.assertEqual(struct.unpack_from("<q", reply, 12)[0], EPOCH_US + 1000)
        self.assertEqual(struct.unpack_from("<q", reply, 20)[0], EPOCH_US + 1300)

    def test_device_recovers_gateway_time(self):
        # Device mono 0 corresponds to Gateway wall time EPOCH_US; 2 ms each way.
        t1 = 10_000_000
        t2 = EPOCH_US + t1 + 2000
        reply = build_time_response(time_request(1, t1), t2, clock=lambda: t2 + 400)
        _, _, _, _, echoed, rt2, rt3, _, _ = struct.unpack("<BBBBqqqHH", reply)
        t4 = (rt3 - EPOCH_US) + 2000
        offset = ((rt2 - echoed) + (rt3 - t4)) // 2
        delay = (t4 - echoed) - (rt3 - rt2)
        self.assertEqual(offset, EPOCH_US)
        self.assertEqual(delay, 4000)

    def test_only_exact_requests_are_answered(self):
        self.assertTrue(is_time_request(time_request(0, 0)))
        self.assertFalse(is_time_request(time_request(0, 0)[:-1]))
        self.assertFalse(is_time_request(b"{" + time_request(0, 0)[1:]))
        wrong_version = bytearray(time_request(0, 0))
        wrong_version[1] = 2
        self.assertFalse(is_time_request(bytes(wrong_version)))
        self.assertIsNone(build_time_response(b"\xa5\x5a" + bytes(10), EPOCH_US))

    def test_an_unset_host_clock_is_reported_not_served(self):
        reply = build_time_response(time_request(3, 5), 1000, clock=lambda: 2000)
        self.assertEqual(reply[3] & 0x01, 0)
        self.assertEqual(struct.unpack_from("<q", reply, 12)[0], 0)

    def test_a_time_request_never_looks_like_a_sensor_packet(self):
        # Gateways before the time service drop it for exactly this reason:
        # no 0xA55A magic, so no device_uid, so never forwarded upstream.
        self.assertEqual(packet_device_uid(time_request(9, EPOCH_US)), "")

    def test_requests_are_answered_before_any_other_handling(self):
        source = (ROOT / "newhorizons_gateway" / "main.py").read_text(encoding="utf-8")
        handler = source[source.index("def on_udp_packet") :]
        self.assertLess(handler.index("now_epoch_us()"), handler.index("is_time_request(payload)"))
        self.assertLess(handler.index("is_time_request(payload)"), handler.index('startswith(b"{")'))
        self.assertLess(handler.index("is_time_request(payload)"), handler.index("upstream.send_packet"))


if __name__ == "__main__":
    unittest.main()
