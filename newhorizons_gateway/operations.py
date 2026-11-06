"""Gateway management operations shared by the local WebUI and the Desktop.

Both web.py's routes and remote_commands.py (the Desktop's `gateway_command`
over the upstream WebSocket) call these, so the two front ends can never drift
apart. Each operation returns an `OpResult`: `ok`, an error code when not ok,
an HTTP-ish status for the WebUI, and a data dict to merge into the reply.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from .config_store import DEFAULT_CONFIG, GatewayConfigStore, validate_gateway_id
from .state import GatewayState
from .update_manager import GatewayUpdateManager
from .versioning import UPDATE_CHANNELS


ConfigCallback = Callable[[dict[str, Any]], None]

DEVICE_CONTROL_PORT = 13250

# Kept across a factory reset: these describe the host, not the Gateway's
# identity, and the Gateway could not even come back up without them.
_FACTORY_RESET_KEEP = (
    "listen_udp_host",
    "listen_udp_port",
    "listen_discovery_host",
    "listen_discovery_port",
    "listen_web_host",
    "listen_web_port",
)


@dataclass
class OpResult:
    ok: bool
    error: str = ""
    status: int = 200
    data: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def fail(cls, error: str, status: int = 400, **data: Any) -> "OpResult":
        return cls(ok=False, error=error, status=status, data=dict(data))


class GatewayOperations:
    def __init__(
        self,
        config_store: GatewayConfigStore,
        state: GatewayState,
        upstream: Any,
        udp_control: Any = None,
        *,
        discovery: Any = None,
        update_manager: GatewayUpdateManager | None = None,
        on_config_saved: ConfigCallback | None = None,
    ) -> None:
        self.config_store = config_store
        self.state = state
        self.upstream = upstream
        self.udp_control = udp_control
        self.discovery = discovery
        self.update_manager = update_manager or GatewayUpdateManager()
        self.on_config_saved = on_config_saved

    # -- helpers -----------------------------------------------------------

    def is_locked(self) -> bool:
        """A required update locks settings and device management until the
        Gateway is updated (the channel switch stays open: leaving beta is how
        an operator gets out of a beta-only lock)."""
        return bool(self.update_manager.state().get("required_update"))

    def _locked(self) -> OpResult | None:
        if self.is_locked():
            return OpResult.fail("update_required", 409, update_state=self.update_manager.state())
        return None

    def _commit(self, config: dict[str, Any]) -> None:
        if self.on_config_saved is not None:
            self.on_config_saved(config)
        else:
            self.upstream.gateway_id = str(config.get("gateway_id") or "")
            self.upstream.update_server(str(config["server_url"]), "")

    # -- settings ----------------------------------------------------------

    def save_settings(self, body: dict[str, Any], *, allow_enable_change: bool = True) -> OpResult:
        """`target_mode`, `manual_url`, `gateway_id`, `enabled`. Keys missing
        from `body` keep their current value. With allow_enable_change=False
        (the remote path) `enabled` is never touched: a Desktop that disabled
        the Gateway could never reach it again."""
        locked = self._locked()
        if locked is not None:
            return locked
        current = self.config_store.snapshot()
        patch = {
            "target_mode": str(body.get("target_mode", current.get("target_mode", "production")) or "production"),
            "manual_url": str(body.get("manual_url", current.get("manual_url", "")) or ""),
            "gateway_id": str(body.get("gateway_id", current.get("gateway_id", "")) or ""),
        }
        if patch["target_mode"] not in ("production", "local", "manual"):
            return OpResult.fail("invalid_target_mode")
        # Remote only: a bad URL there would cut the Desktop off for good.
        if not allow_enable_change and patch["target_mode"] == "manual" and not patch["manual_url"].strip().lower().startswith(("ws://", "wss://")):
            return OpResult.fail("invalid_manual_url")
        if allow_enable_change:
            patch["enabled"] = bool(body.get("enabled", current.get("enabled", False)))
        try:
            if patch.get("enabled", current.get("enabled")):
                validate_gateway_id(patch["gateway_id"])
            config = self.config_store.save(patch)
        except ValueError as exc:
            return OpResult.fail(str(exc))
        self._commit(config)
        return OpResult(ok=True, data={"config": dict(config)})

    def set_update_channel(self, channel: Any) -> OpResult:
        normalized = str(channel or "").strip().lower()
        if normalized not in UPDATE_CHANNELS:
            return OpResult.fail("invalid_update_channel")
        config = self.config_store.save({"update_channel": normalized})
        if self.on_config_saved is not None:
            self.on_config_saved(config)
        else:
            self.update_manager.set_channel(normalized)
            self.upstream.set_update_channel(normalized)
        return OpResult(ok=True, data={"config": dict(config), "update_state": self.update_manager.state()})

    def factory_reset(self) -> OpResult:
        """Back to first-run settings (disabled, no Gateway ID). The installed
        slots and version are untouched; the host ports are kept."""
        current = self.config_store.snapshot()
        patch = dict(DEFAULT_CONFIG)
        for key in _FACTORY_RESET_KEEP:
            patch[key] = current.get(key, DEFAULT_CONFIG[key])
        patch["denied_devices"] = []
        config = self.config_store.save(patch)
        self._commit(config)
        return OpResult(ok=True, data={"config": dict(config)})

    # -- devices -----------------------------------------------------------

    def discover(self) -> OpResult:
        locked = self._locked()
        if locked is not None:
            return locked
        if self.discovery is not None:
            self.discovery.send_probe()
        return OpResult(ok=True)

    @staticmethod
    def _uid(device_uid: Any) -> str:
        return str(device_uid or "").strip().upper()

    def deny(self, device_uid: Any) -> OpResult:
        locked = self._locked()
        if locked is not None:
            return locked
        uid = self._uid(device_uid)
        if not uid:
            return OpResult.fail("device_uid_required")
        config = self.config_store.deny(uid)
        return OpResult(ok=True, data={"denied_devices": config.get("denied_devices", [])})

    def allow(self, device_uid: Any) -> OpResult:
        locked = self._locked()
        if locked is not None:
            return locked
        uid = self._uid(device_uid)
        if not uid:
            return OpResult.fail("device_uid_required")
        config = self.config_store.allow(uid)
        return OpResult(ok=True, data={"denied_devices": config.get("denied_devices", [])})

    def serve(self, device_uid: Any) -> OpResult:
        """Asks a nearby device to switch to this Gateway (FindMe claim)."""
        locked = self._locked()
        if locked is not None:
            return locked
        uid = self._uid(device_uid)
        if not uid:
            return OpResult.fail("device_uid_required")
        if self.config_store.is_denied(uid):
            return OpResult.fail("device_denied", 409)
        if not self.upstream.is_connected():
            return OpResult.fail("upstream_offline", 503)
        claim = self.state.create_claim(uid)
        self.state.update_claim(claim["claim_id"], state="sent")
        self.upstream.send_claim_request(claim["device_uid"], claim["claim_id"], int(claim["ttl_ms"]))
        updated = self.state.update_claim(claim["claim_id"], state="requested")
        device_ip = self.state.last_findme_addr(uid)
        if device_ip and self.udp_control is not None:
            gw_id = str(self.config_store.snapshot().get("gateway_id") or "")
            self.udp_control.send_command_to(uid, (device_ip, DEVICE_CONTROL_PORT), {
                "command": "findme_switch_gateway",
                "request_id": "findme-claim-{}".format(claim["claim_id"]),
                "preferred_gateway_id": gw_id,
                "claim_id": claim["claim_id"],
                "ttl_ms": int(claim["ttl_ms"]),
                "expires_at_ms": int(claim["expires_at_ms"]),
            })
        return OpResult(ok=True, data={"claim": updated or claim})
