"""Scan-back comparison with explicit registration and non-clinical boundaries."""

from __future__ import annotations

import hashlib
import json
import math
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

import numpy as np

from .dicom import Volume
from .errors import GeometryValidationError
from .models import canonicalize


@dataclass(frozen=True, slots=True)
class ScanBackVerification:
    registration_method: str
    registration_confidence: float
    translation_voxel_zyx: tuple[int, int, int]
    compared_voxel_count: int
    source_hash: str
    scan_back_hash: str
    rmse_hu: float
    mae_hu: float
    correlation: float | None
    hu_gamma_pass_percent: float
    hu_gamma_tolerance_hu: float
    physical_fidelity_status: str
    warnings: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": "voxelweave.scan-back-verification.v1",
            "registration_method": self.registration_method,
            "registration_confidence": self.registration_confidence,
            "translation_voxel_zyx": list(self.translation_voxel_zyx),
            "compared_voxel_count": self.compared_voxel_count,
            "source_hash": self.source_hash,
            "scan_back_hash": self.scan_back_hash,
            "rmse_hu": self.rmse_hu,
            "mae_hu": self.mae_hu,
            "correlation": self.correlation,
            "hu_gamma_pass_percent": self.hu_gamma_pass_percent,
            "hu_gamma_tolerance_hu": self.hu_gamma_tolerance_hu,
            "physical_fidelity_status": self.physical_fidelity_status,
            "warnings": list(self.warnings),
            "dose_gamma": "not_used_hu_gamma_is_not_dose_gamma",
        }


