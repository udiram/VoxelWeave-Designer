from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
CREATE = REPO_ROOT / "scripts" / "create-release-evidence.py"
VERIFY = REPO_ROOT / "scripts" / "verify-release-evidence.py"
SCHEMA = REPO_ROOT / "scripts" / "release-evidence.schema.json"


class ReleaseEvidenceTests(unittest.TestCase):
    def run_verifier(self, manifest: Path, root: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                str(VERIFY),
                "--schema",
                str(SCHEMA),
                "--manifest",
                str(manifest),
                "--artifact-root",
                str(root),
            ],
            check=False,
            capture_output=True,
            text=True,
        )

    def test_valid_development_manifest_is_accepted_and_tampering_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="voxelweave-evidence-") as directory:
            root = Path(directory)
            assets = root / "assets"
            assets.mkdir()
            (assets / "VoxelWeave-Designer-development-macos-arm64.app.zip").write_bytes(b"app-bytes")
            (assets / "VoxelWeave-Designer-development-macos-arm64.dmg").write_bytes(b"dmg-bytes")
            status = root / "signing.json"
            status.write_text(
                json.dumps(
                    {
                        "status": "development-prerelease-not-notarized",
                        "signed": False,
                        "notarized": False,
                        "notarizationStatus": "not-performed",
                    }
                ),
                encoding="utf-8",
            )
            created = subprocess.run(
                [
                    sys.executable,
                    str(CREATE),
                    "--artifact-dir",
                    str(assets),
                    "--output-dir",
                    str(root),
                    "--version",
                    "development-test",
                    "--git-sha",
                    "6ce3895",
                    "--channel",
                    "development-prerelease",
                    "--signing-status-file",
                    str(status),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(created.returncode, 0, created.stderr + created.stdout)
            manifest = root / "release-evidence.json"
            valid = self.run_verifier(manifest, root)
            self.assertEqual(valid.returncode, 0, valid.stderr + valid.stdout)

            (assets / "VoxelWeave-Designer-development-macos-arm64.dmg").write_bytes(b"tampered")
            invalid = self.run_verifier(manifest, root)
            self.assertNotEqual(invalid.returncode, 0)
            self.assertIn("SHA-256 mismatch", invalid.stderr)


if __name__ == "__main__":
    unittest.main()
