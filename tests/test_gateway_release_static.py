import json
import hashlib
import re
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MIRROR_ROOT = ROOT if ROOT.name == "New-Horizons-Gateway" else ROOT.parents[1] / "New-Horizons-Gateway"


class GatewayReleaseStaticTest(unittest.TestCase):
    def test_gateway_version_and_release_metadata_are_current(self):
        source_init = (ROOT / "newhorizons_gateway" / "__init__.py").read_text(encoding="utf-8")
        mirror_init = (MIRROR_ROOT / "newhorizons_gateway" / "__init__.py").read_text(encoding="utf-8")
        manifest = json.loads((ROOT / "releases" / "gateway-latest.json").read_text(encoding="utf-8"))
        mirror_manifest = json.loads((MIRROR_ROOT / "releases" / "gateway-latest.json").read_text(encoding="utf-8"))
        version_match = re.search(r'__version__ = "(v\d+\.\d+\.\d+)"', source_init)
        self.assertIsNotNone(version_match)
        version = version_match.group(1)
        release_note = ROOT / "releases" / "notes" / f"{version}.md"
        mirror_release_note = MIRROR_ROOT / "releases" / "notes" / f"{version}.md"
        artifact = ROOT / "releases" / "artifacts" / f"newhorizons-gateway-{version}.zip"
        mirror_artifact = MIRROR_ROOT / "releases" / "artifacts" / f"newhorizons-gateway-{version}.zip"

        self.assertIn(f'__version__ = "{version}"', mirror_init)
        self.assertEqual(manifest["version"], version)
        self.assertEqual(mirror_manifest["version"], version)
        self.assertIn(f"newhorizons-gateway-{version}.zip", manifest["zip_url"])
        self.assertIn(f"{version}.md", manifest["notes_url"])
        self.assertIn(f"newhorizons-gateway-{version}.zip", mirror_manifest["zip_url"])
        self.assertIn(f"{version}.md", mirror_manifest["notes_url"])
        self.assertTrue(release_note.exists())
        self.assertTrue(mirror_release_note.exists())
        self.assertTrue(artifact.exists())
        self.assertTrue(mirror_artifact.exists())
        self.assertEqual(manifest["sha256"], hashlib.sha256(artifact.read_bytes()).hexdigest())
        self.assertEqual(mirror_manifest["sha256"], hashlib.sha256(mirror_artifact.read_bytes()).hexdigest())
        with zipfile.ZipFile(artifact) as archive:
            names = archive.namelist()
        self.assertTrue(any(name.startswith("newhorizons_gateway/") for name in names))
        self.assertTrue(any(name.startswith("scripts/") for name in names))
        self.assertIn("pyproject.toml", names)
        self.assertFalse(any("docker" in name.lower() for name in names))
        self.assertFalse(any("discovery_proxy" in name for name in names))

    def test_gateway_readme_documents_host_only_ota_without_env_gate(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")

        self.assertIn("The Gateway is host-only.", readme)
        self.assertIn("Apply update", readme)
        self.assertIn("Restart Gateway", readme)
        self.assertNotIn("NEWHORIZONS_GATEWAY_ALLOW_SELF_UPDATE", readme)

    def test_update_manager_no_longer_exposes_self_update_gate(self):
        source = (ROOT / "newhorizons_gateway" / "update_manager.py").read_text(encoding="utf-8")

        self.assertNotIn("self_update_supported", source)
        self.assertIn('"pyproject.toml"', source)


if __name__ == "__main__":
    unittest.main()
