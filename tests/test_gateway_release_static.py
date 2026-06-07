import json
import hashlib
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MIRROR_ROOT = ROOT if ROOT.name == "New-Horizons-Gateway" else ROOT.parents[1] / "New-Horizons-Gateway"


class GatewayReleaseStaticTest(unittest.TestCase):
    def test_gateway_version_and_release_metadata_are_v0_1_6(self):
        source_init = (ROOT / "newhorizons_gateway" / "__init__.py").read_text(encoding="utf-8")
        mirror_init = (MIRROR_ROOT / "newhorizons_gateway" / "__init__.py").read_text(encoding="utf-8")
        manifest = json.loads((ROOT / "releases" / "gateway-latest.json").read_text(encoding="utf-8"))
        mirror_manifest = json.loads((MIRROR_ROOT / "releases" / "gateway-latest.json").read_text(encoding="utf-8"))
        release_note = ROOT / "releases" / "notes" / "v0.1.6.md"
        mirror_release_note = MIRROR_ROOT / "releases" / "notes" / "v0.1.6.md"
        artifact = ROOT / "releases" / "artifacts" / "newhorizons-gateway-v0.1.6.zip"
        mirror_artifact = MIRROR_ROOT / "releases" / "artifacts" / "newhorizons-gateway-v0.1.6.zip"

        self.assertIn('__version__ = "v0.1.6"', source_init)
        self.assertIn('__version__ = "v0.1.6"', mirror_init)
        self.assertEqual(manifest["version"], "v0.1.6")
        self.assertEqual(mirror_manifest["version"], "v0.1.6")
        self.assertIn("newhorizons-gateway-v0.1.6.zip", manifest["zip_url"])
        self.assertIn("v0.1.6.md", manifest["notes_url"])
        self.assertIn("newhorizons-gateway-v0.1.6.zip", mirror_manifest["zip_url"])
        self.assertIn("v0.1.6.md", mirror_manifest["notes_url"])
        self.assertTrue(release_note.exists())
        self.assertTrue(mirror_release_note.exists())
        self.assertTrue(artifact.exists())
        self.assertTrue(mirror_artifact.exists())
        self.assertEqual(manifest["sha256"], hashlib.sha256(artifact.read_bytes()).hexdigest())
        self.assertEqual(mirror_manifest["sha256"], hashlib.sha256(mirror_artifact.read_bytes()).hexdigest())


if __name__ == "__main__":
    unittest.main()
