from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from . import __version__
from .boot_state import (
    GatewayBootStateStore,
    GatewayHealthStore,
    SLOT_A,
    default_health_payload,
    health_payload_ready,
)


DEFAULT_BOOT_TIMEOUT_SEC = 30.0
RUNTIME_SLOT_ENTRIES = (
    "newhorizons_gateway",
    "scripts",
    "pyproject.toml",
    "requirements.txt",
    "README.md",
    "config.example.json",
)


class GatewayBootloader:
    def __init__(
        self,
        *,
        app_root: str | Path,
        runtime_root: str | Path | None = None,
        boot_timeout_sec: float = DEFAULT_BOOT_TIMEOUT_SEC,
    ) -> None:
        self.app_root = Path(app_root).resolve()
        self.runtime_root = Path(runtime_root or (self.app_root / ".run")).resolve()
        self.logs_root = self.runtime_root / "logs"
        self.config_root = self.runtime_root / "config"
        self.downloads_root = self.runtime_root / "downloads"
        self.slots_root = self.runtime_root / "slots"
        self.boot_state_path = self.runtime_root / "boot_state.json"
        self.health_path = self.runtime_root / "health.json"
        self.pid_path = self.runtime_root / "gateway.pid"
        self.boot_timeout_sec = float(boot_timeout_sec)
        self.boot_state = GatewayBootStateStore(self.boot_state_path)
        self.health_store = GatewayHealthStore(self.health_path)

    def ensure_layout(self) -> None:
        self.runtime_root.mkdir(parents=True, exist_ok=True)
        self.logs_root.mkdir(parents=True, exist_ok=True)
        self.config_root.mkdir(parents=True, exist_ok=True)
        self.downloads_root.mkdir(parents=True, exist_ok=True)
        self.slots_root.mkdir(parents=True, exist_ok=True)
        if not self.boot_state_path.exists():
            self.boot_state.reset()
        if not self.health_path.exists():
            self.health_store.clear()

    def slot_root(self, slot_name: str) -> Path:
        return self.slots_root / str(slot_name)

    def bootstrap_slot(self, slot_name: str = SLOT_A) -> Path:
        self.ensure_layout()
        slot_root = self.slot_root(slot_name)
        if slot_root.exists() and (slot_root / "scripts" / "start_runtime.py").exists():
            return slot_root
        if slot_root.exists():
            shutil.rmtree(slot_root)
        slot_root.mkdir(parents=True, exist_ok=True)
        for name in RUNTIME_SLOT_ENTRIES:
            src = self.app_root / name
            if not src.exists():
                continue
            dst = slot_root / name
            if src.is_dir():
                shutil.copytree(src, dst, dirs_exist_ok=True)
            else:
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
        return slot_root

    def write_health(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self.health_store.write(payload)

    def read_health(self) -> dict[str, Any]:
        return self.health_store.read()

    def clear_health(self) -> dict[str, Any]:
        return self.health_store.clear()

    def ensure_slot_runtime(self, slot_root: Path) -> None:
        venv_root = slot_root / ".venv"
        python = self._venv_python(venv_root)
        version_file = slot_root / ".prepared-version"
        slot_version = self._slot_version(slot_root)
        if python.exists() and version_file.exists() and version_file.read_text(encoding="utf-8").strip() == slot_version:
            return
        if not python.exists():
            subprocess.run([sys.executable, "-m", "venv", str(venv_root)], check=True, cwd=str(slot_root))
        pip = self._venv_bin(venv_root, "pip")
        requirements = slot_root / "requirements.txt"
        if requirements.exists():
            subprocess.run([str(pip), "install", "-q", "-r", str(requirements)], check=True, cwd=str(slot_root))
        subprocess.run([str(pip), "install", "-q", "-e", str(slot_root)], check=True, cwd=str(slot_root))
        version_file.write_text(slot_version, encoding="utf-8")

    def launch_slot(self, slot_name: str, *, expected_version: str | None = None) -> subprocess.Popen[Any]:
        slot_root = self.slot_root(slot_name)
        self.ensure_slot_runtime(slot_root)
        python = self._venv_python(slot_root / ".venv")
        script = slot_root / "scripts" / "start_runtime.py"
        env = {**os.environ}
        env["PYTHONUNBUFFERED"] = "1"
        env["NEWHORIZONS_GATEWAY_APP_ROOT"] = str(self.app_root)
        env["NEWHORIZONS_GATEWAY_RUNTIME_ROOT"] = str(self.runtime_root)
        env["NEWHORIZONS_GATEWAY_CONFIG_PATH"] = str(self.config_root / "config.json")
        env["NEWHORIZONS_GATEWAY_LOG_PATH"] = str(self.logs_root / "gateway.log")
        env["NEWHORIZONS_GATEWAY_STATUS_FILE"] = str(self.runtime_root / "console-status.json")
        env["NEWHORIZONS_GATEWAY_HEALTH_PATH"] = str(self.health_path)
        env["NEWHORIZONS_GATEWAY_SLOT_NAME"] = str(slot_name)
        env["NEWHORIZONS_GATEWAY_EXPECTED_VERSION"] = str(expected_version or self._slot_version(slot_root))
        return subprocess.Popen(
            [str(python), str(script)],
            cwd=str(slot_root),
            env=env,
        )

    def await_pending_health(self, proc: subprocess.Popen[Any]) -> bool:
        started = time.monotonic()
        state = self.boot_state.load()
        pending_slot = str(state.get("pending_slot") or "")
        target_version = str(state.get("target_version") or "")
        while time.monotonic() - started <= self.boot_timeout_sec:
            if proc.poll() is not None:
                self.boot_state.rollback_pending(f"process_exit_{proc.poll()}")
                return False
            payload = self.read_health()
            if health_payload_ready(payload, slot_name=pending_slot, version=target_version):
                web_port = int(payload.get("web_port") or 5052)
                if self._probe_web_ready(web_port):
                    self.boot_state.commit_pending()
                    return True
            time.sleep(0.25)
        self._terminate_process(proc)
        self.boot_state.rollback_pending("health_timeout")
        return False

    def run_foreground(self) -> int:
        self.bootstrap_slot(SLOT_A)
        while True:
            state = self.boot_state.load()
            active_slot = str(state.get("active_slot") or SLOT_A)
            self.clear_health()
            proc = self.launch_slot(active_slot, expected_version=state.get("target_version") or None)
            self.pid_path.write_text(str(proc.pid), encoding="utf-8")
            exit_code = proc.wait()
            self.pid_path.unlink(missing_ok=True)

            state = self.boot_state.load()
            if str(state.get("boot_phase") or "") != "pending_switch" or not str(state.get("pending_slot") or ""):
                return exit_code

            pending_slot = str(state.get("pending_slot") or "")
            self.clear_health()
            pending_proc = self.launch_slot(pending_slot, expected_version=state.get("target_version") or None)
            self.pid_path.write_text(str(pending_proc.pid), encoding="utf-8")
            if not self.await_pending_health(pending_proc):
                self.pid_path.unlink(missing_ok=True)
                continue
            exit_code = pending_proc.wait()
            self.pid_path.unlink(missing_ok=True)
            state = self.boot_state.load()
            if str(state.get("boot_phase") or "") == "pending_switch":
                continue
            return exit_code

    def _probe_web_ready(self, web_port: int = 5052) -> bool:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(1.0)
            return sock.connect_ex(("127.0.0.1", int(web_port))) == 0

    @staticmethod
    def _terminate_process(proc: subprocess.Popen[Any]) -> None:
        if proc.poll() is not None:
            return
        try:
            proc.terminate()
            proc.wait(timeout=5.0)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

    @staticmethod
    def _venv_bin(venv_root: Path, name: str) -> Path:
        scripts = "Scripts" if sys.platform == "win32" else "bin"
        suffix = ".exe" if sys.platform == "win32" else ""
        return venv_root / scripts / f"{name}{suffix}"

    def _venv_python(self, venv_root: Path) -> Path:
        return self._venv_bin(venv_root, "python")

    @staticmethod
    def _slot_version(slot_root: Path) -> str:
        init_path = slot_root / "newhorizons_gateway" / "__init__.py"
        if not init_path.exists():
            return __version__
        for line in init_path.read_text(encoding="utf-8").splitlines():
            if line.startswith("__version__"):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
        return __version__
