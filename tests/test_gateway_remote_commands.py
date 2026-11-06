import json
import socket
import tempfile
import threading
import time
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import MagicMock, patch

from newhorizons_gateway import __version__
from newhorizons_gateway import main as gateway_main
from newhorizons_gateway.auto_update import RequiredUpdateAutoApplier
from newhorizons_gateway.config_store import GatewayConfigStore
from newhorizons_gateway.operations import GatewayOperations
from newhorizons_gateway.remote_commands import CAPABILITIES, GATEWAY_COMMANDS, GatewayCommandHandler
from newhorizons_gateway.state import GatewayState
from newhorizons_gateway.update_manager import GatewayUpdateManager
from newhorizons_gateway.upstream_wss import UpstreamWSSClient


class _Upstream:
    def __init__(self):
        self.gateway_id = ""
        self.server_url = ""
        self.connected = True
        self.claims = []
        self.channel = ""

    def update_server(self, url, _token=None):
        self.server_url = url

    def set_update_channel(self, channel):
        self.channel = channel

    def is_connected(self):
        return self.connected

    def send_claim_request(self, uid, claim_id, ttl):
        self.claims.append((uid, claim_id, ttl))


class RemoteCommandTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.store = GatewayConfigStore(str(root / "config.json"))
        self.store.save({"gateway_id": "gw-a", "enabled": True, "target_mode": "local"})
        self.state = GatewayState()
        self.upstream = _Upstream()
        self.manager = GatewayUpdateManager(app_root=root, staging_root=root / ".run")
        self.saved = []
        self.discovery = MagicMock()
        self.results = []
        self.events = []
        self.restarts = []

        def ops():
            return GatewayOperations(
                self.store, self.state, self.upstream, None,
                discovery=self.discovery, update_manager=self.manager,
                on_config_saved=self.on_saved,
            )

        def send(request_id, result):  # noqa: E306
            self.events.append("reply")
            self.results.append((request_id, result))

        def restart():
            self.events.append("restart")
            self.restarts.append(True)

        self.handler = GatewayCommandHandler(
            ops, send, restart=restart,
            update_block=lambda: self.manager.update_block(""),
            grace_sec=0, run_async=False,
        )

    def on_saved(self, config):
        # What main.apply_runtime_config does with the channel.
        self.saved.append(config)
        self.manager.set_channel(config["update_channel"])

    def tearDown(self):
        self.tmp.cleanup()

    def run_cmd(self, command, **args):
        payload = {"command": command, **args}
        handled = self.handler.handle_message({"type": "gateway_command", "request_id": "r1", "payload": payload})
        self.assertTrue(handled)
        self.assertEqual(self.results[-1][0], "r1")
        return self.results[-1][1]

    def test_ignores_other_messages(self):
        self.assertFalse(self.handler.handle_message({"type": "gateway_hello_ack"}))

    def test_unknown_command(self):
        result = self.run_cmd("format_disk")
        self.assertFalse(result["ok"])
        self.assertEqual(result["message"], "unknown_command")

    def test_set_config_replies_before_applying_and_keeps_enabled(self):
        result = self.run_cmd("set_config", gateway_id="gw-b", target_mode="manual", manual_url="ws://10.0.0.2:5051/newhorizons/gateway/ws", enabled=False)
        self.assertTrue(result["ok"])
        config = self.store.snapshot()
        self.assertEqual(config["gateway_id"], "gw-b")
        self.assertEqual(config["server_url"], "ws://10.0.0.2:5051/newhorizons/gateway/ws")
        self.assertTrue(config["enabled"])  # remote never disables
        self.assertEqual(len(self.saved), 1)

    def test_set_config_rejects_bad_values_without_saving(self):
        for args, message in (
            ({"gateway_id": "bad id!"}, "gateway_id_invalid"),
            ({"target_mode": "manual", "manual_url": "http://x"}, "invalid_manual_url"),
            ({"target_mode": "cloud"}, "invalid_target_mode"),
            ({}, "nothing_to_change"),
        ):
            result = self.run_cmd("set_config", **args)
            self.assertFalse(result["ok"], args)
            self.assertEqual(result["message"], message)
        self.assertEqual(self.store.snapshot()["gateway_id"], "gw-a")
        self.assertEqual(self.saved, [])

    def test_required_update_locks_config_and_devices_but_not_channel(self):
        self.manager.set_server_latest_version("v99.0.0")
        self.assertEqual(self.run_cmd("set_config", gateway_id="gw-b")["message"], "update_required")
        self.assertEqual(self.run_cmd("discover")["message"], "update_required")
        self.assertEqual(self.run_cmd("device_reject", device_uid="AA")["message"], "update_required")
        self.assertTrue(self.run_cmd("set_update_channel", channel="beta")["ok"])

    def test_set_update_channel(self):
        result = self.run_cmd("set_update_channel", channel="beta")
        self.assertTrue(result["ok"])
        self.assertEqual(self.store.snapshot()["update_channel"], "beta")
        self.assertEqual(result["update"]["channel"], "beta")
        self.assertFalse(self.run_cmd("set_update_channel", channel="nightly")["ok"])

    def test_device_commands(self):
        self.assertTrue(self.run_cmd("discover")["ok"])
        self.discovery.send_probe.assert_called_once()
        result = self.run_cmd("device_reject", device_uid="aa11")
        self.assertEqual(result["denied_devices"], ["AA11"])
        self.assertEqual(self.run_cmd("device_serve", device_uid="AA11")["message"], "device_denied")
        self.assertEqual(self.run_cmd("device_allow", device_uid="AA11")["denied_devices"], [])
        result = self.run_cmd("device_serve", device_uid="AA11")
        self.assertTrue(result["ok"])
        self.assertEqual(self.upstream.claims[0][0], "AA11")
        self.assertEqual(self.run_cmd("device_allow")["message"], "device_uid_required")

    def test_restart_replies_first(self):
        result = self.run_cmd("restart")
        self.assertTrue(result["ok"])
        self.assertEqual(self.events, ["reply", "restart"])

    def test_factory_reset_clears_identity_keeps_ports(self):
        self.store.save({"listen_web_port": 6000, "denied_devices": ["AA"]})
        result = self.run_cmd("factory_reset")
        self.assertTrue(result["ok"])
        config = self.store.snapshot()
        self.assertFalse(config["enabled"])
        self.assertEqual(config["gateway_id"], "")
        self.assertEqual(config["denied_devices"], [])
        self.assertEqual(config["listen_web_port"], 6000)

    def test_check_update_reports_versions(self):
        manifest = {"version": "v99.0.0", "zip_url": "https://x/z.zip", "sha256": "ab"}

        class _Resp:
            def __init__(self, body):
                self.body = body

            def read(self):
                return self.body

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

        with patch("newhorizons_gateway.update_manager.urllib.request.urlopen", return_value=_Resp(json.dumps(manifest).encode())):
            result = self.run_cmd("check_update")
        self.assertEqual(result["message"], "update_available")
        self.assertEqual(result["current_version"], __version__)
        self.assertEqual(result["update"]["version"], "v99.0.0")
        self.assertTrue(result["update"]["required_update"])

    def test_apply_update_starts_worker(self):
        self.manager.start_update = MagicMock()
        result = self.run_cmd("apply_update")
        self.assertEqual(result["message"], "update_started")
        self.manager.start_update.assert_called_once()

    def test_command_list_is_what_the_desktop_expects(self):
        self.assertEqual(set(GATEWAY_COMMANDS), {
            "set_config", "check_update", "apply_update", "set_update_channel", "restart",
            "factory_reset", "discover", "device_reject", "device_allow", "device_serve",
        })


