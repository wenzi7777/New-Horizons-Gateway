from __future__ import annotations

import json
import secrets
import threading
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

from flask import Flask, Response, abort, jsonify, request
from werkzeug.serving import make_server

from . import __version__
from .config_store import GatewayConfigStore, LOCAL_URL, PRODUCTION_URL, validate_gateway_id
from .operations import GatewayOperations, OpResult
from .state import GatewayState
from .update_manager import GatewayUpdateManager


ConfigCallback = Callable[[dict[str, Any]], None]


# The page lives in webui/ (index.html + app.css/app.js/i18n.js/theme.js),
# served as is: no build step. Files are read per request, so they are never
# stale after an update swaps the slot, and every response says no-cache.
WEBUI_DIR = Path(__file__).resolve().parent / "webui"
WEBUI_ASSETS = {
    "app.css": "text/css; charset=utf-8",
    "app.js": "text/javascript; charset=utf-8",
    "i18n.js": "text/javascript; charset=utf-8",
    "theme.js": "text/javascript; charset=utf-8",
}


def render_webui_file(name: str) -> str:
    text = (WEBUI_DIR / name).read_text(encoding="utf-8")
    if name == "index.html":
        text = text.replace("__VERSION__", __version__)
    elif name == "app.js":
        text = text.replace("__PRODUCTION_URL__", PRODUCTION_URL).replace("__LOCAL_URL__", LOCAL_URL)
    return text


