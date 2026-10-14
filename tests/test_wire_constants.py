"""wire.py is generated from the firmware's spec/wire.json (gen_wire.py).

Skipped when NewHorizonsOS-OTA is not checked out beside this repository.
"""
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GENERATOR = ROOT.parent / "NewHorizonsOS-OTA" / "firmware" / "scripts" / "gen_wire.py"


@unittest.skipUnless(GENERATOR.exists(), "NewHorizonsOS-OTA not checked out alongside")
class WireConstantsTest(unittest.TestCase):
    def test_wire_py_is_current(self):
        result = subprocess.run(
            [sys.executable, str(GENERATOR), "--check", "--gateway", str(ROOT)],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
