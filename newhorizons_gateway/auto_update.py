"""Applies a required update by itself once the Gateway is idle.

Mirrors the Hub's serviceRequiredUpdate(): after a boot grace period, a
required update is applied once no device has been served for IDLE_SEC. An
attempt that leaves the Gateway running (download/apply error, or the
manifest not actually newer yet) blocks further tries for RETRY_SEC, so a
broken release can't make the Gateway restart-loop.

`auto_apply` (reported in the update block, same values as the Hub):
  ""                  no required update
  "waiting_for_idle"  required, will apply once idle
  "retry_later"       a try failed; waiting out RETRY_SEC
"""
from __future__ import annotations

import time
from typing import Any, Callable


BOOT_GRACE_SEC = 60.0
IDLE_SEC = 60.0
RETRY_SEC = 30 * 60.0


class RequiredUpdateAutoApplier:
    def __init__(
        self,
        update_manager: Any,
        is_idle: Callable[[], bool],
        *,
        now: Callable[[], float] = time.monotonic,
        boot_grace_sec: float = BOOT_GRACE_SEC,
        idle_sec: float = IDLE_SEC,
        retry_sec: float = RETRY_SEC,
    ) -> None:
        self.update_manager = update_manager
        self.is_idle = is_idle
        self._now = now
        self.boot_grace_sec = boot_grace_sec
        self.idle_sec = idle_sec
        self.retry_sec = retry_sec
        self._started_at = now()
        self._idle_since: float | None = None
        self._blocked_until = 0.0
        self._attempted = False

    def status(self) -> str:
        if not self.update_manager.state().get("required_update"):
            return ""
        return "retry_later" if self._now() < self._blocked_until else "waiting_for_idle"

    def service(self) -> None:
        manager = self.update_manager
        if manager.busy:
            return  # an update (ours or a manual one) is running
        now = self._now()
        if self._attempted:
            # Still alive after our attempt finished: it did not restart us.
            self._attempted = False
            self._blocked_until = now + self.retry_sec
        if not manager.state().get("required_update"):
            self._idle_since = None
            return
        if now < self._blocked_until or now - self._started_at < self.boot_grace_sec:
            return
        if not self.is_idle():
            self._idle_since = None
            return
        if self._idle_since is None:
            self._idle_since = now
            return
        if now - self._idle_since >= self.idle_sec:
            self._idle_since = None
            self._attempted = True
            manager.start_update()
