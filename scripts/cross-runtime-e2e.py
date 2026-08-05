#!/usr/bin/env python3
"""Exercise the real JSONL sidecar and record deterministic release evidence."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
PROTOCOL = "voxelweave.control.v1"


def request(
    process: subprocess.Popen[str], request_id: str, operation: str, payload: dict[str, Any]
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    envelope = {
        "protocol": PROTOCOL,
        "request_id": request_id,
        "operation": operation,
        "payload": payload,
    }
    assert process.stdin is not None and process.stdout is not None
    process.stdin.write(json.dumps(envelope, sort_keys=True, separators=(",", ":")) + "\n")
    process.stdin.flush()
    progress: list[dict[str, Any]] = []
    while True:
        line = process.stdout.readline()
        if not line:
            stderr = process.stderr.read() if process.stderr else ""
            raise RuntimeError(f"sidecar exited before response {request_id}; stderr={stderr!r}")
        value = json.loads(line)
        if value.get("protocol") == "voxelweave.progress.v1":
            assert value.get("request_id") == request_id, value
            progress.append(value)
            continue
        if (
            value.get("protocol") != "voxelweave.response.v1"
            or value.get("request_id") != request_id
        ):
            raise AssertionError(f"response correlation failure for {request_id}: {value}")
        return value, progress


def require_ok(response: dict[str, Any], request_id: str) -> dict[str, Any]:
    if not response.get("ok"):
        raise AssertionError(f"{request_id} failed: {response.get('error')}")
    return dict(response.get("payload") or {})


def calibration() -> list[dict[str, Any]]:
    return [
        {
            "calibration_id": "cross-runtime-t0",
            "binding": {
                "pitch_mm": 4.0,
                "layer_height_mm": 0.2,
                "nozzle_mm": 0.25,
                "tool": "T0",
                "material": "Natural PLA",
                "lot": "synthetic",
                "printer": "Prusa XL",
                "scanner": "synthetic CT",
                "reconstruction": "STANDARD / BONE",
                "flow_mm3_s": 1.0,
            },
            "commanded_width_mm": [0.48, 0.62, 0.82, 1.02],
            "measured_hu_mean": [-872, -824, -742, -680],
            "accepted": True,
        }
    ]


def run(output_dir: Path, sidecar: Path | None) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    if any(output_dir.iterdir()):
        raise RuntimeError(f"output directory is not empty: {output_dir}")
    project = {
        "schemaVersion": 1,
        "projectId": "cross-runtime-synthetic",
        "name": "Cross-runtime synthetic fixture",
        "source": {"kind": "synthetic", "uri": "synthetic://voxelweave/lung-phantom"},
        "scientificBoundary": "software evidence does not establish deposited width or HU fidelity",
    }
    document_path = output_dir / "cross-runtime.voxelweave"
    document_path.write_text(json.dumps(project, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    reopened = json.loads(document_path.read_text(encoding="utf-8"))
    if reopened != project:
        raise AssertionError(".voxelweave create/open round-trip changed the document")

    if sidecar is None:
        python_bin = os.environ.get("VOXELWEAVE_PYTHON_BIN")
        if not python_bin:
            candidate = ROOT / "engine" / ".venv" / "bin" / "python"
            python_bin = str(candidate) if candidate.is_file() else sys.executable
        command = [python_bin, "-m", "voxelweave.sidecar"]
    else:
        command = [str(sidecar)]
    environment = os.environ.copy()
    environment["PYTHONUNBUFFERED"] = "1"
    source_path = str(ROOT / "engine" / "src")
    environment["PYTHONPATH"] = source_path + os.pathsep + environment.get("PYTHONPATH", "")
    process = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=environment,
    )
    try:
        scene, scene_progress = request(
            process,
            "cross-scene",
            "validate_scene",
            {"scene": {"regions": [{"id": "lung", "kind": "box", "owner": "T0:measurement", "region": "measurement", "tool": "T0", "target_hu": 0, "geometry": {"kind": "box", "dimensions": [2, 3, 4]}}]}},
        )
        if not require_ok(scene, "cross-scene").get("passed") or scene_progress:
            raise AssertionError("scene validation did not return the expected bounded response")

        inspection, inspection_progress = request(
            process,
            "cross-inspect",
            "inspect_dicom_source",
            {"source": "synthetic://voxelweave/lung-phantom"},
        )
        inspection_payload = require_ok(inspection, "cross-inspect")
        if not inspection_progress or not inspection_payload.get("series"):
            raise AssertionError("synthetic inspection did not emit progress and series metadata")

        selection_response, _ = request(
            process,
            "cross-select",
            "select_dicom_series",
            {"source": "synthetic://voxelweave/lung-phantom"},
        )
        selected_series = require_ok(selection_response, "cross-select")
        selected_series_uid = str(selected_series.get("series_uid", ""))
        cache_response, cache_progress = request(
            process,
            "cross-cache",
            "build_volume_cache",
            {"directory": str(output_dir / "cache")},
        )
        cache_payload = require_ok(cache_response, "cross-cache")
        if not cache_progress or not cache_payload.get("scientific_source"):
            raise AssertionError("cache response did not retain the scientific artifact reference")

        selection_response, _ = request(
            process,
            "cross-selection",
            "create_print_selection",
            {
                "source": "synthetic://voxelweave/lung-phantom",
                "series_uid": selected_series_uid,
                "plane": "axial",
                "mode": "continuous",
                "start_index": 1,
                "end_index": 8,
                "print_size_mm": [24, 24, 8],
                "layer_height_mm": 0.2,
                "stride": 1,
                "resampling": "trilinear",
                "structural_regions": [{"id": "lung", "owner": "T0:measurement"}],
            },
        )
        require_ok(selection_response, "cross-selection")

        generated_response, generated_progress = request(
            process,
            "cross-generate",
            "generate_toolpath",
            {
                "calibration": calibration(),
                "tool": "T0",
                "allow_calibration_clipping": True,
                "acknowledge_calibration_clipping": True,
                "profile": {"printer": "Prusa XL", "sample_step_mm": 2.0},
            },
        )
        generated = require_ok(generated_response, "cross-generate")
        if not generated_progress or not generated.get("gcode_sha256"):
            raise AssertionError("toolpath generation did not emit progress and a G-code hash")
        gcode_hash_before_preview = str(generated["gcode_sha256"])

        audit_response, _ = request(process, "cross-audit", "reverse_audit_gcode", {})
        audit = require_ok(audit_response, "cross-audit")
        if not audit.get("passed"):
            raise AssertionError(f"reverse audit failed: {audit}")

        preview_hashes: list[str] = []
        for index, max_dimension in enumerate((4, 8), start=1):
            preview_response, _ = request(
                process,
                f"cross-preview-{index}",
                "request_volume_preview",
                {"max_dimension": max_dimension, "output_path": f"preview-{max_dimension}.bin"},
            )
            preview = require_ok(preview_response, f"cross-preview-{index}")
            artifact = preview.get("artifact", {})
            preview_hashes.append(str(artifact.get("sha256", "missing")))
            if preview.get("preview", {}).get("max_dimension") != max_dimension:
                raise AssertionError("preview response did not record its requested resolution")

        generated_after_preview_response, _ = request(
            process,
            "cross-generate-after-preview",
            "generate_toolpath",
            {
                "calibration": calibration(),
                "tool": "T0",
                "allow_calibration_clipping": True,
                "acknowledge_calibration_clipping": True,
                "profile": {"printer": "Prusa XL", "sample_step_mm": 2.0},
            },
        )
        generated_after_preview = require_ok(
            generated_after_preview_response, "cross-generate-after-preview"
        )
        if generated_after_preview.get("gcode_sha256") != gcode_hash_before_preview:
            raise AssertionError("changing preview resolution changed the scientific G-code hash")

        package_one_response, _ = request(
            process,
            "cross-package-one",
            "export_run_package",
            {"directory": str(output_dir / "package-one")},
        )
        package_one = require_ok(package_one_response, "cross-package-one")
        package_two_response, _ = request(
            process,
            "cross-package-two",
            "export_run_package",
            {"directory": str(output_dir / "package-two")},
        )
        package_two = require_ok(package_two_response, "cross-package-two")
        if package_one.get("hashes") != package_two.get("hashes"):
            raise AssertionError("repeat package generation changed artifact hashes")
        if not package_one.get("package_name", "").endswith(".zip") or not package_one.get(
            "package_path"
        ):
            raise AssertionError("run package did not return a deterministic ZIP artifact")

        error_response, _ = request(
            process,
            "cross-error",
            "inspect_dicom_source",
            {"source": str(output_dir / "does-not-exist")},
        )
        if (
            error_response.get("ok") is not False
            or error_response.get("request_id") != "cross-error"
        ):
            raise AssertionError(f"error response lost request correlation: {error_response}")
        error_code = error_response.get("error", {}).get("code")
        if error_code != "DicomValidationError":
            raise AssertionError(f"unexpected sidecar error code: {error_code}")

        summary = {
            "schemaVersion": "voxelweave.cross-runtime-e2e.v1",
            "document": document_path.name,
            "sidecar": "bundled" if sidecar else "python-module",
            "requestCorrelation": "passed",
            "errorHandling": "passed",
            "gcodeSha256": gcode_hash_before_preview,
            "previewArtifactSha256": preview_hashes,
            "previewResolutionDoesNotChangeGcode": True,
            "packageHashes": package_one.get("hashes", {}),
            "physicalFidelityClaim": "not_established_by_software",
        }
        (output_dir / "cross-runtime-summary.json").write_text(
            json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        return summary
    finally:
        if process.stdin:
            process.stdin.close()
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sidecar", type=Path)
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()
    if args.output_dir:
        output_dir = args.output_dir.resolve()
        summary = run(output_dir, args.sidecar.resolve() if args.sidecar else None)
    else:
        with TemporaryDirectory(prefix="voxelweave-cross-runtime-") as directory:
            summary = run(Path(directory), args.sidecar.resolve() if args.sidecar else None)
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