class GatewayWebServer:
    def __init__(
        self,
        host: str,
        port: int,
        config_store: GatewayConfigStore,
        state: GatewayState,
        upstream: Any,
        udp_control: Any | None = None,
        *,
        discovery: Any | None = None,
        on_config_saved: ConfigCallback | None = None,
        update_manager: GatewayUpdateManager | None = None,
    ) -> None:
        self.host = host
        self.port = int(port)
        self.config_store = config_store
        self.state = state
        self.upstream = upstream
        self.udp_control = udp_control
        self.discovery = discovery
        self.on_config_saved = on_config_saved
        self.update_manager = update_manager or GatewayUpdateManager()
        self.app = self._make_app()
        self._server: Any = None
        self._thread: threading.Thread | None = None

    def operations(self) -> GatewayOperations:
        # Built per call from the current attributes (tests and main.py may
        # swap discovery/udp_control after construction).
        return GatewayOperations(
            self.config_store,
            self.state,
            self.upstream,
            self.udp_control,
            discovery=self.discovery,
            update_manager=self.update_manager,
            on_config_saved=self.on_config_saved,
        )

    def _make_app(self) -> Flask:
        app = Flask(__name__)

        def no_cache(response: Response) -> Response:
            response.headers["Cache-Control"] = "no-cache"
            return response

        @app.get("/")
        def index() -> Response:
            return no_cache(Response(render_webui_file("index.html"), mimetype="text/html"))

        @app.get("/assets/<name>")
        def asset(name: str) -> Response:
            if name not in WEBUI_ASSETS:
                abort(404)
            return no_cache(Response(render_webui_file(name), content_type=WEBUI_ASSETS[name]))

        @app.get("/api/status")
        def status() -> Any:
            config = self.config_store.snapshot()
            update_state = self.update_manager.maybe_refresh()
            return jsonify({
                "config": self._public_config(config),
                "version": __version__,
                "upstream": self.upstream.status(),
                "udp_control": self.udp_control.snapshot() if self.udp_control is not None else {},
                "state": self.state.snapshot(config.get("denied_devices", [])),
                "update_state": update_state,
            })

        def reply(result: OpResult, *, include_config: bool = False) -> Any:
            if not result.ok:
                return jsonify({"ok": False, "error": result.error}), result.status
            body: dict[str, Any] = {"ok": True}
            body.update(result.data)
            if "config" in body:
                body["config"] = self._public_config(body["config"])
            return jsonify(body)

        @app.post("/api/settings")
        def settings() -> Any:
            body = request.get_json(silent=True) or {}
            settings_body = {
                "target_mode": body.get("target_mode", "production"),
                "manual_url": body.get("manual_url", ""),
                "gateway_id": body.get("gateway_id", ""),
                "enabled": bool(body.get("enabled", False)),
            }
            # Absent (the setup wizard) keeps the saved value.
            if "remote_management" in body:
                settings_body["remote_management"] = bool(body.get("remote_management"))
            return reply(self.operations().save_settings(settings_body))

        @app.post("/api/gateway-id/suggest")
        def suggest_gateway_id() -> Any:
            try:
                return jsonify({"gateway_id": self._request_gateway_id_suggestion()})
            except Exception as exc:
                return jsonify({"ok": False, "error": str(exc)}), 503

        @app.post("/api/update/check")
        def update_check() -> Any:
            return jsonify({"ok": True, "update_state": self.update_manager.check()})

        @app.post("/api/update/start")
        def update_start() -> Any:
            return jsonify({"ok": True, "update_state": self.update_manager.start_update()})

        @app.post("/api/update/download")
        def update_download() -> Any:
            return jsonify({"ok": True, "update_state": self.update_manager.start_update()})

        @app.post("/api/update/apply")
        def update_apply() -> Any:
            return jsonify({"ok": True, "update_state": self.update_manager.start_update()})

        @app.post("/api/update/channel")
        def update_channel() -> Any:
            # Deliberately not locked: switching back to stable is how an
            # operator gets out of a beta-required update.
            body = request.get_json(silent=True) or {}
            return reply(self.operations().set_update_channel(body.get("channel")))

        @app.post("/api/update/restart")
        def update_restart() -> Any:
            return jsonify({"ok": True, "update_state": self.update_manager.restart()})

        @app.post("/api/discover")
        def discover() -> Any:
            return reply(self.operations().discover())

        @app.post("/api/devices/<device_uid>/reject")
        def reject(device_uid: str) -> Any:
            return reply(self.operations().deny(device_uid))

        @app.post("/api/devices/<device_uid>/allow")
        def allow(device_uid: str) -> Any:
            return reply(self.operations().allow(device_uid))

        @app.post("/api/devices/<device_uid>/serve")
        def serve(device_uid: str) -> Any:
            return reply(self.operations().serve(device_uid))

        return app

    @staticmethod
    def _public_config(config: dict[str, Any]) -> dict[str, Any]:
        return dict(config)

    def _request_gateway_id_suggestion(self) -> str:
        return validate_gateway_id(f"nh-gateway-{secrets.token_hex(3)}")

    def _confirm_gateway_id_available(self, gateway_id: str) -> None:
        try:
            payload = self._server_api_post("/api/gateways/suggest-id", {"gateway_id": gateway_id})
        except urllib.error.HTTPError as exc:
            if exc.code == 409:
                raise ValueError("gateway_id_in_use") from exc
            if exc.code in (401, 403):
                raise ValueError("gateway_token_unauthorized") from exc
            return
        except urllib.error.URLError:
            return
        if payload.get("available") is False:
            raise ValueError("gateway_id_in_use")

    def _server_api_post(self, api_path: str, body: dict[str, Any]) -> dict[str, Any]:
        config = self.config_store.snapshot()
        base_url = self._http_base_from_gateway_ws(str(config.get("server_url") or ""))
        url = f"{base_url}{api_path}"
        data = json.dumps(body, separators=(",", ":")).encode("utf-8")
        request_obj = urllib.request.Request(url, data=data, method="POST", headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request_obj, timeout=8) as response:
            payload = json.loads(response.read().decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("invalid_server_response")
        return payload

    @staticmethod
    def _http_base_from_gateway_ws(server_url: str) -> str:
        parsed = urlparse(server_url)
        scheme = "https" if parsed.scheme == "wss" else "http"
        path = parsed.path or ""
        suffix = "/gateway/ws"
        if path.endswith(suffix):
            path = path[: -len(suffix)]
        return f"{scheme}://{parsed.netloc}{path}"

    def start(self) -> None:
        if self._server is not None:
            return
        self._server = make_server(self.host, self.port, self.app, threaded=True)
        self._thread = threading.Thread(target=self._server.serve_forever, name="newhorizons-gateway-web", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        server = self._server
        thread = self._thread
        self._server = None
        self._thread = None
        if server is not None:
            server.shutdown()
        if thread is not None:
            thread.join(timeout=1.0)
