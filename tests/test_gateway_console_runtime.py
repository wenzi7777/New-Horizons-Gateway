import tempfile
import unittest
from pathlib import Path

from newhorizons_gateway.console_runtime import (
    classify_console_line,
    console_status_path,
    format_console_header_lines,
    write_console_status,
)


class GatewayConsoleRuntimeTest(unittest.TestCase):
    def test_console_status_path_uses_run_dir(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = console_status_path(tmpdir)

            self.assertEqual(path, Path(tmpdir) / ".run" / "console-status.json")

    def test_write_console_status_persists_latest_snapshot(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            write_console_status(tmpdir, {"enabled": True, "gateway_id": "nh-gateway-test"})

            payload = console_status_path(tmpdir).read_text(encoding="utf-8")

            self.assertIn('"enabled": true', payload)
            self.assertIn('"gateway_id": "nh-gateway-test"', payload)

    def test_classify_console_line_marks_status_polling(self):
        self.assertEqual(classify_console_line('127.0.0.1 - - "GET /api/status HTTP/1.1" 200 -'), "status_poll")
        self.assertEqual(classify_console_line('127.0.0.1 - - "POST /api/settings HTTP/1.1" 200 -'), "event")

    def test_format_console_header_lines_reflects_live_status(self):
        lines = format_console_header_lines(
            {
                "enabled": True,
                "gateway_id": "nh-gateway-test",
                "upstream_connected": True,
                "server_url": "wss://example.com/newhorizons/gateway/ws",
                "web_ui_url": "http://127.0.0.1:5052",
                "listen_udp_port": 13250,
                "listen_discovery_port": 22346,
                "required_update": False,
                "status_poll_count": 12,
            },
            version="v0.3.0",
            config_path=Path("/tmp/config.json"),
            log_path=Path("/tmp/gateway.log"),
        )

        rendered = "\n".join(lines)
        self.assertIn("Enabled: YES", rendered)
        self.assertIn("Upstream: ONLINE", rendered)
        self.assertIn("nh-gateway-test", rendered)
        self.assertIn("Status polls: 12", rendered)
        self.assertIn("Closing this window stops Gateway.", rendered)


if __name__ == "__main__":
    unittest.main()
