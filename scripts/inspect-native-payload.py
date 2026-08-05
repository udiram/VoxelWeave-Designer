#!/usr/bin/env python3
"""Inspect native files hidden inside a PyInstaller one-file executable.

PyInstaller one-file builds place their Python runtime and native extensions in
an appended CArchive.  A normal recursive ``file`` scan only sees the
bootloader executable, so this helper parses the CArchive TOC and writes each
entry into a temporary directory before asking macOS ``file`` and ``lipo`` to
inspect Mach-O entries.  The archive is never executed and all extraction is
confined to the temporary directory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mmap
import os
import platform
import re
import struct
import subprocess
import sys
import tempfile
import zlib
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any


COOKIE_MAGIC = b"MEI\014\013\012\013\016"
COOKIE_FORMAT = "!8sIIII64s"
COOKIE_LENGTH = struct.calcsize(COOKIE_FORMAT)
TOC_HEADER_FORMAT = "!IIIIBc"
TOC_HEADER_LENGTH = struct.calcsize(TOC_HEADER_FORMAT)
MAX_TOC_BYTES = 64 * 1024 * 1024
DEFAULT_MAX_ENTRY_BYTES = 512 * 1024 * 1024


class PayloadInspectionError(RuntimeError):
    """Raised when the appended PyInstaller archive is malformed or unsafe."""


@dataclass(frozen=True)
class ArchiveEntry:
    name: str
    offset: int
    length: int
    uncompressed_length: int
    compressed: bool
    typecode: str


def _safe_member_label(name: str, index: int) -> str:
    """Return a flat, non-escaping filename for a temporary extraction."""

    basename = PurePosixPath(name).name or "entry"
    basename = re.sub(r"[^A-Za-z0-9._-]", "_", basename)[:120] or "entry"
    digest = hashlib.sha256(name.encode("utf-8")).hexdigest()[:12]
    return f"{index:06d}-{digest}-{basename}"


def _archive_entries(path: Path, max_entry_bytes: int) -> tuple[mmap.mmap, Any, list[ArchiveEntry]]:
    """Map *path* read-only and parse its CArchive table of contents."""

    if not path.is_file():
        raise PayloadInspectionError(f"payload does not exist or is not a file: {path}")
    if path.stat().st_size < COOKIE_LENGTH:
        raise PayloadInspectionError(f"payload is too small to contain a PyInstaller CArchive: {path}")

    handle = path.open("rb")
    try:
        mapped = mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ)
    except Exception:
        handle.close()
        raise

    cookie_start = mapped.rfind(COOKIE_MAGIC)
    if cookie_start < 0:
        mapped.close()
        handle.close()
        raise PayloadInspectionError(f"PyInstaller CArchive cookie not found in {path}")
    if cookie_start + COOKIE_LENGTH > len(mapped):
        mapped.close()
        handle.close()
        raise PayloadInspectionError("PyInstaller CArchive cookie is truncated")

    _magic, archive_length, toc_offset, toc_length, _python_version, _python_library = struct.unpack(
        COOKIE_FORMAT, mapped[cookie_start : cookie_start + COOKIE_LENGTH]
    )
    archive_end = cookie_start + COOKIE_LENGTH
    archive_start = archive_end - archive_length
    if archive_length <= COOKIE_LENGTH or archive_start < 0 or archive_end > len(mapped):
        mapped.close()
        handle.close()
        raise PayloadInspectionError("PyInstaller CArchive bounds are invalid")
    if toc_length <= 0 or toc_length > MAX_TOC_BYTES:
        mapped.close()
        handle.close()
        raise PayloadInspectionError(f"PyInstaller CArchive TOC length is unsafe: {toc_length}")
    toc_start = archive_start + toc_offset
    toc_end = toc_start + toc_length
    if toc_start < archive_start or toc_end > archive_end:
        mapped.close()
        handle.close()
        raise PayloadInspectionError("PyInstaller CArchive TOC lies outside the archive")

    toc = mapped[toc_start:toc_end]
    cursor = 0
    entries: list[ArchiveEntry] = []
    while cursor < len(toc):
        if len(toc) - cursor < TOC_HEADER_LENGTH:
            mapped.close()
            handle.close()
            raise PayloadInspectionError("PyInstaller CArchive TOC has a truncated entry header")
        entry_length, entry_offset, data_length, uncompressed_length, compression_flag, typecode = struct.unpack(
            TOC_HEADER_FORMAT, toc[cursor : cursor + TOC_HEADER_LENGTH]
        )
        if entry_length < TOC_HEADER_LENGTH or cursor + entry_length > len(toc):
            mapped.close()
            handle.close()
            raise PayloadInspectionError("PyInstaller CArchive TOC entry length is invalid")
        name_bytes = toc[cursor + TOC_HEADER_LENGTH : cursor + entry_length].rstrip(b"\0")
        try:
            name = name_bytes.decode("utf-8")
        except UnicodeDecodeError as error:
            mapped.close()
            handle.close()
            raise PayloadInspectionError("PyInstaller CArchive contains a non-UTF-8 entry name") from error
        if not name:
            mapped.close()
            handle.close()
            raise PayloadInspectionError("PyInstaller CArchive contains an empty entry name")
        if data_length > max_entry_bytes or uncompressed_length > max_entry_bytes:
            mapped.close()
            handle.close()
            raise PayloadInspectionError(f"PyInstaller CArchive entry is too large: {name}")
        data_start = archive_start + entry_offset
        data_end = data_start + data_length
        if data_start < archive_start or data_end > archive_end:
            mapped.close()
            handle.close()
            raise PayloadInspectionError(f"PyInstaller CArchive entry lies outside the archive: {name}")
        entries.append(
            ArchiveEntry(
                name=name,
                offset=entry_offset,
                length=data_length,
                uncompressed_length=uncompressed_length,
                compressed=bool(compression_flag),
                typecode=typecode.decode("ascii", errors="replace"),
            )
        )
        cursor += entry_length

    # Keep the file descriptor alive for the lifetime of the mapping.  mmap on
    # macOS remains valid after close in practice, but retaining it avoids
    # relying on that implementation detail and gives callers one owner.
    return mapped, handle, entries


def _entry_bytes(mapped: mmap.mmap, entry: ArchiveEntry, archive_start: int, max_entry_bytes: int) -> bytes:
    raw = mapped[archive_start + entry.offset : archive_start + entry.offset + entry.length]
    if entry.compressed:
        try:
            data = zlib.decompress(raw)
        except zlib.error as error:
            raise PayloadInspectionError(f"cannot decompress PyInstaller entry {entry.name}: {error}") from error
    else:
        data = bytes(raw)
    if len(data) != entry.uncompressed_length:
        raise PayloadInspectionError(
            f"PyInstaller entry {entry.name} length mismatch: expected {entry.uncompressed_length}, got {len(data)}"
        )
    if len(data) > max_entry_bytes:
        raise PayloadInspectionError(f"PyInstaller entry {entry.name} exceeds extraction limit")
    return data


def _command_path(environment_name: str, default: str) -> str:
    value = os.environ.get(environment_name, default)
    if os.path.sep in value:
        candidate = Path(value)
        if not candidate.is_file() or not os.access(candidate, os.X_OK):
            raise PayloadInspectionError(f"{environment_name} is not an executable file: {value}")
        return str(candidate)
    return value


def _run(command: list[str]) -> str:
    try:
        completed = subprocess.run(command, check=False, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise PayloadInspectionError(f"command failed to run: {' '.join(command)}: {error}") from error
    if completed.returncode != 0:
        raise PayloadInspectionError(
            f"command failed ({completed.returncode}): {' '.join(command)}: {completed.stderr.strip()}"
        )
    return completed.stdout.strip()


def inspect_payload(path: Path, *, max_entry_bytes: int = DEFAULT_MAX_ENTRY_BYTES) -> dict[str, Any]:
    if platform.system() != "Darwin" and os.environ.get("VOXELWEAVE_ALLOW_NON_MACOS") != "1":
        raise PayloadInspectionError("PyInstaller native payload inspection requires macOS; set VOXELWEAVE_ALLOW_NON_MACOS=1 only for controlled fixtures")

    file_bin = _command_path("VOXELWEAVE_ARCH_FILE_BIN", "file")
    lipo_bin = _command_path("VOXELWEAVE_ARCH_LIPO_BIN", "lipo")
    outer_description = _run([file_bin, "-Lb", str(path)])
    if "Mach-O" not in outer_description:
        raise PayloadInspectionError(f"PyInstaller payload is not a Mach-O executable: {outer_description}")
    outer_architectures = _run([lipo_bin, "-archs", str(path)])

    mapped, file_handle, entries = _archive_entries(path, max_entry_bytes)
    # Derive archive_start again from the cookie so extraction remains tied to
    # the mapped file and does not copy the complete one-file executable.
    cookie_start = mapped.rfind(COOKIE_MAGIC)
    archive_end = cookie_start + COOKIE_LENGTH
    _magic, archive_length, *_ = struct.unpack(COOKIE_FORMAT, mapped[cookie_start:archive_end])
    archive_start = archive_end - archive_length

    inspected: list[dict[str, Any]] = []
    failures: list[str] = []
    if outer_architectures != "arm64":
        failures.append(f"outer executable: architectures={outer_architectures or 'unreadable'} (expected exactly arm64)")
    macho_count = 0
    try:
        with tempfile.TemporaryDirectory(prefix="voxelweave-pyi-inspect-") as extraction_root:
            root = Path(extraction_root)
            for index, entry in enumerate(entries):
                # Runtime options and the embedded PYZ bytecode archive are not
                # native files, but extracting them as bytes is harmless and
                # keeps the parser's coverage complete.
                extracted = root / _safe_member_label(entry.name, index)
                extracted.write_bytes(_entry_bytes(mapped, entry, archive_start, max_entry_bytes))
                description = _run([file_bin, "-Lb", str(extracted)])
                if "Mach-O" not in description:
                    continue
                macho_count += 1
                architectures = _run([lipo_bin, "-archs", str(extracted)])
                record = {
                    "name": entry.name,
                    "typecode": entry.typecode,
                    "description": description,
                    "architectures": architectures,
                }
                inspected.append(record)
                if architectures != "arm64":
                    failures.append(f"{entry.name}: architectures={architectures or 'unreadable'} (expected exactly arm64)")
    finally:
        mapped.close()
        file_handle.close()

    if macho_count == 0:
        failures.append("no Mach-O entries were found inside the PyInstaller payload")

    return {
        "schemaVersion": "voxelweave.native-payload-architecture.v1",
        "payload": path.name,
        "outerDescription": outer_description,
        "outerArchitectures": outer_architectures,
        "entryCount": len(entries),
        "machOCount": macho_count,
        "nativeEntries": inspected,
        "status": "failed" if failures else "passed",
        "failures": failures,
    }


def _write_report(path: Path | None, report: dict[str, Any]) -> None:
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sidecar", type=Path, required=True, help="PyInstaller one-file executable to inspect")
    parser.add_argument("--report", type=Path, help="write a JSON evidence report at this path")
    parser.add_argument(
        "--max-entry-bytes",
        type=int,
        default=DEFAULT_MAX_ENTRY_BYTES,
        help=f"maximum decompressed archive entry size (default: {DEFAULT_MAX_ENTRY_BYTES})",
    )
    args = parser.parse_args()
    if args.max_entry_bytes <= 0:
        parser.error("--max-entry-bytes must be positive")

    report: dict[str, Any] = {
        "schemaVersion": "voxelweave.native-payload-architecture.v1",
        "payload": args.sidecar.name,
        "status": "failed",
        "failures": [],
    }
    try:
        report = inspect_payload(args.sidecar.resolve(), max_entry_bytes=args.max_entry_bytes)
    except PayloadInspectionError as error:
        report["failures"] = [str(error)]
    except Exception as error:  # pragma: no cover - fail closed for unexpected parser errors
        report["failures"] = [f"unexpected payload inspection error: {type(error).__name__}: {error}"]

    _write_report(args.report, report)
    if report.get("status") == "passed":
        print(
            f"[native-payload] PASS {args.sidecar} :: outer={report['outerArchitectures']} entries={report['entryCount']} Mach-O={report['machOCount']} target=arm64"
        )
        for entry in report.get("nativeEntries", []):
            print(f"PASS {entry['name']} :: architectures={entry['architectures']}")
        return 0

    print(f"[native-payload] FAIL {args.sidecar}", file=sys.stderr)
    for failure in report.get("failures", []):
        print(f"FAIL {failure}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
