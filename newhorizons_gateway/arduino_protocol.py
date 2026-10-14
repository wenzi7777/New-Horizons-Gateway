from __future__ import annotations

import json
import struct
from typing import Any


# Generated from the firmware's spec/wire.json; v3/v4 below are frozen history.
from .wire import CONTROL_PORT, PACKET_MAGIC, PACKET_VERSION_V5, PROTOCOL
from .wire import FLAG_HEARTBEAT as PACKET_FLAG_HEARTBEAT

PACKET_VERSION = 3
PACKET_VERSION_V4 = 4
HEADER_LEN = 20
HEADER_PREFIX = struct.Struct("<HBB")
HEADER_TAIL = struct.Struct("<IIH")
HEADER_LEN_V4 = 24
HEADER_TAIL_V4 = struct.Struct("<IQH")


def _header_len_and_tail(version: int) -> tuple[int, struct.Struct] | None:
    if version == PACKET_VERSION:
        return HEADER_LEN, HEADER_TAIL
    if version in (PACKET_VERSION_V4, PACKET_VERSION_V5):
        return HEADER_LEN_V4, HEADER_TAIL_V4
    return None


def encode_command_line(payload: dict[str, Any]) -> bytes:
    message = {"protocol": PROTOCOL}
    message.update(dict(payload or {}))
    return (json.dumps(message, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")


def decode_json_line(payload: bytes | bytearray | str, *, require_protocol: bool = True) -> dict[str, Any]:
    if isinstance(payload, (bytes, bytearray)):
        text = bytes(payload).decode("utf-8")
    else:
        text = str(payload)
    data = json.loads(text.strip())
    if require_protocol and data.get("protocol") != PROTOCOL:
        raise ValueError("unsupported_protocol")
    return data


def is_arduino_stream_packet(payload: bytes | bytearray) -> bool:
    packet = bytes(payload)
    if len(packet) < HEADER_LEN:
        return False
    try:
        magic, version, _flags = HEADER_PREFIX.unpack_from(packet, 0)
    except struct.error:
        return False
    header = _header_len_and_tail(version)
    if magic != PACKET_MAGIC or header is None:
        return False
    header_len, tail_struct = header
    if len(packet) < header_len:
        return False
    try:
        _frame_id, _timestamp_ms, payload_len = tail_struct.unpack_from(packet, 10)
    except struct.error:
        return False
    return len(packet) >= header_len + int(payload_len)


def is_arduino_heartbeat_packet(payload: bytes | bytearray) -> bool:
    packet = bytes(payload)
    if len(packet) < HEADER_LEN:
        return False
    try:
        magic, version, flags = HEADER_PREFIX.unpack_from(packet, 0)
    except struct.error:
        return False
    header = _header_len_and_tail(version)
    if magic != PACKET_MAGIC or header is None:
        return False
    header_len, tail_struct = header
    if len(packet) < header_len:
        return False
    try:
        _frame_id, _timestamp_ms, payload_len = tail_struct.unpack_from(packet, 10)
    except struct.error:
        return False
    return bool(flags & PACKET_FLAG_HEARTBEAT) and int(payload_len) == 0 and len(packet) >= header_len


def packet_device_uid(payload: bytes | bytearray) -> str:
    packet = bytes(payload)
    if not is_arduino_stream_packet(packet):
        return ""
    return packet[4:10].hex().upper()
