"""Complete-series DICOM inspection, selection, and signed-HU loading."""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast

import numpy as np
import pydicom
from pydicom.dataset import Dataset

from .errors import DicomValidationError
from .models import CancellationToken, ProgressCallback, Vec3, as_vec3, canonicalize

LOCALIZER_WORDS = ("LOCALIZER", "SCOUT", "TOPOGRAM", "SURVEY", "PILOT")


@dataclass(frozen=True, slots=True)
class DicomInstance:
    """PHI-safe geometry record for one image or one supported multiframe frame."""

    source_name: str
    frame_index: int
    series_uid: str
    modality: str
    rows: int
    columns: int
    position_lps: Vec3 | None
    orientation: tuple[float, ...] | None
    pixel_spacing: tuple[float, float] | None
    slope: float
    intercept: float
    pixel_representation: int | None
    bits_stored: int | None
    image_type: tuple[str, ...]
    series_description: str
    eligible: bool
    exclusion_reason: str | None = None


@dataclass(frozen=True, slots=True)
class DicomSeriesSummary:
    series_uid: str
    modality: str
    instance_count: int
    eligible: bool
    exclusion_reason: str | None
    orientation: dict[str, Any] | None
    spacing: dict[str, Any] | None
    source_names: tuple[str, ...]
    multiframe: bool

    def to_dict(self) -> dict[str, Any]:
        return cast(dict[str, Any], canonicalize(
            {
                "series_uid": self.series_uid,
                "modality": self.modality,
                "instance_count": self.instance_count,
                "eligible": self.eligible,
                "exclusion_reason": self.exclusion_reason,
                "orientation": self.orientation,
                "spacing": self.spacing,
                "source_names": self.source_names,
                "multiframe": self.multiframe,
            }
        ))


@dataclass(frozen=True, slots=True)
class DicomInspection:
    source_label: str
    series: tuple[DicomSeriesSummary, ...]
    excluded_count: int
    warnings: tuple[str, ...] = ()

    @property
    def eligible_series(self) -> tuple[DicomSeriesSummary, ...]:
        return tuple(item for item in self.series if item.eligible)

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": "voxelweave.dicom-inspection.v1",
            "source_label": self.source_label,
            "series": [item.to_dict() for item in self.series],
            "excluded_count": self.excluded_count,
            "warnings": list(self.warnings),
        }


