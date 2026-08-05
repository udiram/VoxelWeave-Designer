#!/usr/bin/env python3
"""Parse GitHub Actions YAML and enforce the release platform boundary."""

from __future__ import annotations

import sys
from pathlib import Path


def main() -> int:
    workflow_root = Path(__file__).resolve().parents[1] / ".github" / "workflows"
    workflow_files = sorted(workflow_root.glob("*.yml")) + sorted(workflow_root.glob("*.yaml"))
    if not workflow_files:
        print("error: no workflow YAML files found", file=sys.stderr)
        return 1

    try:
        import yaml  # type: ignore[import-not-found]
    except ImportError:
        print(
            "workflow YAML structural parse skipped: PyYAML is not installed; "
            "install PyYAML or run actionlint in CI",
            file=sys.stderr,
        )
        return 0

    failures = 0
    for path in workflow_files:
        try:
            with path.open(encoding="utf-8") as handle:
                document = yaml.safe_load(handle)
        except (OSError, yaml.YAMLError) as error:
            print(f"error: {path}: invalid YAML: {error}", file=sys.stderr)
            failures += 1
            continue
        if not isinstance(document, dict) or "jobs" not in document:
            print(f"error: {path}: top-level jobs mapping is required", file=sys.stderr)
            failures += 1
            continue
        if path.name == "release.yml":
            text = path.read_text(encoding="utf-8")
            if "runs-on: macos-14" not in text:
                print("error: release.yml must run on macos-14", file=sys.stderr)
                failures += 1
            if "aarch64-apple-darwin" not in text:
                print("error: release.yml must target aarch64-apple-darwin", file=sys.stderr)
                failures += 1
    if failures:
        return 1
    print(f"workflow YAML valid: {len(workflow_files)} files parsed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
