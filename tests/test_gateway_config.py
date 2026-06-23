import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from newhorizons_gateway.config_store import GatewayConfigStore  # noqa: E402


class GatewayConfigControlStaleTest(unittest.TestCase):
    def _store(self, payload):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "gateway_config.json"
            if payload is not None:
                path.write_text(json.dumps(payload), encoding="utf-8")
            return GatewayConfigStore(str(path)).snapshot()

    def test_default_control_stale_sec(self):
        self.assertEqual(self._store(None)["control_stale_sec"], 16.0)

    def test_override_control_stale_sec(self):
        self.assertEqual(self._store({"control_stale_sec": 25})["control_stale_sec"], 25.0)

    def test_garbage_control_stale_sec_falls_back(self):
        self.assertEqual(self._store({"control_stale_sec": "abc"})["control_stale_sec"], 16.0)

    def test_too_small_control_stale_sec_is_clamped(self):
        self.assertEqual(self._store({"control_stale_sec": 0})["control_stale_sec"], 1.0)


if __name__ == "__main__":
    unittest.main()