@dataclass(slots=True)
class Volume:
    """Full-resolution source volume in [z, y, x] signed HU order."""

    hu: np.ndarray
    spacing_mm: tuple[float, float, float]
    origin_lps: np.ndarray
    direction_lps: np.ndarray
    series_uid: str
    study_uid: str | None = None
    frame_of_reference_uid: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.hu = np.ascontiguousarray(np.asarray(self.hu, dtype=np.float32))
        if self.hu.ndim != 3 or any(int(item) < 2 for item in self.hu.shape):
            raise DicomValidationError("CT source must contain a 3D volume with at least two samples per axis.")
        self.spacing_mm = as_vec3(self.spacing_mm, name="spacing_mm")
        if any(item <= 0.0 for item in self.spacing_mm):
            raise DicomValidationError("CT source spacing must be positive in dz, dy, dx order.")
        self.origin_lps = np.asarray(self.origin_lps, dtype=np.float64)
        self.direction_lps = np.asarray(self.direction_lps, dtype=np.float64)
        if self.origin_lps.shape != (3,) or self.direction_lps.shape != (3, 3):
            raise DicomValidationError("CT source orientation metadata must be a 3-vector and 3x3 matrix.")
        if not np.all(np.isfinite(self.hu)) or not np.all(np.isfinite(self.origin_lps)):
            raise DicomValidationError("CT source contains non-finite scientific geometry or HU values.")
        if not np.allclose(self.direction_lps.T @ self.direction_lps, np.eye(3), atol=1e-4):
            raise DicomValidationError("CT source direction matrix is not orthonormal.")

    @property
    def shape_zyx(self) -> tuple[int, int, int]:
        return cast(tuple[int, int, int], tuple(int(item) for item in self.hu.shape))

    @property
    def size_mm_xyz(self) -> Vec3:
        z, y, x = self.hu.shape
        dz, dy, dx = self.spacing_mm
        return float(x * dx), float(y * dy), float(z * dz)

    @property
    def source_hash(self) -> str:
        import hashlib

        digest = hashlib.sha256()
        digest.update(self.hu.tobytes(order="C"))
        digest.update(np.asarray(self.spacing_mm, dtype="<f8").tobytes())
        digest.update(np.asarray(self.origin_lps, dtype="<f8").tobytes())
        digest.update(np.asarray(self.direction_lps, dtype="<f8").tobytes())
        return digest.hexdigest()

    def to_binary_metadata(self) -> dict[str, Any]:
        return {
            "spacing_mm_dyx": list(self.spacing_mm),
            "origin_lps": [float(item) for item in self.origin_lps],
            "direction_lps": [[float(item) for item in row] for row in self.direction_lps],
            "series_uid": self.series_uid,
            "source_hash": self.source_hash,
            "scientific_source": "full_resolution_signed_hu",
            **canonicalize(self.metadata),
        }

    def voxel_to_lps(self, voxel_xyz: Sequence[float]) -> np.ndarray:
        x, y, z = (float(item) for item in voxel_xyz)
        dx, dy, dz = self.spacing_mm[2], self.spacing_mm[1], self.spacing_mm[0]
        return np.asarray(self.origin_lps + self.direction_lps @ np.asarray([x * dx, y * dy, z * dz], dtype=np.float64), dtype=np.float64)

    def lps_to_voxel(self, position_lps: Sequence[float]) -> np.ndarray:
        dx, dy, dz = self.spacing_mm[2], self.spacing_mm[1], self.spacing_mm[0]
        scaled = np.asarray(position_lps, dtype=np.float64) - self.origin_lps
        return np.linalg.solve(self.direction_lps, scaled) / np.asarray([dx, dy, dz], dtype=np.float64)

    def sample(self, position_lps: Sequence[float], *, method: str = "linear") -> float:
        voxel = self.lps_to_voxel(position_lps)
        if method == "nearest":
            nx, ny, nz = (int(np.clip(round(item), 0, limit - 1)) for item, limit in zip(voxel, self.shape_zyx[::-1], strict=True))
            return float(self.hu[nz, ny, nx])
        if method != "linear":
            raise ValueError("sample method must be 'nearest' or 'linear'.")
        x, y, z = (float(item) for item in voxel)
        z_count, y_count, x_count = self.shape_zyx
        x = float(np.clip(x, 0.0, x_count - 1.0))
        y = float(np.clip(y, 0.0, y_count - 1.0))
        z = float(np.clip(z, 0.0, z_count - 1.0))
        x0, y0, z0 = int(math.floor(x)), int(math.floor(y)), int(math.floor(z))
        x1, y1, z1 = min(x0 + 1, x_count - 1), min(y0 + 1, y_count - 1), min(z0 + 1, z_count - 1)
        tx, ty, tz = x - x0, y - y0, z - z0
        c000 = self.hu[z0, y0, x0]
        c001 = self.hu[z0, y0, x1]
        c010 = self.hu[z0, y1, x0]
        c011 = self.hu[z0, y1, x1]
        c100 = self.hu[z1, y0, x0]
        c101 = self.hu[z1, y0, x1]
        c110 = self.hu[z1, y1, x0]
        c111 = self.hu[z1, y1, x1]
        c00, c01 = c000 * (1.0 - tx) + c001 * tx, c010 * (1.0 - tx) + c011 * tx
        c10, c11 = c100 * (1.0 - tx) + c101 * tx, c110 * (1.0 - tx) + c111 * tx
        return float((c00 * (1.0 - ty) + c01 * ty) * (1.0 - tz) + (c10 * (1.0 - ty) + c11 * ty) * tz)


