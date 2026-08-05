#!/usr/bin/env python3
"""Verify a VoxelWeave release evidence manifest and its release assets."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "voxelweave.release-evidence.v1"
HEX64 = re.compile(r"^[0-9a-f]{64}$")
GIT_SHA = re.compile(r"^[0-9a-fA-F]{7,64}$")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def schema_type_matches(value: Any, expected: str) -> bool:
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    return True


def validate_schema_subset(value: Any, schema: dict[str, Any], location: str, errors: list[str]) -> None:
    """Validate the JSON-schema keywords used by release-evidence.schema.json.

    The verifier deliberately has no third-party runtime dependency. This
    small subset covers the schema's structural, const, enum, path, digest,
    count, and additional-property constraints.
    """
    expected_type = schema.get("type")
    if isinstance(expected_type, str) and not schema_type_matches(value, expected_type):
        errors.append(f"{location} must be a {expected_type}")
        return
    if "const" in schema and value != schema["const"]:
        errors.append(f"{location} must equal {schema['const']!r}")
    allowed = schema.get("enum")
    if isinstance(allowed, list) and value not in allowed:
        errors.append(f"{location} must be one of {allowed!r}")
    if isinstance(value, str):
        minimum_length = schema.get("minLength")
        if isinstance(minimum_length, int) and len(value) < minimum_length:
            errors.append(f"{location} is shorter than the schema minimum")
        pattern = schema.get("pattern")
        if isinstance(pattern, str) and re.fullmatch(pattern, value) is None:
            errors.append(f"{location} does not match the schema pattern")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        minimum = schema.get("minimum")
        if isinstance(minimum, (int, float)) and value < minimum:
            errors.append(f"{location} is below the schema minimum")
    if isinstance(value, list):
        minimum_items = schema.get("minItems")
        if isinstance(minimum_items, int) and len(value) < minimum_items:
            errors.append(f"{location} contains too few items")
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for index, item in enumerate(value):
                validate_schema_subset(item, item_schema, f"{location}[{index}]", errors)
    if isinstance(value, dict):
        properties = schema.get("properties", {})
        if not isinstance(properties, dict):
            properties = {}
        required = schema.get("required", [])
        if isinstance(required, list):
            for key in required:
                if key not in value:
                    errors.append(f"{location}.{key} is required by the schema")
        if schema.get("additionalProperties") is False:
            for key in value:
                if key not in properties:
                    errors.append(f"{location}.{key} is not allowed by the schema")
        for key, child_schema in properties.items():
            if key in value and isinstance(child_schema, dict):
                validate_schema_subset(value[key], child_schema, f"{location}.{key}", errors)


def is_relative_safe(value: str) -> bool:
    path = Path(value)
    return not path.is_absolute() and ".." not in path.parts and value not in {"", "."}


def check_required(mapping: Any, keys: tuple[str, ...], location: str, errors: list[str]) -> None:
    if not isinstance(mapping, dict):
        errors.append(f"{location} must be an object")
        return
    for key in keys:
        if key not in mapping:
            errors.append(f"{location}.{key} is required")


def check_enum(value: Any, allowed: tuple[str, ...], location: str, errors: list[str]) -> None:
    if value not in allowed:
        errors.append(f"{location} must be one of {', '.join(allowed)}")


def verify_checksums_file(
    checksum_path: Path,
    artifacts: list[dict[str, Any]],
    errors: list[str],
) -> None:
    try:
        lines = checksum_path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        errors.append(f"cannot read checksum file {checksum_path}: {error}")
        return
    expected = {artifact.get("name"): artifact.get("sha256") for artifact in artifacts}
    observed: dict[str, str] = {}
    for line in lines:
        parts = line.split(maxsplit=1)
        if len(parts) != 2:
            errors.append(f"invalid checksum line: {line!r}")
            continue
        digest, name = parts
        name = name[1:] if name.startswith("*") else name
        observed[name] = digest
        if not HEX64.fullmatch(digest):
            errors.append(f"checksum for {name} is not a lowercase SHA-256 digest")
    if observed != expected:
        errors.append("SHA256SUMS does not exactly match the manifest artifacts")


def verify_manifest(schema_path: Path, manifest_path: Path, artifact_root: Path) -> list[str]:
    errors: list[str] = []
    try:
        schema = load_json(schema_path)
    except (OSError, json.JSONDecodeError) as error:
        return [f"cannot load schema: {error}"]
    if not isinstance(schema, dict) or schema.get("$id") != "urn:voxelweave:release-evidence:v1":
        errors.append("schema is not the VoxelWeave release-evidence.v1 schema")

    try:
        manifest = load_json(manifest_path)
    except (OSError, json.JSONDecodeError) as error:
        return [f"cannot load manifest: {error}"]
    if not isinstance(manifest, dict):
        return ["manifest must contain a JSON object"]

    validate_schema_subset(manifest, schema if isinstance(schema, dict) else {}, "manifest", errors)

    check_required(
        manifest,
        ("schemaVersion", "release", "target", "artifacts", "checksums", "verification", "signing"),
        "manifest",
        errors,
    )
    if manifest.get("schemaVersion") != SCHEMA_VERSION:
        errors.append(f"manifest.schemaVersion must be {SCHEMA_VERSION}")

    release = manifest.get("release")
    check_required(release, ("version", "gitSha", "channel", "generatedAt", "workflow"), "release", errors)
    if isinstance(release, dict):
        if not isinstance(release.get("version"), str) or not release.get("version"):
            errors.append("release.version must be a non-empty string")
        if not isinstance(release.get("gitSha"), str) or not GIT_SHA.fullmatch(release.get("gitSha", "")):
            errors.append("release.gitSha must contain 7-64 hexadecimal characters")
        check_enum(release.get("channel"), ("stable", "development-prerelease"), "release.channel", errors)
        if not isinstance(release.get("generatedAt"), str) or "T" not in release.get("generatedAt", ""):
            errors.append("release.generatedAt must be an ISO date-time string")
        if not isinstance(release.get("workflow"), str) or not release.get("workflow"):
            errors.append("release.workflow must be a non-empty string")

    target = manifest.get("target")
    check_required(
        target,
        ("platform", "minimumOS", "runner", "architecture", "rustTarget"),
        "target",
        errors,
    )
    if isinstance(target, dict):
        expected_target = {
            "platform": "macOS",
            "minimumOS": "14",
            "runner": "macos-14",
            "architecture": "arm64",
            "rustTarget": "aarch64-apple-darwin",
        }
        for key, expected in expected_target.items():
            if target.get(key) != expected:
                errors.append(f"target.{key} must be {expected}")

    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list) or len(artifacts) < 2:
        errors.append("artifacts must contain at least one app zip and one DMG")
        artifacts = []
    artifact_root = artifact_root.resolve()
    names: set[str] = set()
    paths: set[str] = set()
    artifact_entries: list[dict[str, Any]] = []
    kinds: set[str] = set()
    for index, artifact in enumerate(artifacts):
        location = f"artifacts[{index}]"
        check_required(
            artifact,
            ("name", "path", "kind", "sizeBytes", "sha256", "architecture"),
            location,
            errors,
        )
        if not isinstance(artifact, dict):
            continue
        artifact_entries.append(artifact)
        name = artifact.get("name")
        relative = artifact.get("path")
        kind = artifact.get("kind")
        digest = artifact.get("sha256")
        if not isinstance(name, str) or not name or name in names:
            errors.append(f"{location}.name must be unique and non-empty")
        elif name not in names:
            names.add(name)
        if not isinstance(relative, str) or not is_relative_safe(relative) or relative in paths:
            errors.append(f"{location}.path must be a unique safe relative path")
        elif relative not in paths:
            paths.add(relative)
        if kind not in {"app-zip", "dmg"}:
            errors.append(f"{location}.kind must be app-zip or dmg")
        else:
            kinds.add(kind)
        if not isinstance(artifact.get("sizeBytes"), int) or artifact.get("sizeBytes", 0) < 1:
            errors.append(f"{location}.sizeBytes must be a positive integer")
        if not isinstance(digest, str) or not HEX64.fullmatch(digest):
            errors.append(f"{location}.sha256 must be a lowercase SHA-256 digest")
        if kind == "app-zip" and artifact.get("architecture") != "arm64":
            errors.append(f"{location}.architecture must be arm64 for an app zip")
        if kind == "dmg" and artifact.get("architecture") != "not_applicable":
            errors.append(f"{location}.architecture must be not_applicable for a DMG")
        if isinstance(relative, str) and is_relative_safe(relative):
            resolved = (artifact_root / relative).resolve()
            try:
                resolved.relative_to(artifact_root)
            except ValueError:
                errors.append(f"{location}.path escapes the artifact root")
                continue
            if not resolved.is_file():
                errors.append(f"artifact is missing: {resolved}")
            else:
                if resolved.stat().st_size != artifact.get("sizeBytes"):
                    errors.append(f"size mismatch for {relative}")
                if isinstance(digest, str) and HEX64.fullmatch(digest) and sha256_file(resolved) != digest:
                    errors.append(f"SHA-256 mismatch for {relative}")

    if "app-zip" not in kinds or "dmg" not in kinds:
        errors.append("artifacts must include both an app-zip and a dmg")

    checksums = manifest.get("checksums")
    check_required(checksums, ("algorithm", "file"), "checksums", errors)
    if isinstance(checksums, dict):
        if checksums.get("algorithm") != "SHA-256":
            errors.append("checksums.algorithm must be SHA-256")
        checksum_name = checksums.get("file")
        if checksum_name != "SHA256SUMS":
            errors.append("checksums.file must be SHA256SUMS")
        else:
            verify_checksums_file(artifact_root / checksum_name, artifact_entries, errors)

    verification = manifest.get("verification")
    check_required(verification, ("architecture", "checksums", "packaging"), "verification", errors)
    if isinstance(verification, dict):
        architecture = verification.get("architecture")
        check_required(
            architecture,
            ("status", "targetArchitecture", "rustTarget", "scope"),
            "verification.architecture",
            errors,
        )
        if isinstance(architecture, dict):
            if architecture.get("status") != "passed":
                errors.append("verification.architecture.status must be passed")
            if architecture.get("targetArchitecture") != "arm64":
                errors.append("verification.architecture.targetArchitecture must be arm64")
            if architecture.get("rustTarget") != "aarch64-apple-darwin":
                errors.append("verification.architecture.rustTarget must be aarch64-apple-darwin")
            report = architecture.get("report")
            report_digest = architecture.get("reportSha256")
            if report is not None or report_digest is not None:
                if not isinstance(report, str) or not is_relative_safe(report):
                    errors.append("verification.architecture.report must be a safe relative path")
                if not isinstance(report_digest, str) or not HEX64.fullmatch(report_digest):
                    errors.append("verification.architecture.reportSha256 must be a lowercase SHA-256 digest")
                if isinstance(report, str) and is_relative_safe(report):
                    report_path = (artifact_root / report).resolve()
                    try:
                        report_path.relative_to(artifact_root)
                    except ValueError:
                        errors.append("verification.architecture.report escapes the artifact root")
                    else:
                        if not report_path.is_file():
                            errors.append(f"architecture report is missing: {report_path}")
                        elif isinstance(report_digest, str) and HEX64.fullmatch(report_digest):
                            if sha256_file(report_path) != report_digest:
                                errors.append("SHA-256 mismatch for the architecture report")
        checksum_verification = verification.get("checksums")
        check_required(
            checksum_verification,
            ("status", "algorithm"),
            "verification.checksums",
            errors,
        )
        if isinstance(checksum_verification, dict) and (
            checksum_verification.get("status") != "passed"
            or checksum_verification.get("algorithm") != "SHA-256"
        ):
            errors.append("verification.checksums must report a passed SHA-256 check")
        packaging = verification.get("packaging")
        check_required(packaging, ("status", "appAndDmgBuilt"), "verification.packaging", errors)
        if isinstance(packaging, dict) and (
            packaging.get("status") != "passed" or packaging.get("appAndDmgBuilt") is not True
        ):
            errors.append("verification.packaging must report that the app and DMG were built")

    signing = manifest.get("signing")
    check_required(signing, ("status", "signed", "notarized", "notarizationStatus", "signatureType"), "signing", errors)
    channel = release.get("channel") if isinstance(release, dict) else None
    if isinstance(signing, dict):
        if not isinstance(signing.get("signed"), bool) or not isinstance(signing.get("notarized"), bool):
            errors.append("signing.signed and signing.notarized must be booleans")
        if channel == "stable":
            if signing.get("status") != "signed-and-notarized":
                errors.append("stable signing.status must be signed-and-notarized")
            if signing.get("signed") is not True or signing.get("notarized") is not True:
                errors.append("stable releases require signed=true and notarized=true")
            if signing.get("notarizationStatus") != "accepted":
                errors.append("stable releases require notarizationStatus=accepted")
            if signing.get("signatureType") != "developer-id":
                errors.append("stable releases require signatureType=developer-id")
        elif channel == "development-prerelease":
            if signing.get("status") != "development-prerelease-adhoc-sealed-not-notarized":
                errors.append("development-prerelease signing.status must be explicit")
            if signing.get("signed") is not True or signing.get("signatureType") != "ad-hoc":
                errors.append("development-prerelease releases require a verified ad-hoc bundle seal")
            if signing.get("notarized") is not False or signing.get("notarizationStatus") != "not-performed":
                errors.append("development-prerelease releases must not claim notarization")

    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--schema", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--artifact-root", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    errors = verify_manifest(args.schema, args.manifest, args.artifact_root)
    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        return 1
    manifest = load_json(args.manifest)
    print(
        "release evidence valid: "
        f"{manifest['release']['version']} / {manifest['release']['channel']} / "
        f"{len(manifest['artifacts'])} assets"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
