"""Differential harness: runs the Desktop backend's real Python code on inputs
the TypeScript tests also feed the engine, and prints what Python produced.

    python3 harness.py <mode> <input.json> [<outdir>]

Modes: parse, num, csv, timeline, record. Input/outputs are JSON; floats
travel as their IEEE-754 bits (16 hex digits, big-endian) where -0.0, NaN or
exactness matter.

Only the stdlib-based backend modules are imported: the package's __init__
(which needs Flask) is bypassed with a stub package. Time is faked: the wall
clock (datetime.now in service/recording_meta) and time.monotonic follow the
current step's `wall_us` / `mono_ms`, and threading.Timer in service.py is
captured instead of started, so the TS side can be driven with the same clock.
"""
from __future__ import annotations

import csv
import io
import json
import os
import struct
import sys
import threading  # imported before time.monotonic is patched
import time
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path

DESKTOP_BACKEND = Path(os.environ.get("NH_DESKTOP_BACKEND", Path(__file__).resolve().parents[7] / "New-Horizons-Desktop" / "backend"))


class State:
    wall_us = 0
    mono_ms = 0


STATE = State()
time.monotonic = lambda: STATE.mono_ms / 1000.0  # bound into default args at import below

if os.environ.get("NH_HARNESS_TZ"):
    os.environ["TZ"] = os.environ["NH_HARNESS_TZ"]
    time.tzset()

package = types.ModuleType("newhorizons_backend")
package.__path__ = [str(DESKTOP_BACKEND / "newhorizons_backend")]
sys.modules["newhorizons_backend"] = package

from newhorizons_backend import packet_parser  # noqa: E402
from newhorizons_backend import recording_timeline  # noqa: E402


def from_bits(text: str) -> float:
    return struct.unpack(">d", bytes.fromhex(text))[0]


# ── parse ──────────────────────────────────────────────────────────────────


def mode_parse(spec):
    out = []
    for case in spec["packets"]:
        try:
            parsed = packet_parser.parse_binary_packet(bytes.fromhex(case["hex"]), sensor_count=case.get("sensor_count"))
            out.append({"ok": json.dumps(parsed)})
        except packet_parser.PacketParseError as exc:
            out.append({"error": str(exc)})
    return out


# ── num ────────────────────────────────────────────────────────────────────


def mode_num(spec):
    rounds = []
    for case in spec.get("round", []):
        x = from_bits(case["bits"])
        item = {"repr": repr(x), "str": str(x), "round": repr(round(x, case["nd"]))}
        if x == x and x not in (float("inf"), float("-inf")):
            item["round0"] = round(x)
        rounds.append(item)
    sums = [repr(sum(from_bits(bits) for bits in values)) for values in spec.get("sum", [])]
    divs = [repr(a / b) for a, b in spec.get("div", [])]
    return {"round": rounds, "sum": sums, "div": divs}


# ── csv ────────────────────────────────────────────────────────────────────


def typed(value):
    if value is None:
        return None
    if "i" in value:
        return int(value["i"])
    if "f" in value:
        return from_bits(value["f"])
    if "b" in value:
        return bool(value["b"])
    return str(value["s"])


def mode_csv(spec):
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer)
    for row in spec["rows"]:
        writer.writerow([typed(value) for value in row])
    return buffer.getvalue()


# ── timeline ───────────────────────────────────────────────────────────────


def mode_timeline(spec, outdir: Path):
    results = []
    for index, case in enumerate(spec["cases"]):
        folder = outdir / f"t{index}"
        folder.mkdir(parents=True, exist_ok=True)
        data = folder / "062756.data.csv"
        with data.open("w", newline="", encoding="utf-8") as handle:
            handle.write(case["data"])
        if case.get("events") is not None:
            with (folder / "062756.events.csv").open("w", newline="", encoding="utf-8") as handle:
                handle.write(case["events"])
        timeline = recording_timeline.compute_timeline(data, case.get("buckets", recording_timeline.DEFAULT_BUCKETS))
        results.append(json.dumps(timeline, separators=(",", ":")))
    return results


# ── record ─────────────────────────────────────────────────────────────────


class FakeDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        base = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(microseconds=STATE.wall_us)
        if tz is None:
            return base.astimezone().replace(tzinfo=None)
        return base.astimezone(tz)


class FakeTimer:
    created: list["FakeTimer"] = []

    def __init__(self, interval, function, args=None, kwargs=None):
        self.interval = interval
        self.function = function
        self.args = args or ()
        self.kwargs = kwargs or {}
        self.daemon = False
        FakeTimer.created.append(self)

    def start(self):
        pass


class FakeUuid:
    counter = 0

    class _Value:
        def __init__(self, hex_):
            self.hex = hex_

    @classmethod
    def uuid4(cls):
        cls.counter += 1
        return cls._Value(format(cls.counter, "032x"))