def _safe_float(value: Any, default: float) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if math.isfinite(result) else default


def _text(value: Any) -> str:
    return str(value or "").strip()


def _image_type(ds: Dataset) -> tuple[str, ...]:
    value = getattr(ds, "ImageType", ())
    if isinstance(value, str):
        return (value.upper(),)
    return tuple(str(item).upper() for item in value)


def _orientation(value: Any) -> tuple[float, ...] | None:
    try:
        result = tuple(float(item) for item in value)
    except (TypeError, ValueError):
        return None
    return result if len(result) == 6 and all(math.isfinite(item) for item in result) else None


def _position(value: Any) -> Vec3 | None:
    try:
        result = as_vec3(value, name="ImagePositionPatient")
    except ValueError:
        return None
    return result


def _spacing(value: Any) -> tuple[float, float] | None:
    try:
        result = tuple(float(item) for item in value)
    except (TypeError, ValueError):
        return None
    if len(result) != 2 or not all(math.isfinite(item) and item > 0 for item in result):
        return None
    return result[0], result[1]


def _sequence_item(value: Any, name: str, index: int = 0) -> Any | None:
    sequence = getattr(value, name, None) if value is not None else None
    try:
        return sequence[index] if sequence is not None and len(sequence) > index else None
    except (TypeError, IndexError):
        return None


def _frame_value(ds: Dataset, frame_index: int, sequence_name: str, attr_name: str) -> Any | None:
    per_frame = _sequence_item(ds, "PerFrameFunctionalGroupsSequence", frame_index)
    shared = _sequence_item(ds, "SharedFunctionalGroupsSequence")
    for group in (per_frame, shared):
        item = _sequence_item(group, sequence_name)
        if item is not None and hasattr(item, attr_name):
            return getattr(item, attr_name)
    return getattr(ds, attr_name, None)


