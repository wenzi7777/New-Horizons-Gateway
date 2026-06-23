from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SLOT_A = "slot_a"
SLOT_B = "slot_b"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def default_boot_state() -> dict[str, Any]:
    return {
        "active_slot": SLOT_A,
        "pending_slot": "",
        "previous_slot": "",
        "target_version": "",
        "boot_phase": "idle",
        "rollback_reason": "",
        "last_transition_at": _now_iso(),
    }


def default_health_payload() -> dict[str, Any]:
    return {
        "slot": "",
        "version": "",
        "ready": False,
        "phase": "idle",
        "web_port": 5052,
        "updated_at": _now_iso(),
    }


def health_payload_ready(payload: dict[str, Any], *, slot_name: str, version: str) -> bool:
    return (
        bool(payload.get("ready"))
        and str(payload.get("slot") or "") == str(slot_name or "")
        and str(payload.get("version") or "") == str(version or "")
    )


class GatewayHealthStore:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)

    def read(self) -> dict[str, Any]:
        if not self.path.exists():
            return default_health_payload()
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            return default_health_payload()
        if not isinstance(payload, dict):
            return default_health_payload()
        result = default_health_payload()
        result.update(payload)
        return result

    def write(self, payload: dict[str, Any]) -> dict[str, Any]:
        current = default_health_payload()
        current.update(payload or {})
        current["updated_at"] = _now_iso()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(current, indent=2, sort_keys=True), encoding="utf-8")
        return current

    def clear(self) -> dict[str, Any]:
        return self.write(default_health_payload())


class GatewayBootStateStore:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)

    def load(self) -> dict[str, Any]:
        if not self.path.exists():
            return default_boot_state()
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            return default_boot_state()
        if not isinstance(payload, dict):
            return default_boot_state()
        state = default_boot_state()
        state.update(payload)
        self._normalize(state)
        return state

    def save(self, payload: dict[str, Any]) -> dict[str, Any]:
        state = default_boot_state()
        state.update(payload or {})
        self._normalize(state)
        state["last_transition_at"] = _now_iso()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
        return state

    @staticmethod
    def inactive_slot(state: dict[str, Any]) -> str:
        return SLOT_B if str(state.get("active_slot") or SLOT_A) == SLOT_A else SLOT_A

    def mark_pending_switch(self, *, target_version: str) -> dict[str, Any]:
        state = self.load()
        active_slot = str(state.get("active_slot") or SLOT_A)
        pending_slot = self.inactive_slot(state)
        state.update({
            "active_slot": active_slot,
            "pending_slot": pending_slot,
            "previous_slot": active_slot,
            "target_version": str(target_version or ""),
            "boot_phase": "pending_switch",
            "rollback_reason": "",
        })
        return self.save(state)

    def commit_pending(self) -> dict[str, Any]:
        state = self.load()
        pending_slot = str(state.get("pending_slot") or "")
        if pending_slot:
            state["active_slot"] = pending_slot
        state["pending_slot"] = ""
        state["previous_slot"] = ""
        state["boot_phase"] = "idle"
        state["rollback_reason"] = ""
        return self.save(state)

    def rollback_pending(self, reason: str) -> dict[str, Any]:
        state = self.load()
        previous_slot = str(state.get("previous_slot") or state.get("active_slot") or SLOT_A)
        state["active_slot"] = previous_slot or SLOT_A
        state["pending_slot"] = ""
        state["previous_slot"] = ""
        state["boot_phase"] = "rolled_back"
        state["rollback_reason"] = str(reason or "rollback")
        return self.save(state)

    def reset(self) -> dict[str, Any]:
        return self.save(default_boot_state())

    @staticmethod
    def _normalize(state: dict[str, Any]) -> None:
        active_slot = str(state.get("active_slot") or SLOT_A)
        if active_slot not in (SLOT_A, SLOT_B):
            active_slot = SLOT_A
        pending_slot = str(state.get("pending_slot") or "")
        if pending_slot not in ("", SLOT_A, SLOT_B):
            pending_slot = ""
        previous_slot = str(state.get("previous_slot") or "")
        if previous_slot not in ("", SLOT_A, SLOT_B):
            previous_slot = ""
        state["active_slot"] = active_slot
        state["pending_slot"] = pending_slot
        state["previous_slot"] = previous_slot
        state["target_version"] = str(state.get("target_version") or "")
        state["boot_phase"] = str(state.get("boot_phase") or "idle")
        state["rollback_reason"] = str(state.get("rollback_reason") or "")
        state["last_transition_at"] = str(state.get("last_transition_at") or _now_iso())
