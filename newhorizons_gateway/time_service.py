"""Time service for WiFi-mode devices: the Gateway answers their time requests.

A device sends TIME_REQ (12 bytes) to the same UDP port it streams sensor
frames to; the Gateway replies with TIME_RESP (32 bytes) carrying its own
wall-clock time on receipt (t2) and just before sending (t3). The device
measures the round trip itself, so the network delay is cancelled rather than
added to its clock -- the classic NTP four-timestamp exchange:

    offset = ((t2 - t1) + (t3 - t4)) / 2

The byte layout is shared with the device firmware and the Hub, which runs
the same exchange over ESP-NOW (NewHorizonsOS-OTA's EspNowTimeWire.h), so it
must not change on this side alone.

The Gateway's own clock is the host OS clock, which every desktop OS keeps
NTP-disciplined by default; every device behind this Gateway therefore shares
one reference. Devices prefer this over querying NTP themselves and fall back
to NTP when no Gateway answers.
"""

from __future__ import annotations

import struct
import time
from typing import Callable, Optional

TIME_REQ_MAGIC = 0xE8
TIME_RESP_MAGIC = 0xE9
TIME_WIRE_VERSION = 1
TIME_REQ_LEN = 12
TIME_RESP_LEN = 32

# TIME_RESP flags: bit0 = server clock valid; high nibble = server's own time
# source (TimeSource in the firmware's ClockCore.h). 1 = "sntp": the host OS
# clock is assumed NTP-disciplined, which the Gateway cannot verify itself.
FLAG_SERVER_SYNCED = 0x01
SERVER_SOURCE_SNTP = 1

# ~2020-09-13, as in the firmware: a host clock earlier than this is unset.
MIN_VALID_EPOCH_US = 1_600_000_000 * 1_000_000

_REQ = struct.Struct("<BBBBq")              # magic, version, seq, flags, t1
_RESP = struct.Struct("<BBBBqqqHH")         # ..., t1, t2, t3, uncertainty_ms, reserved


def now_epoch_us() -> int:
    return time.time_ns() // 1000


def is_time_request(payload: bytes) -> bool:
    return (
        len(payload) == TIME_REQ_LEN
        and payload[0] == TIME_REQ_MAGIC
        and payload[1] == TIME_WIRE_VERSION
    )


def build_time_response(
    request: bytes,
    rx_epoch_us: int,
    clock: Callable[[], int] = now_epoch_us,
) -> Optional[bytes]:
    """Reply to a TIME_REQ received at `rx_epoch_us` (t2), or None if `request`
    is not one. t3 is read from `clock` as the very last step, so the reply's
    own build time counts as turnaround (which the device subtracts), not as
    path delay."""
    if not is_time_request(request):
        return None
    _magic, _version, seq, _flags, t1 = _REQ.unpack(request)
    synced = rx_epoch_us >= MIN_VALID_EPOCH_US
    flags = (FLAG_SERVER_SYNCED if synced else 0) | (SERVER_SOURCE_SNTP << 4)
    t3 = clock()
    return _RESP.pack(
        TIME_RESP_MAGIC,
        TIME_WIRE_VERSION,
        seq,
        flags,
        t1,
        rx_epoch_us if synced else 0,
        t3 if synced else 0,
        0,
        0,
    )
