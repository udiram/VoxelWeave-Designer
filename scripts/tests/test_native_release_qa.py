from __future__ import annotations

import importlib.util
import os
import stat
import struct
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


payload = _load("inspect_native_payload", ROOT / "scripts" / "inspect-native-payload.py")
benchmark = _load("benchmark_sidecar", ROOT / "scripts" / "benchmark-sidecar.py")


def _write_executable(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def _write_carchive(path: Path, names: list[str]) -> None:
    data = bytearray()
    toc = bytearray()
    header_length = struct.calcsize("!IIIIBc")
    for name in names:
        entry_data = name.encode("utf-8")
        offset = len(data)
        data.extend(entry_data)
        padded_length = ((len(name.encode("utf-8")) + 15) // 16) * 16
        name_field = name.encode("utf-8") + (b"\0" * (padded_length - len(name.encode("utf-8"))))
        toc.extend(struct.pack("!IIIIBc", header_length + len(name_field), offset, len(entry_data), len(entry_data), 0, b"b"))
        toc.extend(name_field)
    toc_offset = len(data)
    cookie = struct.pack(
        "!8sIIII64s",
        payload.COOKIE_MAGIC,
        len(data) + len(toc) + payload.COOKIE_LENGTH,
        toc_offset,
        len(toc),
        312,
        b"libpython3.12.dylib\0",
    )
    path.write_bytes(bytes(data) + bytes(toc) + cookie)


class NativeReleaseQATests(unittest.TestCase):
    def test_percentile_and_budget_gate_are_deterministic(self) -> None:
        self.assertEqual(benchmark.percentile([4, 1, 2, 3], 0.5), 2.0)
        summaries, failures = benchmark._summaries(
            {"uncached_mpr_elapsed_ms": [20.0, 30.0, 40.0]},
            {"metrics": {"uncached_mpr_elapsed_ms": {"target_ms": 100, "gate_ms": 35}}},
        )
        self.assertFalse(summaries["uncached_mpr_elapsed_ms"]["targetMet"] is False)
        self.assertFalse(summaries["uncached_mpr_elapsed_ms"]["gatePassed"])
        self.assertEqual(len(failures), 1)

    def test_payload_parser_extracts_arm64_and_rejects_x86_payload(self) -> None:
        with tempfile.TemporaryDirectory(prefix="voxelweave-native-payload-test-") as directory:
            root = Path(directory)
            file_double = root / "file"
            lipo_double = root / "lipo"
            _write_executable(
                file_double,
                """#!/usr/bin/env bash
candidate="${@: -1}"
case "$(basename "$candidate")" in
  *sidecar) echo 'Mach-O 64-bit executable arm64' ;;
  *x86_64.dylib) echo 'Mach-O 64-bit dynamically linked shared library x86_64' ;;
  *universal.dylib) echo 'Mach-O universal binary' ;;
  *) echo 'Mach-O 64-bit dynamically linked shared library arm64' ;;
esac
""",
            )
            _write_executable(
                lipo_double,
                """#!/usr/bin/env bash
candidate="${@: -1}"
case "$(basename "$candidate")" in
  *x86_64.dylib) echo x86_64 ;;
  *universal.dylib) echo 'arm64 x86_64' ;;
  *) echo arm64 ;;
esac
""",
            )
            old_file = os.environ.get("VOXELWEAVE_ARCH_FILE_BIN")
            old_lipo = os.environ.get("VOXELWEAVE_ARCH_LIPO_BIN")
            old_allow = os.environ.get("VOXELWEAVE_ALLOW_NON_MACOS")
            os.environ["VOXELWEAVE_ARCH_FILE_BIN"] = str(file_double)
            os.environ["VOXELWEAVE_ARCH_LIPO_BIN"] = str(lipo_double)
            os.environ["VOXELWEAVE_ALLOW_NON_MACOS"] = "1"
            try:
                arm_payload = root / "arm-sidecar"
                _write_carchive(arm_payload, ["numpy/arm64.dylib"])
                arm_report = payload.inspect_payload(arm_payload)
                self.assertEqual(arm_report["status"], "passed")
                self.assertEqual(arm_report["machOCount"], 1)

                rejected_payload = root / "x86-sidecar"
                _write_carchive(rejected_payload, ["numpy/x86_64.dylib"])
                rejected_report = payload.inspect_payload(rejected_payload)
                self.assertEqual(rejected_report["status"], "failed")
                self.assertIn("x86_64", " ".join(rejected_report["failures"]))
            finally:
                for name, value in (
                    ("VOXELWEAVE_ARCH_FILE_BIN", old_file),
                    ("VOXELWEAVE_ARCH_LIPO_BIN", old_lipo),
                    ("VOXELWEAVE_ALLOW_NON_MACOS", old_allow),
                ):
                    if value is None:
                        os.environ.pop(name, None)
                    else:
                        os.environ[name] = value


if __name__ == "__main__":
    unittest.main()
