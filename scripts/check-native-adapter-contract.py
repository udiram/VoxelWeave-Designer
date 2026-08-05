#!/usr/bin/env python3
"""Validate the native desktop adapter's exact JSON envelope contract.

This is a source-level release check. It intentionally does not claim that a
native Tauri/WebKit run happened; the packaged native bridge is exercised by
the native smoke/cross-runtime jobs. Keeping the operation list mirrored here
prevents the TypeScript and Rust sides from silently drifting apart.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TS_PATH = ROOT / "apps" / "desktop" / "src" / "services" / "sidecarClient.ts"
RUST_PATH = ROOT / "apps" / "desktop" / "src-tauri" / "src" / "lib.rs"
SIDECAR_PATH = ROOT / "engine" / "src" / "voxelweave" / "sidecar.py"


def _quoted_values(block: str) -> list[str]:
    return re.findall(r'"([a-z][a-z0-9_]+)"', block)


def _extract_operations(source: str, language: str) -> list[str]:
    if language == "typescript":
        match = re.search(r"export type SidecarOperation\s*=\s*(.*?);", source, flags=re.S)
    else:
        match = re.search(r"let supported\s*=\s*\[(.*?)\];", source, flags=re.S)
    if not match:
        raise ValueError(f"could not locate {language} operation declaration")
    values = _quoted_values(match.group(1))
    if not values:
        raise ValueError(f"{language} operation declaration is empty")
    return values


def validate_contract(
    ts_path: Path = TS_PATH,
    rust_path: Path = RUST_PATH,
    sidecar_path: Path = SIDECAR_PATH,
) -> dict[str, object]:
    ts = ts_path.read_text(encoding="utf-8")
    rust = rust_path.read_text(encoding="utf-8")
    sidecar = sidecar_path.read_text(encoding="utf-8")
    ts_operations = _extract_operations(ts, "typescript")
    rust_operations = _extract_operations(rust, "rust")
    ts_set = set(ts_operations)
    rust_set = set(rust_operations)
    failures: list[str] = []
    if len(ts_operations) != len(ts_set):
        failures.append("TypeScript SidecarOperation contains duplicate values")
    if len(rust_operations) != len(rust_set):
        failures.append("Rust supported operation list contains duplicate values")
    if ts_set - rust_set:
        failures.append(f"Rust is missing TypeScript operations: {sorted(ts_set - rust_set)}")
    if rust_set - ts_set:
        failures.append(f"TypeScript is missing Rust operations: {sorted(rust_set - ts_set)}")
    required_ts = {
        'protocol: "voxelweave.control.v1"',
        'request_id: string',
        'payload: Record<string, unknown>',
        '"sidecar_request"',
        '"voxelweave.response.v1"',
    }
    missing_ts = sorted(token for token in required_ts if token not in ts)
    if missing_ts:
        failures.append(f"TypeScript envelope contract is missing: {missing_ts}")
    required_rust = [
        '"voxelweave.control.v1"',
        '"request_id"',
        '"operation"',
        '"payload"',
    ]
    missing_rust = sorted(token for token in required_rust if token not in rust)
    if missing_rust:
        failures.append(f"Rust envelope contract is missing: {missing_rust}")
    if '"protocol": "voxelweave.response.v1"' not in sidecar:
        failures.append("sidecar response envelope does not declare voxelweave.response.v1")
    return {
        "schemaVersion": "voxelweave.native-adapter-contract.v1",
        "status": "failed" if failures else "passed",
        "typescriptPath": str(ts_path.relative_to(ROOT)),
        "rustPath": str(rust_path.relative_to(ROOT)),
        "sidecarPath": str(sidecar_path.relative_to(ROOT)),
        "typescriptOperations": ts_operations,
        "rustOperations": rust_operations,
        "operationCount": len(ts_operations),
        "failures": failures,
        "limitations": [
            "Source-level contract evidence is not a native WebKit execution trace.",
            "Payload value semantics remain covered by cross-runtime sidecar smoke and native app smoke.",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, help="write the JSON report to this path")
    args = parser.parse_args()
    try:
        report = validate_contract()
    except (OSError, ValueError) as error:
        print(f"native adapter contract check failed: {error}", file=sys.stderr)
        return 1
    rendered = json.dumps(report, indent=2, sort_keys=True)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(f"{rendered}\n", encoding="utf-8")
    print(rendered)
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
