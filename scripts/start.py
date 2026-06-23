#!/usr/bin/env python3
"""Gateway bootloader launcher. Usage: python scripts/start.py"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent

if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from newhorizons_gateway.boot_state import SLOT_A  # noqa: E402
from newhorizons_gateway.bootloader import GatewayBootloader  # noqa: E402


IS_WIN = sys.platform == "win32"
FOREGROUND_FLAG = "--bootloader-foreground"
RUNTIME_ENTRY = "start_runtime.py"
KNOWN_PORTS = (22346, 13250, 5052)


def _launch_foreground_console() -> None:
    env = {**os.environ, "PYTHONUNBUFFERED": "1"}
    env["NEWHORIZONS_GATEWAY_APP_ROOT"] = str(APP_DIR)
    proc = subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), FOREGROUND_FLAG],
        cwd=str(APP_DIR),
        env=env,
        creationflags=subprocess.CREATE_NEW_CONSOLE if IS_WIN else 0,
    )
    print(f"Gateway bootloader PID {proc.pid}")
    print("Gateway active slot  slot_a")
    print("Gateway console      New Horizons Gateway")
    print(f"Gateway runtime      {RUNTIME_ENTRY}")
    print(f"Gateway ports        {KNOWN_PORTS[0]}/{KNOWN_PORTS[1]}/{KNOWN_PORTS[2]}")
    print("Web UI               http://127.0.0.1:5052")


def _run_foreground() -> int:
    bootloader = GatewayBootloader(app_root=APP_DIR)
    bootloader.bootstrap_slot(SLOT_A)
    return bootloader.run_foreground()


def main() -> int:
    if FOREGROUND_FLAG in sys.argv[1:]:
        return _run_foreground()
    if IS_WIN:
        _launch_foreground_console()
        return 0
    return _run_foreground()


if __name__ == "__main__":
    raise SystemExit(main())
