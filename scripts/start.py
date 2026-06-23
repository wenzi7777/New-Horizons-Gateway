#!/usr/bin/env python3
"""Cross-platform Gateway start script. Usage: python scripts/start.py"""
import os
import runpy
import socket
import subprocess
import sys
import time
import traceback
import shutil
import threading
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
)
from newhorizons_gateway.update_manager import ACTIVATE_UPDATE_FLAG, ALLOWED_UPDATE_ENTRIES  # noqa: E402


IS_WIN = sys.platform == "win32"
FOREGROUND_FLAG = "--gateway-foreground"
STATUS_FILE = console_status_path(APP_DIR)


class _TextualGatewayStream:
    def __init__(self, app, file_handle):
        self.app = app
        self.file_handle = file_handle
        self.partial = ""
        self.ui_active = True

    def write(self, data):
        text = str(data or "")
        if not text:
            return 0
        self.file_handle.write(text)
        self.file_handle.flush()
        self.partial += text
        while "\n" in self.partial:
            line, self.partial = self.partial.split("\n", 1)
            kind = classify_console_line(line)
            if not self.ui_active:
                continue
            try:
                if kind == "status_poll":
                    self.app.call_from_thread(self.app.record_status_poll)
                elif kind == "event":
                    self.app.call_from_thread(self.app.push_log_line, line.rstrip())
            except RuntimeError:
                self.ui_active = False
        return len(text)

    def flush(self):
        self.file_handle.flush()

    def detach_ui(self):
        self.ui_active = False


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


def _activate_pending_update(pending_root: Path):
    if not pending_root.exists():
        print(f"No pending update found at {pending_root}.")
        return
    print(f"Activating pending update from {pending_root} ...")
    for name in ALLOWED_UPDATE_ENTRIES:
        src = pending_root / name
        if not src.exists():
            continue
        dst = APP_DIR / name
        if src.is_dir():
            if dst.exists():
                shutil.rmtree(dst)
            shutil.copytree(src, dst)
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    shutil.rmtree(pending_root, ignore_errors=True)
    print("Pending update activated.")


def _windows_console_title():
    try:
        import ctypes

        ctypes.windll.kernel32.SetConsoleTitleW("New Horizons Gateway")
    except Exception:
        pass


def _foreground_main():
    from newhorizons_gateway.gateway_tui import GatewayConsoleApp
    from newhorizons_gateway import main as gateway_main_module

    if IS_WIN:
        _windows_console_title()
    RUN_DIR.mkdir(exist_ok=True)
    PID_FILE.write_text(str(os.getpid()))
    env = {**os.environ, "PYTHONUNBUFFERED": "1"}
    env["NEWHORIZONS_GATEWAY_APP_ROOT"] = str(APP_DIR)
    env["NEWHORIZONS_GATEWAY_RESTART_COMMAND"] = f"\"{sys.executable}\" \"{Path(__file__).resolve()}\""
    os.environ.update(env)
    original_stdout = sys.stdout
    original_stderr = sys.stderr
    result = {"exit_code": 0}
    stop_event = threading.Event()
    state: dict[str, object] = {"stream": None, "gateway_thread": None}

    def _run_gateway(app):
        with open(LOG_FILE, "a", encoding="utf-8", buffering=1) as handle:
            stream = _TextualGatewayStream(app, handle)
            state["stream"] = stream
            sys.stdout = stream
            sys.stderr = stream
            stream.write("Gateway console started.\n")
            stream.write(f"Version: {__version__}\n")
            stream.write(f"Config: {CONFIG_FILE}\n")
            stream.write(f"Log: {LOG_FILE}\n")
            stream.write("Web UI: http://127.0.0.1:5052\n")
            stream.write("Closing this window stops Gateway.\n")
            stream.write("Status polls are summarized in the header.\n")
            try:
                gateway_main_module.run(config_path=str(CONFIG_FILE), stop_event=stop_event)
            except SystemExit as exc:
                code = exc.code if isinstance(exc.code, int) else 0
                result["exit_code"] = code
                try:
                    app.call_from_thread(app.finish, code)
                except RuntimeError:
                    pass
            except BaseException:
                result["exit_code"] = 1
                stream.write(traceback.format_exc())
                try:
                    app.call_from_thread(app.finish, 1)
                except RuntimeError:
                    pass
            else:
                try:
                    app.call_from_thread(app.finish, 0)
                except RuntimeError:
                    pass
            finally:
                stream.detach_ui()
                sys.stdout = original_stdout
                sys.stderr = original_stderr

    def _start_gateway(app):
        gateway_thread = threading.Thread(target=_run_gateway, args=(app,), name="newhorizons-gateway-runtime", daemon=True)
        state["gateway_thread"] = gateway_thread
        gateway_thread.start()

    def _on_app_exit(_app):
        stop_event.set()
        stream = state.get("stream")
        if stream is not None:
            stream.detach_ui()

    app = GatewayConsoleApp(
        status_file=STATUS_FILE,
        version=__version__,
        config_path=CONFIG_FILE,
        log_path=LOG_FILE,
        on_ready=_start_gateway,
        on_exit=_on_app_exit,
    )
    try:
        app.run()
    finally:
        stop_event.set()
        stream = state.get("stream")
        if stream is not None:
            stream.detach_ui()
        gateway_thread = state.get("gateway_thread")
        if isinstance(gateway_thread, threading.Thread):
            gateway_thread.join(timeout=5.0)
        PID_FILE.unlink(missing_ok=True)
    os._exit(result["exit_code"])


def _launch():
    python = str(_venv_bin("python"))
    env = {**os.environ, "PYTHONUNBUFFERED": "1"}
    env["NEWHORIZONS_GATEWAY_APP_ROOT"] = str(APP_DIR)
    env["NEWHORIZONS_GATEWAY_RESTART_COMMAND"] = f"\"{python}\" \"{Path(__file__).resolve()}\""

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

    os.execvpe(
        python,
        [python, str(Path(__file__).resolve()), FOREGROUND_FLAG],
        env,
    )


def main():
    if ACTIVATE_UPDATE_FLAG in sys.argv[1:]:
        index = sys.argv.index(ACTIVATE_UPDATE_FLAG)
        if index + 1 >= len(sys.argv):
            print("ERROR: pending update path missing.", file=sys.stderr)
            sys.exit(2)
        pending_root = Path(sys.argv[index + 1]).resolve()
        RUN_DIR.mkdir(exist_ok=True)
        _stop_previous()
        _activate_pending_update(pending_root)
        _check_ports()
        _create_venv()
        _install_deps()
        _create_config()
        _launch()
        return
    if FOREGROUND_FLAG in sys.argv[1:]:
        _foreground_main()
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
