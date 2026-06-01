#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import signal
import socket
import sys
import time
import urllib.request
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

running = True


def _stop(_signum, _frame) -> None:
    global running
    running = False


def _gateway_status(status_url: str) -> dict:
    if not status_url:
        return {}
    try:
        with urllib.request.urlopen(status_url, timeout=0.25) as response:
            data = response.read(16384)
        obj = json.loads(data.decode("utf-8", "ignore"))
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return {}


def _decode_request(data: bytes) -> dict | None:
    try:
        decoded = json.loads(data.decode("utf-8"))
    except Exception:
        return None
    if not isinstance(decoded, dict) or decoded.get("type") != "findme_discover":
        return None
    payload = dict(decoded)
    payload.pop("type", None)
    if not payload.get("device_uid"):
        return None
    return payload


def _encode_offer(device_uid: str, payload: dict) -> bytes:
    response = dict(payload)
    response["type"] = "findme_offer"
    response["device_uid"] = str(device_uid or "")
    return json.dumps(response, separators=(",", ":")).encode("utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="New Horizons local Docker discovery proxy")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=22346)
    parser.add_argument("--gateway-id", default="local-gateway")
    parser.add_argument("--tcp-port", type=int, default=0)
    parser.add_argument("--udp-port", type=int, default=13250)
    parser.add_argument("--priority", type=int, default=100)
    parser.add_argument("--status-url", default="http://127.0.0.1:5052/api/status")
    args = parser.parse_args()

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.bind((args.host, args.port))
    sock.settimeout(0.5)
    print(
        "New Horizons discovery proxy listening {}:{} -> udp={}".format(
            args.host,
            args.port,
            args.udp_port,
        ),
        flush=True,
    )

    while running:
        try:
            data, addr = sock.recvfrom(1024)
        except socket.timeout:
            continue
        except OSError as exc:
            if running:
                print("discovery proxy socket error: {}".format(exc), file=sys.stderr, flush=True)
            break
        obj = _decode_request(data)
        if obj is None:
            continue
        device_uid = str(obj.get("device_uid") or "").strip().upper()
        status = _gateway_status(args.status_url)
        config = status.get("config") if isinstance(status.get("config"), dict) else {}
        state = status.get("state") if isinstance(status.get("state"), dict) else {}
        upstream = status.get("upstream") if isinstance(status.get("upstream"), dict) else {}
        denied = {str(uid).strip().upper() for uid in state.get("denied_devices", [])} if isinstance(state.get("denied_devices"), list) else set()
        gateway_name = str(config.get("gateway_name") or "New Horizons Gateway")
        gateway_id = str(config.get("gateway_id") or args.gateway_id)
        upstream_status = "online" if upstream.get("connected") else "offline"
        rejected = bool(device_uid and device_uid in denied)
        response = {
            "version": 1,
            "gateway_name": gateway_name,
            "gateway_id": gateway_id,
            "udp_port": args.udp_port,
            "priority": args.priority,
            "accept": not rejected,
            "upstream_status": upstream_status,
            "ttl_ms": 10000,
            "server_time": int(time.time() * 1000),
        }
        if rejected:
            response.update({"reason": "device_rejected", "cooldown_ms": 30000})
        try:
            sock.sendto(_encode_offer(device_uid, response), addr)
        except OSError as exc:
            print("discovery proxy send error: {}".format(exc), file=sys.stderr, flush=True)

    sock.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
