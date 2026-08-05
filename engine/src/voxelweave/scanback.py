"""Scan-back comparison with explicit registration and non-clinical boundaries."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, cast

import numpy as np

from .dicom import Volume
from .errors import GeometryValidationError


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
