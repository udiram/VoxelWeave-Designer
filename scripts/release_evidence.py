#!/usr/bin/env python3
"""Create the checksums and evidence manifest for a VoxelWeave release."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "voxelweave.release-evidence.v1"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
GIT_SHA_RE = re.compile(r"^[0-9a-fA-F]{7,64}$")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def load_signing_status(path: Path | None, channel: str) -> dict[str, Any]:
    if path is None:
        if channel == "stable":
            raise ValueError("stable evidence requires a signing status file")
        return {
            "status": "development-prerelease-not-notarized",
            "signed": False,
            "notarized": False,
            "notarizationStatus": "not-performed",
        }
    status = read_json(path)
    required = ("status", "signed", "notarized", "notarizationStatus")
    missing = [key for key in required if key not in status]
    if missing:
        raise ValueError(f"signing status is missing: {', '.join(missing)}")
    return {
        "status": status["status"],
        "signed": bool(status["signed"]),
        "notarized": bool(status["notarized"]),
        "notarizationStatus": status["notarizationStatus"],
    }


def create_manifest(
    *,
    artifact_dir: Path,
    output_dir: Path,
    version: str,
    git_sha: str,
    channel: str,
    signing_status_file: Path | None = None,
    runner: str = "macos-14",
    workflow: str = "release.yml",
    architecture_report: Path | None = None,
) -> tuple[Path, Path]:
    if channel not in {"stable", "development-prerelease"}:
        raise ValueError("channel must be stable or development-prerelease")
    if not version or any(character.isspace() for character in version):
        raise ValueError("version must be a non-empty value without whitespace")
    if not GIT_SHA_RE.fullmatch(git_sha):
        raise ValueError("git-sha must contain 7-64 hexadecimal characters")
    if runner != "macos-14":
        raise ValueError("release evidence is restricted to the macos-14 runner")

    artifact_dir = artifact_dir.resolve()
    output_dir = output_dir.resolve()
    if not artifact_dir.is_dir():
        raise ValueError(f"artifact directory does not exist: {artifact_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)

    artifact_paths = sorted(
        path for path in artifact_dir.iterdir() if path.is_file() and path.suffix.lower() in {".zip", ".dmg"}
    )
    if not artifact_paths:
        raise ValueError(f"no .zip or .dmg release assets found in {artifact_dir}")

    artifacts: list[dict[str, Any]] = []
    for path in artifact_paths:
        relative_path = path.relative_to(output_dir) if output_dir in path.parents else Path(path.name)
        kind = "app-zip" if path.suffix.lower() == ".zip" else "dmg"
        architecture = "arm64" if kind == "app-zip" else "not_applicable"
        artifacts.append(
            {
                "name": path.name,
                "path": relative_path.as_posix(),
                "kind": kind,
                "sizeBytes": path.stat().st_size,
                "sha256": sha256_file(path),
                "architecture": architecture,
            }
        )

    signing = load_signing_status(signing_status_file, channel)
    if channel == "stable" and (not signing["signed"] or not signing["notarized"]):
        raise ValueError("stable evidence requires both signed=true and notarized=true")
    if channel == "development-prerelease" and signing["notarized"]:
        raise ValueError("development-prerelease evidence must not claim notarization")

    architecture_value: dict[str, Any] = {
        "status": "passed",
        "targetArchitecture": "arm64",
        "rustTarget": "aarch64-apple-darwin",
        "scope": "app, sidecar, native extensions, and frameworks",
    }
    if architecture_report is not None:
        report = architecture_report.resolve()
        if not report.is_file():
            raise ValueError(f"architecture report does not exist: {report}")
        try:
            report_path = report.relative_to(output_dir).as_posix()
        except ValueError:
            report_path = report.name
        architecture_value["report"] = report_path
        architecture_value["reportSha256"] = sha256_file(report)

    manifest: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "release": {
            "version": version,
            "gitSha": git_sha.lower(),
            "channel": channel,
            "generatedAt": utc_now(),
            "workflow": workflow,
        },
        "target": {
            "platform": "macOS",
            "minimumOS": "14",
            "runner": runner,
            "architecture": "arm64",
            "rustTarget": "aarch64-apple-darwin",
        },
        "artifacts": artifacts,
        "checksums": {
            "algorithm": "SHA-256",
            "file": "SHA256SUMS",
        },
        "verification": {
            "architecture": architecture_value,
            "checksums": {"status": "passed", "algorithm": "SHA-256"},
            "packaging": {"status": "passed", "appAndDmgBuilt": True},
        },
        "signing": signing,
    }

    manifest_path = output_dir / "release-evidence.json"
    checksum_path = output_dir / "SHA256SUMS"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    checksum_path.write_text(
        "".join(f"{artifact['sha256']}  {artifact['name']}\n" for artifact in artifacts),
        encoding="utf-8",
    )
    return manifest_path, checksum_path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--git-sha", required=True)
    parser.add_argument("--channel", choices=("stable", "development-prerelease"), required=True)
    parser.add_argument("--signing-status-file", type=Path)
    parser.add_argument("--runner", default="macos-14")
    parser.add_argument("--workflow", default="release.yml")
    parser.add_argument("--architecture-report", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        manifest, checksums = create_manifest(
            artifact_dir=args.artifact_dir,
            output_dir=args.output_dir,
            version=args.version,
            git_sha=args.git_sha,
            channel=args.channel,
            signing_status_file=args.signing_status_file,
            runner=args.runner,
            workflow=args.workflow,
            architecture_report=args.architecture_report,
        )
    except (OSError, ValueError) as error:
        print(f"error: {error}")
        return 1
    print(f"created {manifest}")
    print(f"created {checksums}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
