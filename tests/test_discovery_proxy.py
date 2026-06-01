import importlib.util
import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

def load_proxy_module():
    path = ROOT / "scripts" / "discovery_proxy.py"
    spec = importlib.util.spec_from_file_location("discovery_proxy", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DiscoveryProxyTest(unittest.TestCase):
    def test_decodes_json_findme_discover(self):
        proxy = load_proxy_module()
        request = proxy._decode_request(
            json.dumps({"type": "findme_discover", "device_uid": "3CDC7545CCD0", "mode": "maintenance"}).encode()
        )

        self.assertIsNotNone(request)
        self.assertEqual("3CDC7545CCD0", request["device_uid"])
        self.assertEqual("maintenance", request["mode"])

    def test_ignores_non_findme_json(self):
        proxy = load_proxy_module()
        request = proxy._decode_request(b'{"type":"nh_findme_discover","version":1}')

        self.assertIsNone(request)

    def test_encodes_json_findme_offer(self):
        proxy = load_proxy_module()
        reply = json.loads(
            proxy._encode_offer(
                "3CDC7545CCD0",
                {
                    "version": 1,
                    "gateway_name": "New Horizons Gateway",
                    "gateway_id": "local-gateway",
                    "udp_port": 13250,
                    "priority": 100,
                    "accept": True,
                },
            ).decode()
        )

        self.assertEqual("findme_offer", reply["type"])
        self.assertEqual("3CDC7545CCD0", reply["device_uid"])
        self.assertEqual("local-gateway", reply["gateway_id"])
        self.assertEqual(13250, reply["udp_port"])


if __name__ == "__main__":
    unittest.main()