class HelloTest(unittest.TestCase):
    def test_hello_identifies_gateway_and_capabilities(self):
        client = UpstreamWSSClient(server_url="ws://127.0.0.1:1/x", gateway_id="gw-a")
        hello = client._hello_payload()
        self.assertEqual(hello["client_type"], "gateway")
        self.assertIn("gateway_command", hello["capabilities"])
        self.assertEqual(tuple(hello["capabilities"]), CAPABILITIES)

    def test_command_result_message_shape(self):
        client = UpstreamWSSClient(server_url="ws://127.0.0.1:1/x", gateway_id="gw-a")
        client.send_gateway_command_result("r9", {"ok": True, "message": "x"})
        message = client.control_queue.get_nowait()
        self.assertEqual(message["type"], "gateway_command_result")
        self.assertEqual(message["request_id"], "r9")
        self.assertEqual(message["result"]["message"], "x")


class _FakeManager:
    def __init__(self):
        self.required = True
        self.busy = False
        self.starts = 0

    def state(self):
        return {"required_update": self.required}

    def start_update(self):
        self.starts += 1
        self.busy = True


class AutoApplyTest(unittest.TestCase):
    def setUp(self):
        self.clock = [0.0]
        self.idle = [True]
        self.manager = _FakeManager()
        self.applier = RequiredUpdateAutoApplier(
            self.manager, lambda: self.idle[0], now=lambda: self.clock[0],
        )

    def tick(self, until, step=5.0):
        while self.clock[0] < until:
            self.clock[0] += step
            self.applier.service()

    def test_waits_boot_grace_then_idle(self):
        self.assertEqual(self.applier.status(), "waiting_for_idle")
        self.tick(59)
        self.assertEqual(self.manager.starts, 0)
        self.tick(125)
        self.assertEqual(self.manager.starts, 1)

    def test_busy_device_resets_idle_timer(self):
        self.tick(100)
        self.idle[0] = False
        self.tick(400)
        self.assertEqual(self.manager.starts, 0)
        self.idle[0] = True
        self.tick(470)
        self.assertEqual(self.manager.starts, 1)

    def test_failed_attempt_waits_retry_window(self):
        self.tick(125)
        self.assertEqual(self.manager.starts, 1)
        self.manager.busy = False  # finished without restarting us
        self.tick(130)
        self.assertEqual(self.applier.status(), "retry_later")
        self.tick(130 + 29 * 60)
        self.assertEqual(self.manager.starts, 1)
        self.tick(130 + 32 * 60)
        self.assertEqual(self.manager.starts, 2)

    def test_nothing_required(self):
        self.manager.required = False
        self.tick(1000)
        self.assertEqual(self.manager.starts, 0)
        self.assertEqual(self.applier.status(), "")


