from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import __version__


DEFAULT_MANIFEST_URL = "https://raw.githubusercontent.com/wenzi7777/New-Horizons-Gateway/main/releases/gateway-latest.json"
DEFAULT_AUTO_CHECK_INTERVAL_SEC = 600
ACTIVATE_UPDATE_FLAG = "--gateway-activate-update"
ALLOWED_UPDATE_ENTRIES = (
    "newhorizons_gateway",
    "scripts",
    "pyproject.toml",
    "requirements.txt",
    "README.md",
)


def _version_key(value: str) -> tuple[int, ...]:
    parts = tuple(int(part) for part in re.findall(r"\d+", str(value or "")))
    return parts or (0,)


def _is_newer_version(candidate: str, current: str) -> bool:
    left = _version_key(candidate)
    right = _version_key(current)
    width = max(len(left), len(right))
    return left + (0,) * (width - len(left)) > right + (0,) * (width - len(right))


class GatewayUpdateManager:
    def __init__(
        self,
        app_root: str | Path | None = None,
        staging_root: str | Path | None = None,
        manifest_url: str | None = None,
    ) -> None:
        self.app_root = Path(app_root or os.getenv("NEWHORIZONS_GATEWAY_APP_ROOT") or Path(__file__).resolve().parents[1])
        self.staging_root = Path(staging_root or os.getenv("NEWHORIZONS_GATEWAY_UPDATE_DIR") or self.app_root / ".run" / "updates")
        self.manifest_url = manifest_url or os.getenv("NEWHORIZONS_GATEWAY_UPDATE_MANIFEST") or DEFAULT_MANIFEST_URL
        self.latest_manifest: dict[str, Any] = {}
        self.downloaded_zip = self.staging_root / "gateway-update.zip"
        self.pending_release_root = self.staging_root / "pending-release"
        self.downloaded_sha256 = ""
        self.phase = "idle"
        self.last_error = ""
        self.restart_required = False
        self.manual_update_required = False
        self.latest_gateway_version = ""
        self.update_signal_source = ""
        self.required_update = False
        self.notes_markdown = ""
        self.last_checked_at = ""
        self.auto_check_interval_sec = max(
            60,
            int(os.getenv("NEWHORIZONS_GATEWAY_UPDATE_INTERVAL_SEC", str(DEFAULT_AUTO_CHECK_INTERVAL_SEC))),
        )
        self.download_progress_pct = 0
        self.apply_progress_pct = 0
        self.busy = False
        self._lock = threading.RLock()
        self._worker: threading.Thread | None = None
        self._last_manifest_check_monotonic = 0.0

    def state(self) -> dict[str, Any]:
        with self._lock:
            latest_version = str(self.latest_manifest.get("version") or "")
            progress_pct = self._overall_progress_pct()
            return {
                "phase": self.phase,
                "current_version": __version__,
                "latest_gateway_version": self.latest_gateway_version,
                "latest_version": latest_version,
                "update_signal_source": self.update_signal_source,
                "required_update": self.required_update,
                "update_available": bool(self.required_update or (latest_version and _is_newer_version(latest_version, __version__))),
                "manifest_url": self.manifest_url,
                "zip_url": str(self.latest_manifest.get("zip_url") or ""),
                "notes_url": str(self.latest_manifest.get("notes_url") or ""),
                "notes_markdown": self.notes_markdown,
                "sha256": str(self.latest_manifest.get("sha256") or ""),
                "downloaded": self.downloaded_zip.exists(),
                "downloaded_sha256": self.downloaded_sha256,
                "pending_release_ready": self.pending_release_root.exists(),
                "restart_required": self.restart_required,
                "manual_update_required": self.manual_update_required,
                "last_checked_at": self.last_checked_at,
                "checked_at": self.last_checked_at,
                "auto_check_interval_sec": self.auto_check_interval_sec,
                "download_progress_pct": self.download_progress_pct,
                "apply_progress_pct": self.apply_progress_pct,
                "progress_pct": progress_pct,
                "progress_label": self._progress_label(),
                "busy": self.busy,
                "last_error": self.last_error,
            }

    def set_server_latest_version(self, version: str, *, source: str = "server_ws") -> dict[str, Any]:
        normalized = str(version or "").strip()
        if not normalized:
            return self.state()
        with self._lock:
            self.latest_gateway_version = normalized
            self.update_signal_source = source
            self.required_update = _is_newer_version(normalized, __version__)
        return self.state()

    def maybe_refresh(self) -> dict[str, Any]:
        if self.busy:
            return self.state()
        manifest_version = str(self.latest_manifest.get("version") or "")
        stale = (time.monotonic() - self._last_manifest_check_monotonic) >= self.auto_check_interval_sec
        if self.required_update and (not self.latest_manifest or manifest_version != self.latest_gateway_version or stale):
            return self.check(force=False)
        return self.state()

    def check(self, *, force: bool = True) -> dict[str, Any]:
        if self.busy and self.phase in ("downloading", "applying"):
            return self.state()
        if not force and not self.required_update:
            return self.state()
        checked_at = datetime.now(timezone.utc).isoformat()
        try:
            with urllib.request.urlopen(self.manifest_url, timeout=12) as response:
                payload = response.read()
            manifest = json.loads(payload.decode("utf-8"))
            if not isinstance(manifest, dict):
                raise ValueError("invalid_manifest")
            for key in ("version", "zip_url", "sha256"):
                if not str(manifest.get(key) or "").strip():
                    raise ValueError(f"manifest_missing_{key}")
            self.latest_manifest = manifest
            if not self.update_signal_source:
                self.update_signal_source = "manifest"
            self.notes_markdown = self._download_notes(str(manifest.get("notes_url") or ""))
            self.phase = "checked"
            if not self.notes_markdown and str(manifest.get("notes_url") or "").strip():
                self.last_error = self.last_error or "notes_unavailable"
            else:
                self.last_error = ""
            self.last_checked_at = checked_at
        except Exception as exc:
            self.phase = "error"
            self.last_error = str(exc)
            self.last_checked_at = checked_at
            if not self.update_signal_source and force:
                self.update_signal_source = "manifest"
        self._last_manifest_check_monotonic = time.monotonic()
        return self.state()

    def _download_notes(self, notes_url: str) -> str:
        notes_url = str(notes_url or "").strip()
        if not notes_url:
            return ""
        try:
            with urllib.request.urlopen(notes_url, timeout=12) as response:
                payload = response.read()
            return payload.decode("utf-8")
        except Exception as exc:
            self.last_error = f"notes_unavailable: {exc}"
            return ""

    def download(self) -> dict[str, Any]:
        if not self.latest_manifest:
            self.check()
        zip_url = str(self.latest_manifest.get("zip_url") or "")
        expected_sha = str(self.latest_manifest.get("sha256") or "").lower()
        if not zip_url or not expected_sha:
            with self._lock:
                self.phase = "error"
                self.last_error = "manifest_not_ready"
            return self.state()
        try:
            self.staging_root.mkdir(parents=True, exist_ok=True)
            with self._lock:
                self.phase = "downloading"
                self.download_progress_pct = 0
                self.last_error = ""
            temp_zip = self.downloaded_zip.with_suffix(".part")
            sha = hashlib.sha256()
            with urllib.request.urlopen(zip_url, timeout=30) as response, temp_zip.open("wb") as handle:
                total = int(response.headers.get("Content-Length") or 0)
                downloaded = 0
                while True:
                    chunk = response.read(64 * 1024)
                    if not chunk:
                        break
                    handle.write(chunk)
                    sha.update(chunk)
                    downloaded += len(chunk)
                    if total > 0:
                        with self._lock:
                            self.download_progress_pct = min(99, int(downloaded * 100 / total))
            actual_sha = sha.hexdigest()
            if actual_sha.lower() != expected_sha:
                raise ValueError("sha256_mismatch")
            temp_zip.replace(self.downloaded_zip)
            with self._lock:
                self.downloaded_sha256 = actual_sha
                self.download_progress_pct = 100
                self.phase = "downloaded"
                self.last_error = ""
        except Exception as exc:
            with self._lock:
                self.phase = "error"
                self.last_error = str(exc)
        return self.state()

    def apply(self) -> dict[str, Any]:
        if not self.downloaded_zip.exists():
            self.download()
        if not self.downloaded_zip.exists():
            return self.state()
        try:
            with self._lock:
                self.phase = "applying"
                self.apply_progress_pct = 0
                self.last_error = ""
            extract_dir = Path(tempfile.mkdtemp(prefix="gateway-update-", dir=str(self.staging_root)))
            with zipfile.ZipFile(self.downloaded_zip) as archive:
                archive.extractall(extract_dir)
            source_root = self._extracted_source_root(extract_dir)
            if self.pending_release_root.exists():
                shutil.rmtree(self.pending_release_root)
            self.pending_release_root.mkdir(parents=True, exist_ok=True)
            copy_total = max(1, self._copy_unit_total(source_root))
            copied = 0
            for name in ALLOWED_UPDATE_ENTRIES:
                src = source_root / name
                if not src.exists():
                    continue
                dst = self.pending_release_root / name
                copied = self._copy_entry_with_progress(src, dst, None, copied, copy_total)
            with self._lock:
                self.restart_required = True
                self.manual_update_required = False
                self.apply_progress_pct = 100
                self.phase = "applied"
                self.last_error = ""
        except Exception as exc:
            with self._lock:
                self.phase = "error"
                self.last_error = str(exc)
        return self.state()

    def start_update(self) -> dict[str, Any]:
        with self._lock:
            if self._worker is not None and self._worker.is_alive():
                return self.state()
            self.busy = True
            self.restart_required = False
            self.manual_update_required = False
            self.download_progress_pct = 0
            self.apply_progress_pct = 0
            self.last_error = ""
            self.phase = "checking"
            self._worker = threading.Thread(target=self._run_update_sequence, name="gateway-update-worker", daemon=True)
            self._worker.start()
        return self.state()

    def wait_for_idle(self, timeout: float | None = None) -> None:
        worker = self._worker
        if worker is not None:
            worker.join(timeout=timeout)

    def _run_update_sequence(self) -> None:
        try:
            self.check(force=True)
            state = self.state()
            if not state.get("update_available"):
                with self._lock:
                    self.phase = "checked"
                return
            self.download()
            if self.state().get("phase") == "error":
                return
            self.apply()
        finally:
            with self._lock:
                self.busy = False

    @staticmethod
    def _copy_unit_total(source_root: Path) -> int:
        total = 0
        for name in ALLOWED_UPDATE_ENTRIES:
            src = source_root / name
            if not src.exists():
                continue
            if src.is_file():
                total += 1
            else:
                    total += sum(1 for child in src.rglob("*") if child.is_file())
        return total

    def _copy_entry_with_progress(self, src: Path, dst: Path, backup_dst: Path | None, copied: int, total: int) -> int:
        if src.is_file():
            self._backup_existing_file(dst, backup_dst)
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            copied += 1
            with self._lock:
                self.apply_progress_pct = min(99, int(copied * 100 / total))
            return copied
        dst.mkdir(parents=True, exist_ok=True)
        for child in sorted(src.rglob("*")):
            relative = child.relative_to(src)
            target = dst / relative
            backup_target = backup_dst / relative if backup_dst is not None else None
            if child.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            self._backup_existing_file(target, backup_target)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(child, target)
            copied += 1
            with self._lock:
                self.apply_progress_pct = min(99, int(copied * 100 / total))
        return copied

    @staticmethod
    def _backup_existing_file(target: Path, backup_target: Path | None) -> None:
        if backup_target is None or not target.exists() or not target.is_file() or backup_target.exists():
            return
        backup_target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(target, backup_target)

    def _overall_progress_pct(self) -> int:
        if self.phase in ("idle", "error"):
            return 0
        if self.phase == "checking":
            return 2
        if self.phase in ("downloading", "downloaded"):
            return min(50, int(self.download_progress_pct * 0.5))
        if self.phase in ("applying", "applied", "restart_required", "restarting"):
            return min(100, 50 + int(self.apply_progress_pct * 0.5))
        return 0

    def _progress_label(self) -> str:
        if self.phase == "checking":
            return "Checking for update"
        if self.phase in ("downloading", "downloaded"):
            return "Downloading update"
        if self.phase in ("applying", "applied", "restart_required", "restarting"):
            return "Applying update"
        if self.phase == "error":
            return "Update failed"
        return "Waiting"

    def restart(self) -> dict[str, Any]:
        if not self.pending_release_root.exists():
            with self._lock:
                self.manual_update_required = True
                self.phase = "restart_required"
            return self.state()
        try:
            script = self.app_root / "scripts" / "start.py"
            if not script.exists():
                raise FileNotFoundError(str(script))
            subprocess.Popen(
                [sys.executable, str(script), ACTIVATE_UPDATE_FLAG, str(self.pending_release_root)],
                cwd=str(self.app_root),
            )
            with self._lock:
                self.phase = "restarting"
                self.last_error = ""
        except Exception as exc:
            with self._lock:
                self.phase = "error"
                self.last_error = str(exc)
        return self.state()

    @staticmethod
    def _extracted_source_root(extract_dir: Path) -> Path:
        entries = [path for path in extract_dir.iterdir()]
        if len(entries) == 1 and entries[0].is_dir():
            return entries[0]
        return extract_dir