def _frame_records(path: Path, ds: Dataset) -> tuple[list[DicomInstance], np.ndarray]:
    if "PixelData" not in ds:
        return [], np.empty((0, 0, 0), dtype=np.float32)
    try:
        pixels = np.asarray(ds.pixel_array)
    except Exception as exc:
        raise DicomValidationError("DICOM pixel data could not be decoded for a supported CT source.") from exc
    frames = int(getattr(ds, "NumberOfFrames", 1) or 1)
    if frames == 1:
        pixel_frames = pixels[np.newaxis, ...] if pixels.ndim == 2 else pixels
    elif pixels.ndim >= 3 and pixels.shape[0] == frames:
        pixel_frames = pixels
    else:
        raise DicomValidationError("DICOM multiframe pixel data has unsupported frame geometry.")
    orientation_value = getattr(ds, "ImageOrientationPatient", None)
    orientation = _orientation(orientation_value)
    if orientation is None:
        orientation = _orientation(_frame_value(ds, 0, "PlaneOrientationSequence", "ImageOrientationPatient"))
    normal = np.asarray([0.0, 0.0, 1.0], dtype=np.float64)
    if orientation is not None:
        normal = np.cross(np.asarray(orientation[:3]), np.asarray(orientation[3:]))
        norm = float(np.linalg.norm(normal))
        if norm > 0:
            normal /= norm
    base_position = _position(getattr(ds, "ImagePositionPatient", None))
    default_spacing = _safe_float(getattr(ds, "SpacingBetweenSlices", None), _safe_float(getattr(ds, "SliceThickness", None), 1.0))
    rows = int(getattr(ds, "Rows", None) or pixel_frames.shape[-2])
    columns = int(getattr(ds, "Columns", None) or pixel_frames.shape[-1])
    records: list[DicomInstance] = []
    for frame_index in range(frames):
        frame_orientation = _orientation(_frame_value(ds, frame_index, "PlaneOrientationSequence", "ImageOrientationPatient")) or orientation
        position_value: Any | None = None
        per_frame_group = _sequence_item(ds, "PerFrameFunctionalGroupsSequence", frame_index)
        shared_group = _sequence_item(ds, "SharedFunctionalGroupsSequence")
        for group in (per_frame_group, shared_group):
            position_item = _sequence_item(group, "PlanePositionSequence")
            if position_item is not None and hasattr(position_item, "ImagePositionPatient"):
                position_value = position_item.ImagePositionPatient
                break
        if position_value is None and frames == 1:
            position_value = getattr(ds, "ImagePositionPatient", None)
        position = _position(position_value)
        if position is None and base_position is not None and frames > 1:
            position = as_vec3(
                (np.asarray(base_position) + normal * default_spacing * frame_index).tolist(),
                name="ImagePositionPatient",
            )
        spacing = _spacing(_frame_value(ds, frame_index, "PixelMeasuresSequence", "PixelSpacing"))
        if spacing is None:
            spacing = _spacing(getattr(ds, "PixelSpacing", None))
        slope = _safe_float(_frame_value(ds, frame_index, "PixelValueTransformationSequence", "RescaleSlope"), 1.0)
        intercept = _safe_float(_frame_value(ds, frame_index, "PixelValueTransformationSequence", "RescaleIntercept"), 0.0)
        image_type = _image_type(ds)
        searchable = " ".join((*image_type, _text(getattr(ds, "SeriesDescription", "")), _text(getattr(ds, "ProtocolName", "")))).upper()
        modality = _text(getattr(ds, "Modality", "")).upper()
        reason: str | None = None
        if modality != "CT":
            reason = "non_ct_modality"
        elif any(word in searchable for word in LOCALIZER_WORDS):
            reason = "localizer_or_scout"
        elif not _text(getattr(ds, "SeriesInstanceUID", "")):
            reason = "missing_series_instance_uid"
        elif position is None:
            reason = "missing_image_position_patient"
        elif frame_orientation is None:
            reason = "missing_image_orientation_patient"
        elif spacing is None:
            reason = "missing_pixel_spacing"
        records.append(
            DicomInstance(
                source_name="source-object",
                frame_index=frame_index,
                series_uid=_text(getattr(ds, "SeriesInstanceUID", "")) or "MISSING_SERIES",
                modality=modality,
                rows=rows,
                columns=columns,
                position_lps=position,
                orientation=frame_orientation,
                pixel_spacing=spacing,
                slope=slope,
                intercept=intercept,
                pixel_representation=int(getattr(ds, "PixelRepresentation", 0)) if hasattr(ds, "PixelRepresentation") else None,
                bits_stored=int(getattr(ds, "BitsStored", 0)) if hasattr(ds, "BitsStored") else None,
                image_type=image_type,
                series_description=_text(getattr(ds, "SeriesDescription", "")),
                eligible=reason is None,
                exclusion_reason=reason,
            )
        )
    return records, np.asarray(pixel_frames)


def _read_candidate(path: Path) -> tuple[list[DicomInstance], np.ndarray, Dataset] | None:
    try:
        ds = pydicom.dcmread(str(path), stop_before_pixels=False, force=True)
    except Exception:
        return None
    if "PixelData" not in ds:
        return None
    records, pixels = _frame_records(path, ds)
    return records, pixels, ds


def _candidate_paths(source: str | Path) -> list[Path]:
    root = Path(source)
    if not root.exists():
        raise DicomValidationError("DICOM source path does not exist.")
    if root.is_file():
        return [root]
    return sorted(item for item in root.rglob("*") if item.is_file())


def _collect(source: str | Path) -> tuple[dict[str, list[tuple[DicomInstance, np.ndarray, Dataset]]], int]:
    groups: dict[str, list[tuple[DicomInstance, np.ndarray, Dataset]]] = defaultdict(list)
    excluded = 0
    for path in _candidate_paths(source):
        candidate = _read_candidate(path)
        if candidate is None:
            continue
        records, pixels, ds = candidate
        for index, record in enumerate(records):
            groups[record.series_uid].append((record, pixels[index], ds))
            if not record.eligible:
                excluded += 1
    return groups, excluded