def _free_port(kind=socket.SOCK_STREAM):
    with socket.socket(socket.AF_INET, kind) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class SoftRestartTest(unittest.TestCase):
    """Restart with no slot switch staged re-runs main.run() and rebinds the
    same ports, instead of exiting (which made the bootloader stop)."""

    def test_restart_returns_restart_and_runs_again(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            web_port = _free_port()
            config_path = root / "config" / "config.json"
            config_path.parent.mkdir(parents=True)
            config_path.write_text(json.dumps({
                "enabled": False,
                "listen_web_host": "127.0.0.1",
                "listen_web_port": web_port,
                "listen_udp_host": "127.0.0.1",
                "listen_udp_port": _free_port(socket.SOCK_DGRAM),
                "listen_discovery_host": "127.0.0.1",
                "listen_discovery_port": _free_port(socket.SOCK_DGRAM),
            }))
            env = {
                "NEWHORIZONS_GATEWAY_APP_ROOT": str(root),
                "NEWHORIZONS_GATEWAY_RUNTIME_ROOT": str(root / ".run"),
                "NEWHORIZONS_GATEWAY_HEALTH_PATH": str(root / ".run" / "health.json"),
                "NEWHORIZONS_GATEWAY_UPDATE_INTERVAL_SEC": "3600",
            }
            stop = threading.Event()
            outcomes = []

            def runner():
                outcomes.append(gateway_main.run(str(config_path), stop_event=stop))
                outcomes.append(gateway_main.run(str(config_path), stop_event=stop))

            def post(path):
                request = urllib.request.Request(f"http://127.0.0.1:{web_port}{path}", data=b"{}", method="POST", headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(request, timeout=3) as response:
                    return json.loads(response.read())

            def wait_up():
                deadline = time.time() + 10
                while time.time() < deadline:
                    try:
                        urllib.request.urlopen(f"http://127.0.0.1:{web_port}/api/status", timeout=1).read()
                        return
                    except Exception:
                        time.sleep(0.1)
                self.fail("web UI did not come up")

            with patch.dict("os.environ", env), \
                 patch("newhorizons_gateway.update_manager.GatewayUpdateManager.check", lambda self, force=True: self.state()), \
                 patch("newhorizons_gateway.main.write_console_status"):
                thread = threading.Thread(target=runner, daemon=True)
                thread.start()
                wait_up()
                self.assertEqual(post("/api/update/restart")["update_state"]["phase"], "restarting")
                deadline = time.time() + 10
                while not outcomes and time.time() < deadline:
                    time.sleep(0.1)
                self.assertEqual(outcomes, [gateway_main.RESTART])
                wait_up()  # second run bound the same port
                stop.set()
                thread.join(timeout=10)
            self.assertEqual(outcomes, [gateway_main.RESTART, None])


if __name__ == "__main__":
    unittest.main()
