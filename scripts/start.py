#!/usr/bin/env python3
"""Cross-platform Gateway start script. Usage: python scripts/start.py"""
import os
import io
import runpy
import shutil
import socket
import subprocess
import sys
import threading
import time
from collections import deque
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
from newhorizons_gateway.console_runtime import (  # noqa: E402
    classify_console_line,
    console_status_path,
    format_console_header_lines,
    read_console_status,
)


IS_WIN = sys.platform == "win32"
FOREGROUND_FLAG = "--gateway-foreground"
STATUS_FILE = console_status_path(APP_DIR)


class _ConsoleDashboard:
    def __init__(self, status_file: Path, *, version: str, config_path: Path, log_path: Path):
        self.status_file = status_file
        self.version = version
        self.config_path = config_path
        self.log_path = log_path
        self.log_lines = deque(maxlen=800)
        self.partial = ""
        self.status = {}
        self._status_file_mtime_ns = -1
        self._status_poll_count = 0
        self._stop = threading.Event()
        self._lock = threading.RLock()
        self._thread = threading.Thread(target=self._render_loop, name="newhorizons-gateway-console", daemon=True)

    def start(self):
        self._enable_ansi()
        self._thread.start()

    def stop(self):
        self._stop.set()
        self._thread.join(timeout=1.0)

    def write(self, data: str):
        with self._lock:
            self.partial += str(data or "")
            while "\n" in self.partial:
                line, self.partial = self.partial.split("\n", 1)
                kind = classify_console_line(line)
                if kind == "status_poll":
                    self._status_poll_count += 1
                    continue
                if kind == "event":
                    self.log_lines.append(line.rstrip())

    def flush(self):
        return None

    def _enable_ansi(self):
        try:
            import ctypes

            kernel32 = ctypes.windll.kernel32
            handle = kernel32.GetStdHandle(-11)
            mode = ctypes.c_uint32()
            if kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
                kernel32.SetConsoleMode(handle, mode.value | 0x0004)
        except Exception:
            pass

    def _load_status(self):
        try:
            stat = self.status_file.stat()
        except FileNotFoundError:
            return
        if stat.st_mtime_ns == self._status_file_mtime_ns:
            return
        payload = read_console_status(APP_DIR)
        self.status = payload
        self._status_file_mtime_ns = stat.st_mtime_ns

    def _render_loop(self):
        while not self._stop.is_set():
            self._load_status()
            self._render()
            time.sleep(0.35)

    def _render(self):
        with self._lock:
            status = dict(self.status)
            status["status_poll_count"] = self._status_poll_count
            header = format_console_header_lines(
                status,
                version=self.version,
                config_path=self.config_path,
                log_path=self.log_path,
            )
            columns, rows = shutil.get_terminal_size((140, 40))
            header = [line[:columns] for line in header]
            reserved = len(header) + 2
            visible_logs = max(6, rows - reserved)
            lines = list(self.log_lines)[-visible_logs:]
            output = io.StringIO()
            output.write("\x1b[2J\x1b[H")
            for line in header:
                output.write(line)
                output.write("\n")
            output.write("-" * min(columns, 80))
            output.write("\n")
            output.write("Recent events\n")
            for line in lines:
                output.write(line[:columns])
                output.write("\n")
            sys.__stdout__.write(output.getvalue())
            sys.__stdout__.flush()


class _DashboardStream:
    def __init__(self, dashboard: _ConsoleDashboard, file_handle):
        self.dashboard = dashboard
        self.file_handle = file_handle

    def write(self, data):
        text = str(data or "")
        self.file_handle.write(text)
        self.file_handle.flush()
        self.dashboard.write(text)
        return len(text)

    def flush(self):
        self.file_handle.flush()
        self.dashboard.flush()


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
        dashboard = _ConsoleDashboard(STATUS_FILE, version=__version__, config_path=CONFIG_FILE, log_path=LOG_FILE)
        dashboard.start()
        sys.stdout = _DashboardStream(dashboard, handle)
        sys.stderr = _DashboardStream(dashboard, handle)
        dashboard.write("Gateway console started.\n")
        dashboard.write("Closing this window stops Gateway.\n")
        dashboard.write("Status polls are summarized in the header.\n")
        try:
            sys.argv = ["newhorizons_gateway.main", "--config", str(CONFIG_FILE)]
            runpy.run_module("newhorizons_gateway.main", run_name="__main__")
        finally:
            dashboard.stop()


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