def _orientation_geometry(records: Sequence[DicomInstance]) -> dict[str, Any] | None:
    if not records or records[0].orientation is None or any(item.position_lps is None for item in records):
        return None
    orientation = np.asarray(records[0].orientation, dtype=np.float64)
    row, col = orientation[:3], orientation[3:]
    row_norm, col_norm, orthogonality = np.linalg.norm(row), np.linalg.norm(col), float(np.dot(row, col))
    normal = np.cross(row, col)
    normal_norm = float(np.linalg.norm(normal))
    if normal_norm > 0:
        normal /= normal_norm
    positions = np.asarray([item.position_lps for item in records], dtype=np.float64)
    projections = positions @ normal
    order = np.argsort(projections, kind="mergesort")
    positions = positions[order]
    projections = projections[order]
    deltas = positions - positions[0]
    drift = float(math.hypot(float(np.ptp(deltas @ row)), float(np.ptp(deltas @ col))))
    diffs = np.diff(projections)
    dz = float(np.median(diffs)) if diffs.size else None
    return {
        "row_cosines": [float(item) for item in row],
        "column_cosines": [float(item) for item in col],
        "normal_cosines": [float(item) for item in normal],
        "row_norm": float(row_norm),
        "column_norm": float(col_norm),
        "row_column_dot": orthogonality,
        "duplicate_position_count": int(np.count_nonzero(np.abs(diffs) <= 1e-4)),
        "slice_position_count": int(len(projections)),
        "median_projected_spacing_mm": dz,
        "min_projected_spacing_mm": float(np.min(diffs)) if diffs.size else None,
        "max_projected_spacing_mm": float(np.max(diffs)) if diffs.size else None,
        "in_plane_drift_mm": drift,
        "gantry_tilt_detected": bool(drift > 0.25),
        "axis_aligned": bool(max(np.max(np.abs(row)), np.max(np.abs(col)), np.max(np.abs(normal))) >= 0.999),
    }


def inspect_dicom_source(
    source: str | Path,
    *,
    request_id: str = "inspection",
    progress: ProgressCallback | None = None,
    cancellation: CancellationToken | None = None,
) -> DicomInspection:
    """Inspect all candidate images without exposing patient tags in the report."""

    paths = _candidate_paths(source)
    groups: dict[str, list[DicomInstance]] = defaultdict(list)
    excluded = 0
    warnings: list[str] = []
    total = max(1, len(paths))
    for index, path in enumerate(paths, start=1):
        if cancellation:
            cancellation.checkpoint()
        candidate = _read_candidate(path)
        if candidate is not None:
            records, _, _ = candidate
            for record in records:
                groups[record.series_uid].append(record)
                if not record.eligible:
                    excluded += 1
        if progress:
            from .models import ProgressEvent

            progress(ProgressEvent(request_id, "inspect_dicom_source", "read", index, total, "Inspecting CT source."))
    summaries: list[DicomSeriesSummary] = []
    for series_uid in sorted(groups):
        records = groups[series_uid]
        geometry = _orientation_geometry(records)
        geometry_invalid = bool(geometry and (geometry.get("gantry_tilt_detected") or geometry.get("duplicate_position_count", 0) > 0))
        eligible = all(item.eligible for item in records) and len(records) >= 2 and not geometry_invalid
        reason = None if eligible else next((item.exclusion_reason for item in records if item.exclusion_reason), None)
        if reason is None and len(records) < 2:
            reason = "series_requires_at_least_two_slices"
        if reason is None and geometry_invalid:
            reason = "unsupported_gantry_tilt_or_duplicate_positions"
        summaries.append(
            DicomSeriesSummary(
                series_uid=series_uid,
                modality=records[0].modality,
                instance_count=len(records),
                eligible=eligible,
                exclusion_reason=reason,
                orientation=geometry,
                spacing={"pixel_spacing": list(records[0].pixel_spacing or ())} if records else None,
                source_names=tuple(sorted({item.source_name for item in records})),
                multiframe=any(item.frame_index > 0 for item in records),
            )
        )
    if not summaries:
        raise DicomValidationError("No pixel-bearing DICOM objects were found in the source.")
    return DicomInspection("<dicom-source>", tuple(summaries), excluded, tuple(warnings))


