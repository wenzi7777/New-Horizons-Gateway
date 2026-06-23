from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


STATUS_FILE_NAME = "console-status.json"


def console_status_path(app_root: str | Path | None = None) -> Path:
    root = Path(app_root or os.getenv("NEWHORIZONS_GATEWAY_APP_ROOT") or Path(__file__).resolve().parents[1])
    return root / ".run" / STATUS_FILE_NAME


def write_console_status(app_root: str | Path | None, payload: dict[str, Any]) -> Path:
    target = console_status_path(app_root)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_suffix(".tmp")
    temp.write_text(json.dumps(payload, ensure_ascii=True, indent=2, sort_keys=True), encoding="utf-8")
    temp.replace(target)
    return target


def read_console_status(app_root: str | Path | None = None) -> dict[str, Any]:
    target = console_status_path(app_root)
    if not target.exists():
        return {}
    try:
        payload = json.loads(target.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def classify_console_line(line: str) -> str:
    text = str(line or "").strip()
    if not text:
        return "blank"
    if 'GET /api/status ' in text or 'GET /api/status HTTP/' in text:
        return "status_poll"
    return "event"


def format_console_header_lines(
    status: dict[str, Any],
    *,
    version: str,
    config_path: Path,
    log_path: Path,
) -> list[str]:
    enabled = "YES" if status.get("enabled") else "NO"
    upstream = "ONLINE" if status.get("upstream_connected") else "OFFLINE"
    required_update = bool(status.get("required_update"))
    update_state = "REQUIRED" if required_update else "OK"
    lines = [
        f"New Horizons Gateway  {version}",
        f"Enabled: {enabled} | Upstream: {upstream} | Update: {update_state} | Status polls: {int(status.get('status_poll_count') or 0)}",
        f"Gateway ID: {status.get('gateway_id') or '-'} | Mode: {status.get('target_mode') or '-'}",
        f"Web UI: {status.get('web_ui_url') or 'http://127.0.0.1:5052'}",
        f"Server: {status.get('server_url') or '-'}",
        f"Ports: UDP {status.get('listen_udp_port') or '-'} | FindMe {status.get('listen_discovery_port') or '-'}",
        f"Config: {config_path}",
        f"Log: {log_path}",
        "Closing this window stops Gateway.",
    ]
    return lines