def export_verification_package(
    verification: ScanBackVerification,
    directory: str | Path,
    *,
    run_id: str | None = None,
    gcode_sha256: str | None = None,
    coordinate_transforms: object | None = None,
) -> dict[str, Any]:
    """Write a deterministic, hash-indexed verification evidence package."""

    target = Path(directory)
    target.mkdir(parents=True, exist_ok=True)
    report_path = target / "verification-report.json"
    provenance_path = target / "provenance.json"
    report = {
        "schema": "voxelweave.verification-report.v2",
        "verification": verification.to_dict(),
        "run_id": run_id,
        "gcode_sha256": gcode_sha256,
        "coordinate_transforms": coordinate_transforms,
        "evidence_boundary": {
            "comparison_type": "registered_signed_hu_scan_back",
            "dose_gamma": "not_used_hu_gamma_is_not_dose_gamma",
            "physical_fidelity_claim": "evidence_recorded_not_established",
            "clinical_use": "research_only_not_for_diagnosis_or_treatment",
        },
    }
    provenance = {
        "schema": "voxelweave.verification-provenance.v1",
        "source_hash": verification.source_hash,
        "scan_back_hash": verification.scan_back_hash,
        "registration_method": verification.registration_method,
        "translation_voxel_zyx": list(verification.translation_voxel_zyx),
        "raw_evidence_preserved_by_reference": True,
    }
    report_path.write_text(json.dumps(canonicalize(report), sort_keys=True, indent=2) + "\n", encoding="utf-8")
    provenance_path.write_text(json.dumps(canonicalize(provenance), sort_keys=True, indent=2) + "\n", encoding="utf-8")
    artifacts = (report_path, provenance_path)
    hashes = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in artifacts}
    hashes_path = target / "hashes.json"
    hashes_path.write_text(json.dumps({"schema": "voxelweave.verification-hashes.v1", "files": hashes}, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    package_path = target / "verification-report.zip"
    with zipfile.ZipFile(package_path, "w", compression=zipfile.ZIP_STORED, strict_timestamps=False) as archive:
        for path in sorted((*artifacts, hashes_path), key=lambda item: item.name):
            info = zipfile.ZipInfo(path.name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes())
    all_hashes = {
        **hashes,
        hashes_path.name: hashlib.sha256(hashes_path.read_bytes()).hexdigest(),
        package_path.name: hashlib.sha256(package_path.read_bytes()).hexdigest(),
    }
    return {
        "schema": "voxelweave.verification-package.v1",
        "directory": str(target),
        "report_path": str(report_path),
        "package_name": package_path.name,
        "package_path": str(package_path),
        "files": sorted(path.name for path in (*artifacts, hashes_path, package_path)),
        "hashes": all_hashes,
        "automatic_print_start": False,
        "physical_fidelity_claim": "evidence_recorded_not_established",
    }


def _overlap(reference: np.ndarray, moving: np.ndarray, shift_zyx: tuple[int, int, int]) -> tuple[np.ndarray, np.ndarray]:
    slices_ref: list[slice] = []
    slices_moving: list[slice] = []
    for size, shift in zip(reference.shape, shift_zyx, strict=True):
        if abs(shift) >= size:
            return np.empty(0), np.empty(0)
        if shift >= 0:
            slices_ref.append(slice(shift, size))
            slices_moving.append(slice(0, size - shift))
        else:
            slices_ref.append(slice(0, size + shift))
            slices_moving.append(slice(-shift, size))
    return reference[tuple(slices_ref)], moving[tuple(slices_moving)]


def verify_scan_back(
    reference: Volume,
    scan_back: Volume,
    *,
    registration_method: str = "identity",
    registration_confidence: float = 1.0,
    translation_voxel_zyx: tuple[int, int, int] = (0, 0, 0),
    hu_gamma_tolerance_hu: float = 40.0,
    expected_source_hash: str | None = None,
) -> ScanBackVerification:
    if registration_method not in {"identity", "manual_translation", "geometry_only"}:
        raise GeometryValidationError("Registration method must be identity, manual_translation, or geometry_only.")
    if not 0.0 <= registration_confidence <= 1.0:
        raise GeometryValidationError("Registration confidence must be between zero and one.")
    if registration_method == "identity" and translation_voxel_zyx != (0, 0, 0):
        raise GeometryValidationError("Identity registration cannot include a non-zero translation.")
    if expected_source_hash is not None and expected_source_hash != reference.source_hash:
        raise GeometryValidationError("Scan-back source hash does not match the expected scientific source.")
    if not np.allclose(reference.spacing_mm, scan_back.spacing_mm, atol=1e-6) or not np.allclose(reference.direction_lps, scan_back.direction_lps, atol=1e-4):
        raise GeometryValidationError("Scan-back geometry does not match the source volume; resample and record registration first.")
    ref, moving = _overlap(reference.hu, scan_back.hu, translation_voxel_zyx)
    mask = np.isfinite(ref) & np.isfinite(moving)
    if not np.any(mask):
        raise GeometryValidationError("Registration produced no overlapping finite voxels.")
    ref_values, moving_values = ref[mask].astype(np.float64), moving[mask].astype(np.float64)
    difference = moving_values - ref_values
    tolerance = float(hu_gamma_tolerance_hu)
    if tolerance <= 0:
        raise GeometryValidationError("HU gamma tolerance must be positive.")
    correlation = None
    if ref_values.size > 1 and np.std(ref_values) > 0 and np.std(moving_values) > 0:
        correlation = float(np.corrcoef(ref_values, moving_values)[0, 1])
    warnings = ("Software comparison does not establish deposited width or physical HU fidelity.",)
    return ScanBackVerification(
        registration_method=registration_method,
        registration_confidence=float(registration_confidence),
        translation_voxel_zyx=cast(tuple[int, int, int], tuple(int(item) for item in translation_voxel_zyx)),
        compared_voxel_count=int(ref_values.size),
        source_hash=reference.source_hash,
        scan_back_hash=scan_back.source_hash,
        rmse_hu=float(math.sqrt(float(np.mean(difference**2)))),
        mae_hu=float(np.mean(np.abs(difference))),
        correlation=correlation,
        hu_gamma_pass_percent=float(100.0 * np.count_nonzero(np.abs(difference) <= tolerance) / ref_values.size),
        hu_gamma_tolerance_hu=tolerance,
        physical_fidelity_status="evidence_recorded_not_established",
        warnings=warnings,
    )
