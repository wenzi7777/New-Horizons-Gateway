"""Desktop -> Gateway management commands (`gateway_command`).

The Desktop Backend sends {"type":"gateway_command","request_id","payload":
{"command", ...args}} over the upstream WebSocket -- the same message pair it
uses for a Hub -- and expects {"type":"gateway_command_result","request_id",
"result":{"ok","message",...}} back.

Commands run on a worker thread, never on the WebSocket receive thread:
several of them reconnect or stop that very socket. Anything that cuts the
connection (set_config, restart, factory_reset, apply_update) replies first
and acts after REPLY_GRACE_SEC, so the reply leaves before the socket closes.
"""
from __future__ import annotations

import threading
import time
from typing import Any, Callable

from . import __version__
from .config_store import validate_gateway_id
from .operations import GatewayOperations, OpResult


GATEWAY_COMMANDS = (
    "set_config",
    "check_update",
    "apply_update",
    "set_update_channel",
    "restart",
    "factory_reset",
    "discover",
    "device_reject",
    "device_allow",
    "device_serve",
)

# Advertised in hello so the Desktop knows this Gateway takes them.
CAPABILITIES = ("gateway_command", "auto_update")

REPLY_GRACE_SEC = 1.0


class GatewayCommandHandler:
    def __init__(
        self,
        operations: Callable[[], GatewayOperations],
        send_result: Callable[[str, dict[str, Any]], None],
        *,
        restart: Callable[[], Any],
        update_block: Callable[[], dict[str, Any]],
        after_command: Callable[[], None] | None = None,
        grace_sec: float = REPLY_GRACE_SEC,
        run_async: bool = True,
    ) -> None:
        self._operations = operations
        self._send_result = send_result
        self._restart = restart
        self._update_block = update_block
        self._after_command = after_command
        self._grace_sec = grace_sec
        self._run_async = run_async

    def handle_message(self, message: dict[str, Any]) -> bool:
        """Returns True when `message` was a gateway_command (handled or queued)."""
        if message.get("type") != "gateway_command":
            return False
        payload = message.get("payload") if isinstance(message.get("payload"), dict) else {}
        request_id = str(message.get("request_id") or payload.get("request_id") or "")
        if self._run_async:
            threading.Thread(
                target=self._handle, args=(request_id, dict(payload)),
                name="gateway-command", daemon=True,
            ).start()
        else:
            self._handle(request_id, dict(payload))
        return True

    # -- dispatch ------------------------------------------------------------

    def _handle(self, request_id: str, payload: dict[str, Any]) -> None:
        command = str(payload.get("command") or "")
        deferred: Callable[[], Any] | None = None
        try:
            if command not in GATEWAY_COMMANDS:
                result = {"ok": False, "message": "unknown_command"}
            elif not self._remote_management_enabled():
                result = {"ok": False, "message": "remote_management_disabled"}
            else:
                result, deferred = getattr(self, "_cmd_" + command)(payload)
        except Exception as exc:  # never leave the Desktop waiting
            result, deferred = {"ok": False, "message": "command_failed", "error": str(exc)}, None
        result.setdefault("command", command)
        self._send_result(request_id, result)
        if deferred is not None:
            if self._grace_sec > 0:
                time.sleep(self._grace_sec)
            try:
                deferred()
            except Exception:
                pass
        if self._after_command is not None:
            try:
                self._after_command()
            except Exception:
                pass

    def _remote_management_enabled(self) -> bool:
        return bool(self._operations().config_store.snapshot().get("remote_management", True))

    @staticmethod
    def _from_op(result: OpResult, ok_message: str) -> dict[str, Any]:
        if not result.ok:
            out: dict[str, Any] = {"ok": False, "message": result.error}
        else:
            out = {"ok": True, "message": ok_message}
        for key in ("denied_devices", "claim"):
            if key in result.data:
                out[key] = result.data[key]
        return out

    # -- commands ------------------------------------------------------------

    def _cmd_set_config(self, payload: dict[str, Any]):
        ops = self._operations()
        if ops.is_locked():
            return {"ok": False, "message": "update_required"}, None
        body = {key: payload[key] for key in ("gateway_id", "target_mode", "manual_url") if key in payload}
        if not body:
            return {"ok": False, "message": "nothing_to_change"}, None
        # Validate now so the reply is honest, apply after the reply has left:
        # a new ID or URL reconnects the socket this reply travels on.
        preview = dict(ops.config_store.snapshot())
        preview.update(body)
        try:
            validate_gateway_id(preview.get("gateway_id"))
        except ValueError as exc:
            return {"ok": False, "message": str(exc)}, None
        if preview.get("target_mode") not in ("production", "local", "manual"):
            return {"ok": False, "message": "invalid_target_mode"}, None
        if preview.get("target_mode") == "manual" and not str(preview.get("manual_url") or "").strip().lower().startswith(("ws://", "wss://")):
            return {"ok": False, "message": "invalid_manual_url"}, None
        return {"ok": True, "message": "config_saved_reconnecting"}, (
            lambda: ops.save_settings(body, allow_enable_change=False)
        )

    def _cmd_check_update(self, _payload: dict[str, Any]):
        state = self._operations().update_manager.check(force=True)
        if state.get("phase") == "error":
            message = "update_check_failed"
        elif state.get("update_available"):
            message = "update_available"
        else:
            message = "up_to_date"
        return {
            "ok": message != "update_check_failed",
            "message": message,
            "current_version": __version__,
            "update": self._update_block(),
        }, None

    def _cmd_apply_update(self, _payload: dict[str, Any]):
        manager = self._operations().update_manager
        if manager.busy:
            return {"ok": True, "message": "update_in_progress", "update": self._update_block()}, None
        # The update worker restarts the Gateway when it is done, so it can
        # start right away -- the download alone outlasts the reply.
        manager.start_update()
        return {"ok": True, "message": "update_started", "current_version": __version__}, None

    def _cmd_set_update_channel(self, payload: dict[str, Any]):
        result = self._operations().set_update_channel(payload.get("channel"))
        out = self._from_op(result, "update_channel_set")
        out["update"] = self._update_block()
        return out, None

    def _cmd_restart(self, _payload: dict[str, Any]):
        return {"ok": True, "message": "restarting"}, self._restart

    def _cmd_factory_reset(self, _payload: dict[str, Any]):
        ops = self._operations()
        return {"ok": True, "message": "factory_reset_disconnecting"}, ops.factory_reset

    def _cmd_discover(self, _payload: dict[str, Any]):
        return self._from_op(self._operations().discover(), "discover_sent"), None

    def _cmd_device_reject(self, payload: dict[str, Any]):
        return self._from_op(self._operations().deny(payload.get("device_uid")), "device_rejected"), None

    def _cmd_device_allow(self, payload: dict[str, Any]):
        return self._from_op(self._operations().allow(payload.get("device_uid")), "device_allowed"), None

    def _cmd_device_serve(self, payload: dict[str, Any]):
        return self._from_op(self._operations().serve(payload.get("device_uid")), "claim_requested"), None
