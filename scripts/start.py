#!/usr/bin/env python3
"""Cross-platform Gateway start script. Usage: python scripts/start.py"""
import os
import runpy
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
RUN_DIR = APP_DIR / ".run"
PID_FILE = RUN_DIR / "gateway.pid"
LOG_FILE = RUN_DIR / "gateway.log"
CONFIG_FILE = RUN_DIR / "config.json"
VENV = APP_DIR / ".venv"

if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from newhorizons_gateway import __version__  # noqa: E402


IS_WIN = sys.platform == "win32"
FOREGROUND_FLAG = "--gateway-foreground"


class _TeeStream:
    def __init__(self, *streams):
        self.streams = streams

    def write(self, data):
        for stream in self.streams:
            stream.write(data)
            stream.flush()
        return len(data)

    def flush(self):
        for stream in self.streams:
            stream.flush()


def _venv_bin(name):
    return VENV / ("Scripts" if IS_WIN else "bin") / (name + (".exe" if IS_WIN else ""))


def _stop_previous():
    if not PID_FILE.exists():
        return
    pid_text = PID_FILE.read_text().strip()
    if pid_text:
        try:
            pid = int(pid_text)
            if IS_WIN:
                subprocess.call(
                    ["taskkill", "/F", "/PID", str(pid)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            else:
                os.kill(pid, 15)
            print(f"Stopped previous instance (PID {pid}).")
            time.sleep(1)
        except (ValueError, ProcessLookupError, OSError):
            pass
    PID_FILE.unlink(missing_ok=True)


def _check_ports():
    for proto, port in [("UDP", 22346), ("UDP", 13250), ("TCP", 5052)]:
        kind = socket.SOCK_DGRAM if proto == "UDP" else socket.SOCK_STREAM
        with socket.socket(socket.AF_INET, kind) as sock:
            try:
                sock.bind(("", port))
            except OSError:
                print(f"ERROR: {proto}/{port} is already in use.", file=sys.stderr)
                sys.exit(1)


def _create_venv():
    if not _venv_bin("python").exists():
        print("Creating .venv ...")
        subprocess.run([sys.executable, "-m", "venv", str(VENV)], check=True)


def _install_deps():
    pip = str(_venv_bin("pip"))
    subprocess.run([pip, "install", "-q", "-r", str(APP_DIR / "requirements.txt")], check=True)
    subprocess.run([pip, "install", "-q", "-e", str(APP_DIR)], check=True)


def _create_config():
    if not CONFIG_FILE.exists():
        shutil.copy(APP_DIR / "config.example.json", CONFIG_FILE)
        print(f"Created {CONFIG_FILE} - open the WebUI to finish setup.")


def _windows_console_title():
    try:
        import ctypes

        ctypes.windll.kernel32.SetConsoleTitleW("New Horizons Gateway")
    except Exception:
        pass


def _windows_foreground_main():
    _windows_console_title()
    RUN_DIR.mkdir(exist_ok=True)
    env = {**os.environ, "PYTHONUNBUFFERED": "1"}
    env["NEWHORIZONS_GATEWAY_APP_ROOT"] = str(APP_DIR)
    env["NEWHORIZONS_GATEWAY_RESTART_COMMAND"] = f"\"{sys.executable}\" \"{Path(__file__).resolve()}\""
    os.environ.update(env)

    with open(LOG_FILE, "a", encoding="utf-8", buffering=1) as handle:
        sys.stdout = _TeeStream(sys.__stdout__, handle)
        sys.stderr = _TeeStream(sys.__stderr__, handle)
        print("=" * 64)
        print("New Horizons Gateway")
        print(f"Version: {__version__}")
        print(f"Config: {CONFIG_FILE}")
        print(f"Log: {LOG_FILE}")
        print("Web UI: http://127.0.0.1:5052")
        print("Closing this window stops Gateway.")
        print("=" * 64)
        sys.argv = ["newhorizons_gateway.main", "--config", str(CONFIG_FILE)]
        runpy.run_module("newhorizons_gateway.main", run_name="__main__")


def _launch():
    python = str(_venv_bin("python"))
    env = {**os.environ, "PYTHONUNBUFFERED": "1"}
    env["NEWHORIZONS_GATEWAY_APP_ROOT"] = str(APP_DIR)
    env["NEWHORIZONS_GATEWAY_RESTART_COMMAND"] = f"\"{sys.executable}\" \"{Path(__file__).resolve()}\""

    if IS_WIN:
        proc = subprocess.Popen(
            [python, str(Path(__file__).resolve()), FOREGROUND_FLAG],
            env=env,
            cwd=str(APP_DIR),
            creationflags=subprocess.CREATE_NEW_CONSOLE,
        )
        PID_FILE.write_text(str(proc.pid))
        time.sleep(1)
        if proc.poll() is not None:
            print("ERROR: Gateway failed to start.", file=sys.stderr)
            sys.exit(1)
        print(f"Gateway started   PID {proc.pid}")
        print("Gateway console   New Horizons Gateway")
        print("Web UI            http://127.0.0.1:5052")
        print(f"Log               {LOG_FILE}")
        return

    with open(LOG_FILE, "w", encoding="utf-8") as log:
        proc = subprocess.Popen(
            [python, "-m", "newhorizons_gateway.main", "--config", str(CONFIG_FILE)],
            stdout=log,
            stderr=log,
            env=env,
            cwd=str(APP_DIR),
            start_new_session=True,
        )

    PID_FILE.write_text(str(proc.pid))
    time.sleep(1)

    if proc.poll() is not None:
        print("ERROR: Gateway failed to start.", file=sys.stderr)
        print(LOG_FILE.read_text(errors="replace")[:2000], file=sys.stderr)
        sys.exit(1)

    print(f"Gateway started   PID {proc.pid}")
    print("WebUI             http://127.0.0.1:5052")
    print(f"Log               {LOG_FILE}")


def main():
    if IS_WIN and FOREGROUND_FLAG in sys.argv[1:]:
        _windows_foreground_main()
        return
    RUN_DIR.mkdir(exist_ok=True)
    _stop_previous()
    _check_ports()
    _create_venv()
    _install_deps()
    _create_config()
    _launch()


if __name__ == "__main__":
    main()
