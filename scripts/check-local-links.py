#!/usr/bin/env python3
"""Check relative Markdown links without making network requests."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from urllib.parse import unquote

LINK_RE = re.compile(r"(?<!!)(?:\[[^\]]*\])\(\s*(?:<([^>]+)>|([^\s)]+))")


def markdown_files(root: Path) -> list[Path]:
    candidates = [root / "README.md", root / "CONTRIBUTING.md", root / "SECURITY.md"]
    candidates.extend(sorted((root / "docs").rglob("*.md")) if (root / "docs").exists() else [])
    return [path for path in candidates if path.is_file()]


def is_external(target: str) -> bool:
    lowered = target.lower()
    return (
        lowered.startswith(("http://", "https://", "mailto:", "tel:", "data:", "javascript:"))
        or target.startswith("#")
    )


def check_file(path: Path, root: Path) -> list[str]:
    errors: list[str] = []
    text = path.read_text(encoding="utf-8")
    for match in LINK_RE.finditer(text):
        target = unquote(match.group(1) or match.group(2) or "")
        target = target.split("#", 1)[0].split("?", 1)[0]
        if not target or is_external(target):
            continue
        resolved = (path.parent / target).resolve()
        try:
            resolved.relative_to(root.resolve())
        except ValueError:
            errors.append(f"{path}: link escapes repository: {target}")
            continue
        if not resolved.exists():
            errors.append(f"{path}: broken local link: {target}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    args = parser.parse_args()
    root = args.root.resolve()
    files = markdown_files(root)
    errors = [error for path in files for error in check_file(path, root)]
    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        return 1
    print(f"local Markdown links valid: {len(files)} files checked; network links skipped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
