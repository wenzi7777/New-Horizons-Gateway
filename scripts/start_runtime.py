#!/usr/bin/env python3
"""Slot runtime entrypoint for New Horizons Gateway."""
from __future__ import annotations

import os
import sys
import threading
import traceback
from pathlib import Path

SLOT_ROOT = Path(__file__).resolve().parent.parent
APP_ROOT = Path(os.getenv("NEWHORIZONS_GATEWAY_APP_ROOT") or SLOT_ROOT).resolve()
RUNTIME_ROOT = Path(os.getenv("NEWHORIZONS_GATEWAY_RUNTIME_ROOT") or (APP_ROOT / ".run")).resolve()
PID_FILE = RUNTIME_ROOT / "gateway.pid"
LOG_FILE = Path(os.getenv("NEWHORIZONS_GATEWAY_LOG_PATH") or (RUNTIME_ROOT / "logs" / "gateway.log")).resolve()
CONFIG_FILE = Path(os.getenv("NEWHORIZONS_GATEWAY_CONFIG_PATH") or (RUNTIME_ROOT / "config" / "config.json")).resolve()

if str(SLOT_ROOT) not in sys.path:
    sys.path.insert(0, str(SLOT_ROOT))

from newhorizons_gateway import __version__  # noqa: E402
from newhorizons_gateway.console_runtime import classify_console_line, console_status_path  # noqa: E402


STATUS_FILE = Path(os.getenv("NEWHORIZONS_GATEWAY_STATUS_FILE") or console_status_path(APP_ROOT)).resolve()


IS_WIN = sys.platform == "win32"


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


def _windows_console_title():
    try:
        import ctypes

        ctypes.windll.kernel32.SetConsoleTitleW("New Horizons Gateway")
    except Exception:
        pass


def main() -> int:
    from newhorizons_gateway.gateway_tui import GatewayConsoleApp
    from newhorizons_gateway import main as gateway_main_module

    if IS_WIN:
        _windows_console_title()

    RUNTIME_ROOT.mkdir(parents=True, exist_ok=True)
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    PID_FILE.write_text(str(os.getpid()), encoding="utf-8")
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
            stream.write(f"Slot root: {SLOT_ROOT}\n")
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
    return int(result["exit_code"])


if __name__ == "__main__":
    raise SystemExit(main())