def select_dicom_series(
    source_or_inspection: str | Path | DicomInspection,
    *,
    series_uid: str | None = None,
) -> DicomSeriesSummary:
    inspection = source_or_inspection if isinstance(source_or_inspection, DicomInspection) else inspect_dicom_source(source_or_inspection)
    eligible = inspection.eligible_series
    if series_uid is not None:
        for item in eligible:
            if item.series_uid == series_uid:
                return item
        raise DicomValidationError("Requested SeriesInstanceUID is not an eligible CT series.")
    if not eligible:
        raise DicomValidationError("No eligible CT series is available after localizer and geometry filtering.")
    return sorted(eligible, key=lambda item: (-item.instance_count, item.series_uid))[0]


def _validate_records(records: list[tuple[DicomInstance, np.ndarray, Dataset]], *, gantry_tilt_tolerance_mm: float) -> tuple[list[tuple[DicomInstance, np.ndarray, Dataset]], dict[str, Any]]:
    if len(records) < 2:
        raise DicomValidationError("A complete CT source requires at least two image positions.")
    instances = [item[0] for item in records]
    if any(item.position_lps is None for item in instances):
        raise DicomValidationError("CT source is missing ImagePositionPatient on one or more frames.")
    if any(item.orientation is None for item in instances):
        raise DicomValidationError("CT source is missing ImageOrientationPatient on one or more frames.")
    orientation = np.asarray(instances[0].orientation, dtype=np.float64)
    row, col = orientation[:3], orientation[3:]
    if abs(float(np.linalg.norm(row)) - 1.0) > 1e-3 or abs(float(np.linalg.norm(col)) - 1.0) > 1e-3 or abs(float(np.dot(row, col))) > 1e-3:
        raise DicomValidationError("CT direction cosines are not orthonormal.")
    normal = np.cross(row, col)
    normal /= np.linalg.norm(normal)
    first_orientation = tuple(float(item) for item in instances[0].orientation or ())
    first_spacing = instances[0].pixel_spacing
    if first_spacing is None:
        raise DicomValidationError("CT source is missing PixelSpacing.")
    for item in instances:
        item_orientation = item.orientation
        if item_orientation is None:
            raise DicomValidationError("CT source is missing ImageOrientationPatient on one or more frames.")
        if tuple(float(value) for value in item_orientation) != first_orientation and not np.allclose(item_orientation, first_orientation, atol=1e-4):
            raise DicomValidationError("CT source contains inconsistent direction cosines.")
        if item.pixel_spacing is None or not np.allclose(item.pixel_spacing, first_spacing, atol=1e-4):
            raise DicomValidationError("CT source contains inconsistent PixelSpacing values.")
        if item.rows != instances[0].rows or item.columns != instances[0].columns:
            raise DicomValidationError("CT source contains inconsistent image dimensions.")
    projections = np.asarray([np.dot(np.asarray(item.position_lps), normal) for item in instances], dtype=np.float64)
    order = np.argsort(projections, kind="mergesort")
    sorted_records = [records[int(index)] for index in order]
    sorted_projections = projections[order]
    diffs = np.diff(sorted_projections)
    if np.any(diffs <= 1e-4):
        raise DicomValidationError("CT source contains duplicate or non-increasing ImagePositionPatient projections.")
    dz = float(np.median(diffs))
    if np.max(np.abs(diffs - dz)) > 0.1:
        raise DicomValidationError("CT source has missing or irregular slice spacing beyond tolerance.")
    positions = np.asarray([item[0].position_lps for item in sorted_records], dtype=np.float64)
    deltas = positions - positions[0]
    in_plane_drift = float(math.hypot(float(np.ptp(deltas @ row)), float(np.ptp(deltas @ col))))
    geometry = {
        "row_cosines": [float(item) for item in row],
        "column_cosines": [float(item) for item in col],
        "normal_cosines": [float(item) for item in normal],
        "median_projected_spacing_mm": dz,
        "in_plane_drift_mm": in_plane_drift,
        "gantry_tilt_detected": bool(in_plane_drift > gantry_tilt_tolerance_mm),
    }
    if in_plane_drift > gantry_tilt_tolerance_mm:
        raise DicomValidationError("CT source has gantry tilt or in-plane slice drift; resample it before generation.")
    return sorted_records, geometry