def mode_record(spec, outdir: Path):
    from newhorizons_backend import app_event_capture, recording_meta, service

    service.datetime = FakeDatetime
    recording_meta.datetime = FakeDatetime
    threading_proxy = types.SimpleNamespace(**{name: getattr(threading, name) for name in dir(threading) if not name.startswith("__")})
    threading_proxy.Timer = FakeTimer
    service.threading = threading_proxy
    app_event_capture.uuid = FakeUuid

    uid = spec["uid"]
    log: list = []
    svc = service.NewHorizonsService(autostart=False, mock_mode=False)
    svc._data_root = outdir
    svc._nicknames = {}
    svc._device_groups = {}
    svc._ensure_app_event_poller = lambda: None
    svc._request_status_for_meta = lambda device_uid: None
    publish = {"online": True}

    def publish_command(device_uid, payload):
        if not publish["online"]:
            raise RuntimeError("device_not_connected")
        log.append({"published": payload})
        return {}

    svc.publish_command = publish_command

    def set_knowledge(step):
        if "device_json" in step:
            svc._devices[uid] = json.loads(step["device_json"])
        if "status_json" in step:
            svc._latest_status[uid] = json.loads(step["status_json"])
        if "nickname" in step:
            svc._nicknames[uid] = step["nickname"]
        if "group" in step:
            svc._device_groups[uid] = step["group"]
        if "gateways_json" in step:
            svc._gateways = json.loads(step["gateways_json"])

    for existing in spec.get("existing", []):
        target = outdir / existing
        if existing.endswith(".csv"):
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("", encoding="utf-8")
        else:
            target.mkdir(parents=True, exist_ok=True)
    before = {str(path.relative_to(outdir)) for path in outdir.rglob("*") if path.is_file()}

    set_knowledge(spec)
    for step in spec["steps"]:
        if "wall_us" in step:
            STATE.wall_us = step["wall_us"]
        if "mono_ms" in step:
            STATE.mono_ms = step["mono_ms"]
        op = step["op"]
        if op == "enable":
            result = svc.set_recording_enabled(uid, bool(step.get("enabled", True)))
            log.append({"enable": result})
        elif op == "online":
            publish["online"] = bool(step["online"])
        elif op == "knowledge":
            set_knowledge(step)
            if step.get("status_update"):
                # service._record_status's tail: refresh the meta of a recording in progress.
                with svc._lock:
                    session = svc._recording_sessions.get(uid)
                if session is not None:
                    refreshed = svc._recording_device_meta(uid)
                    refreshed.pop("battery_at_start", None)
                    session.meta.refresh_device(refreshed)
        elif op == "frame":
            payload = bytes.fromhex(step["hex"])
            try:
                parsed = packet_parser.parse_binary_packet(payload, sensor_count=svc._v5_extension_sensor_count(payload))
            except packet_parser.PacketParseError as exc:
                log.append({"frame_error": str(exc)})
                continue
            device_uid = parsed["device_uid"]
            parsed["dn"] = parsed["device_uid"] = parsed["device_id"] = device_uid
            # datagram_ingest._record_parsed's recording branch, verbatim.
            with svc._lock:
                should_record = svc._recording_active(device_uid)
            entry = {}
            if should_record:
                try:
                    lag_ms = svc._write_csv_sample(device_uid, parsed)
                    if lag_ms is not None:
                        entry["recording_lag_ms"] = round(lag_ms)
                    if parsed.get("app_events"):
                        svc._capture_streamed_app_events(device_uid, parsed["app_events"])
                except Exception as exc:
                    error = str(exc)
                    with svc._lock:
                        svc._recording_enabled.discard(device_uid)
                        finished = svc._pop_recording_locked(device_uid)
                        svc._recording_errors[device_uid] = error
                    if finished is not None:
                        finished.finish("write_error: " + error)
                    entry["error"] = error
            log.append({"frame": entry})
        elif op == "app_events_result":
            payload = json.loads(step["payload_json"])
            svc._capture_app_events(uid, payload)
        elif op == "poll":
            with svc._lock:
                recording = sorted(svc._recording_enabled)
            now = time.monotonic()
            for device_uid in recording:
                interval = svc.APP_EVENT_STREAM_CHECK_SEC if device_uid in svc._app_event_streaming else svc.APP_EVENT_POLL_SEC
                if now - svc._app_event_requested_at.get(device_uid, 0.0) >= interval - 0.1:
                    svc._request_app_events(device_uid)
        elif op == "drain_timer":
            timer = FakeTimer.created[-1]
            timer.function(*timer.args, **timer.kwargs)
        elif op == "shutdown":
            svc.stop()
        else:
            raise ValueError(f"unknown op {op}")

    files = {}
    for path in sorted(outdir.rglob("*")):
        if path.is_file():
            rel = str(path.relative_to(outdir))
            if rel in before:
                continue
            files[rel] = path.read_bytes().decode("utf-8")
    return {"files": files, "log": log}


def main():
    mode = sys.argv[1]
    spec = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
    outdir = Path(sys.argv[3]) if len(sys.argv) > 3 else None
    if mode == "parse":
        result = mode_parse(spec)
    elif mode == "num":
        result = mode_num(spec)
    elif mode == "csv":
        result = mode_csv(spec)
    elif mode == "timeline":
        result = mode_timeline(spec, outdir)
    elif mode == "record":
        result = mode_record(spec, outdir)
    else:
        raise SystemExit(f"unknown mode {mode}")
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    main()