def load_dicom_series(
    source: str | Path,
    *,
    series_uid: str | None = None,
    gantry_tilt_tolerance_mm: float = 0.25,
    request_id: str = "load",
    progress: ProgressCallback | None = None,
    cancellation: CancellationToken | None = None,
) -> Volume:
    """Load one validated series into the full-resolution signed-HU scientific source."""

    groups, _ = _collect(source)
    eligible_groups = {uid: items for uid, items in groups.items() if all(item[0].eligible for item in items)}
    if series_uid is None:
        if not eligible_groups:
            raise DicomValidationError("No eligible CT series is available after DICOM filtering.")
        series_uid = sorted(eligible_groups, key=lambda uid: (-len(eligible_groups[uid]), uid))[0]
    if series_uid not in eligible_groups:
        raise DicomValidationError("Requested SeriesInstanceUID is not an eligible CT series.")
    records, geometry = _validate_records(eligible_groups[series_uid], gantry_tilt_tolerance_mm=gantry_tilt_tolerance_mm)
    first, first_pixels, first_ds = records[0]
    arrays: list[np.ndarray] = []
    for index, (record, pixels, _) in enumerate(records, start=1):
        if cancellation:
            cancellation.checkpoint()
        arrays.append(np.asarray(pixels, dtype=np.float32) * record.slope + record.intercept)
        if progress:
            from .models import ProgressEvent

            progress(ProgressEvent(request_id, "select_dicom_series", "decode", index, len(records), "Decoding signed HU."))
    hu = np.stack(arrays, axis=0).astype(np.float32)
    orientation = np.asarray(first.orientation, dtype=np.float64)
    row, col = orientation[:3], orientation[3:]
    normal = np.cross(row, col)
    normal /= np.linalg.norm(normal)
    direction = np.column_stack((row, col, normal))
    dy, dx = first.pixel_spacing or (1.0, 1.0)
    return Volume(
        hu=hu,
        spacing_mm=(float(geometry["median_projected_spacing_mm"]), float(dy), float(dx)),
        origin_lps=np.asarray(first.position_lps, dtype=np.float64),
        direction_lps=direction,
        series_uid=series_uid,
        study_uid=_text(getattr(first_ds, "StudyInstanceUID", "")) or None,
        frame_of_reference_uid=_text(getattr(first_ds, "FrameOfReferenceUID", "")) or None,
        metadata={
            "schema": "voxelweave.volume.v1",
            "modality": "CT",
            "geometry": geometry,
            "slice_count": len(records),
            "pixel_representation_values": sorted({item.pixel_representation for item, _, _ in records}),
            "bits_stored_values": sorted({item.bits_stored for item, _, _ in records}),
            "rescale_slope_range": [min(item.slope for item, _, _ in records), max(item.slope for item, _, _ in records)],
            "rescale_intercept_range": [min(item.intercept for item, _, _ in records), max(item.intercept for item, _, _ in records)],
            "source_dicom_identifiers": "redacted_from_logs",
        },
    )
