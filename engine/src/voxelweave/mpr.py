"""Physical-coordinate MPR and preview operations."""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, cast

import numpy as np

from .binary import BinaryArtifact, write_binary_array
from .dicom import Volume
from .models import CancellationToken, ProgressCallback, Vec3

PlaneName = Literal["axial", "sagittal", "coronal"]


@dataclass(frozen=True, slots=True)
class MPRPlane:
    plane: PlaneName
    array: np.ndarray
    spacing_mm: tuple[float, float]
    origin_lps: Vec3
    direction_lps: tuple[Vec3, Vec3]
    coordinate_mm: float
    source_hash: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": "voxelweave.mpr-plane.v1",
            "plane": self.plane,
            "shape_yx": list(self.array.shape),
            "spacing_mm": list(self.spacing_mm),
            "origin_lps": list(self.origin_lps),
            "direction_lps": [list(row) for row in self.direction_lps],
            "coordinate_mm": self.coordinate_mm,
            "source_hash": self.source_hash,
            "scientific_source": "full_resolution_signed_hu",
        }


@dataclass(frozen=True, slots=True)
class VolumePreview:
    array: np.ndarray
    spacing_mm: Vec3
    source_shape_zyx: tuple[int, int, int]
    source_hash: str
    max_dimension: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": "voxelweave.volume-preview.v1",
            "shape_zyx": list(self.array.shape),
            "spacing_mm_dyx": list(self.spacing_mm),
            "source_shape_zyx": list(self.source_shape_zyx),
            "source_hash": self.source_hash,
            "max_dimension": self.max_dimension,
            "scientific_source": "preview_only",
        }


def _plane_axes(plane: PlaneName) -> tuple[int, int, int]:
    """Return (fixed axis, horizontal axis, vertical axis) in voxel xyz order."""

    if plane == "axial":
        return 2, 0, 1
    if plane == "sagittal":
        return 0, 1, 2
    if plane == "coronal":
        return 1, 0, 2
    raise ValueError("plane must be axial, sagittal, or coronal")


def _plane_shape(volume: Volume, plane: PlaneName) -> tuple[int, int]:
    z, y, x = volume.shape_zyx
    return {"axial": (y, x), "sagittal": (z, y), "coronal": (z, x)}[plane]


def _axis_spacing(volume: Volume, axis: int) -> float:
    return (volume.spacing_mm[2], volume.spacing_mm[1], volume.spacing_mm[0])[axis]


def _sample_voxel_array(volume: Volume, voxel_xyz: np.ndarray, *, method: str) -> np.ndarray:
    x = np.clip(voxel_xyz[..., 0], 0.0, volume.shape_zyx[2] - 1.0)
    y = np.clip(voxel_xyz[..., 1], 0.0, volume.shape_zyx[1] - 1.0)
    z = np.clip(voxel_xyz[..., 2], 0.0, volume.shape_zyx[0] - 1.0)
    if method == "nearest":
        return volume.hu[np.rint(z).astype(np.int64), np.rint(y).astype(np.int64), np.rint(x).astype(np.int64)]
    if method != "linear":
        raise ValueError("MPR sampling method must be nearest or linear.")
    try:
        from scipy.ndimage import map_coordinates  # type: ignore[import-untyped]

        coords = np.stack((z.ravel(), y.ravel(), x.ravel()), axis=0)
        return map_coordinates(volume.hu, coords, order=1, mode="nearest").reshape(x.shape).astype(np.float32)
    except ImportError:
        flat = np.empty(x.size, dtype=np.float32)
        for index, point in enumerate(zip(x.ravel(), y.ravel(), z.ravel(), strict=True)):
            point_tuple: tuple[float, float, float] = (float(point[0]), float(point[1]), float(point[2]))
            lps = volume.voxel_to_lps(point_tuple)
            flat[index] = volume.sample(tuple(float(value) for value in lps), method="linear")
        return flat.reshape(x.shape)


def request_mpr_plane(
    volume: Volume,
    plane: PlaneName,
    *,
    index: int | None = None,
    coordinate_mm: float | None = None,
    output_spacing_mm: tuple[float, float] | None = None,
    output_shape_yx: tuple[int, int] | None = None,
    method: str = "linear",
    cancellation: CancellationToken | None = None,
) -> MPRPlane:
    """Resample an axial, sagittal, or coronal plane from the full HU volume."""

    fixed_axis, horizontal_axis, vertical_axis = _plane_axes(plane)
    shape_yx = _plane_shape(volume, plane)
    fixed_count = volume.shape_zyx[::-1][fixed_axis]
    spacing_xyz = tuple(_axis_spacing(volume, axis) for axis in (0, 1, 2))
    if coordinate_mm is None:
        selected_index = fixed_count // 2 if index is None else int(index)
        if selected_index < 0 or selected_index >= fixed_count:
            raise ValueError("MPR plane index is outside the source volume.")
        coordinate_mm = selected_index * spacing_xyz[fixed_axis]
    coordinate_mm = float(coordinate_mm)
    if coordinate_mm < -1e-6 or coordinate_mm > (fixed_count - 1) * spacing_xyz[fixed_axis] + 1e-6:
        raise ValueError("MPR plane coordinate is outside the source volume.")
    if output_spacing_mm is None:
        output_spacing_mm = (_axis_spacing(volume, vertical_axis), _axis_spacing(volume, horizontal_axis))
    if len(output_spacing_mm) != 2 or any(item <= 0 for item in output_spacing_mm):
        raise ValueError("MPR output spacing must contain positive vertical and horizontal values.")
    vertical_extent = (shape_yx[0] - 1) * _axis_spacing(volume, vertical_axis)
    horizontal_extent = (shape_yx[1] - 1) * _axis_spacing(volume, horizontal_axis)
    requested_shape = output_shape_yx or (
        max(1, int(math.ceil(vertical_extent / output_spacing_mm[0])) + 1),
        max(1, int(math.ceil(horizontal_extent / output_spacing_mm[1])) + 1),
    )
    if len(requested_shape) != 2 or min(requested_shape) < 1:
        raise ValueError("MPR output shape must contain two positive dimensions.")
    if output_shape_yx is not None:
        vertical = np.linspace(0.0, vertical_extent, requested_shape[0], dtype=np.float64)
        horizontal = np.linspace(0.0, horizontal_extent, requested_shape[1], dtype=np.float64)
        effective_spacing = (
            vertical_extent / (requested_shape[0] - 1) if requested_shape[0] > 1 else _axis_spacing(volume, vertical_axis),
            horizontal_extent / (requested_shape[1] - 1) if requested_shape[1] > 1 else _axis_spacing(volume, horizontal_axis),
        )
    else:
        vertical = np.minimum(np.arange(requested_shape[0], dtype=np.float64) * output_spacing_mm[0], vertical_extent)
        horizontal = np.minimum(np.arange(requested_shape[1], dtype=np.float64) * output_spacing_mm[1], horizontal_extent)
        effective_spacing = output_spacing_mm
    vv, hh = np.meshgrid(vertical, horizontal, indexing="ij")
    voxel = np.zeros((*requested_shape, 3), dtype=np.float64)
    voxel[..., fixed_axis] = coordinate_mm / spacing_xyz[fixed_axis]
    voxel[..., horizontal_axis] = hh / spacing_xyz[horizontal_axis]
    voxel[..., vertical_axis] = vv / spacing_xyz[vertical_axis]
    if cancellation:
        cancellation.checkpoint()
    array = _sample_voxel_array(volume, voxel, method=method).astype(np.float32)
    origin = volume.voxel_to_lps(tuple(float(value) for value in voxel[0, 0]))
    horizontal_world = volume.direction_lps[:, horizontal_axis]
    vertical_world = volume.direction_lps[:, vertical_axis]
    return MPRPlane(
        plane=plane,
        array=array,
        spacing_mm=(float(effective_spacing[0]), float(effective_spacing[1])),
        origin_lps=cast(Vec3, tuple(float(item) for item in origin)),
        direction_lps=(cast(Vec3, tuple(float(item) for item in horizontal_world)), cast(Vec3, tuple(float(item) for item in vertical_world))),
        coordinate_mm=coordinate_mm,
        source_hash=volume.source_hash,
    )


def request_volume_preview(
    volume: Volume,
    *,
    max_dimension: int = 128,
    method: str = "nearest",
    cancellation: CancellationToken | None = None,
) -> VolumePreview:
    """Create a deterministic display-only pyramid level from the scientific source."""

    if max_dimension < 2:
        raise ValueError("Preview max_dimension must be at least two.")
    source_shape = np.asarray(volume.shape_zyx, dtype=np.int64)
    scale = min(1.0, float(max_dimension) / float(np.max(source_shape)))
    target_shape = np.maximum(2, np.rint(source_shape * scale).astype(np.int64))
    if np.array_equal(target_shape, source_shape):
        array = volume.hu.copy()
    elif method == "nearest":
        indices = [np.rint(np.linspace(0, size - 1, int(target))).astype(np.int64) for size, target in zip(source_shape, target_shape, strict=True)]
        array = volume.hu[np.ix_(*indices)].astype(np.float32)
    else:
        try:
            from scipy.ndimage import zoom  # type: ignore[import-untyped]

            array = zoom(volume.hu, target_shape / source_shape, order=1, mode="nearest", prefilter=False).astype(np.float32)
        except ImportError:
            indices = [np.rint(np.linspace(0, size - 1, int(target))).astype(np.int64) for size, target in zip(source_shape, target_shape, strict=True)]
            array = volume.hu[np.ix_(*indices)].astype(np.float32)
    spacing = cast(Vec3, tuple(float(size * step / target) for size, step, target in zip(source_shape, volume.spacing_mm, target_shape, strict=True)))
    if cancellation:
        cancellation.checkpoint()
    return VolumePreview(array, spacing, volume.shape_zyx, volume.source_hash, max_dimension)


def build_volume_cache(
    volume: Volume,
    directory: str | Path,
    *,
    preview_dimensions: tuple[int, ...] = (128, 64),
    request_id: str = "cache",
    progress: ProgressCallback | None = None,
    cancellation: CancellationToken | None = None,
) -> dict[str, Any]:
    """Persist the full signed-HU cache and display-only pyramid artifacts."""

    target = Path(directory)
    target.mkdir(parents=True, exist_ok=True)
    full = write_binary_array(target / "volume_hu.bin", volume.hu, artifact_type="signed_hu_volume", metadata=volume.to_binary_metadata())
    previews: list[BinaryArtifact] = []
    for index, dimension in enumerate(preview_dimensions, start=1):
        if cancellation:
            cancellation.checkpoint()
        preview = request_volume_preview(volume, max_dimension=int(dimension), cancellation=cancellation)
        previews.append(
            write_binary_array(
                target / f"preview_{int(dimension)}.bin",
                preview.array,
                artifact_type="volume_preview",
                metadata={
                    **preview.to_dict(),
                    "origin_lps": [float(item) for item in volume.origin_lps],
                    "direction_lps": [[float(item) for item in row] for row in volume.direction_lps],
                },
            )
        )
        if progress:
            from .models import ProgressEvent

            progress(ProgressEvent(request_id, "build_volume_cache", "preview", index, len(preview_dimensions), "Writing display pyramid."))
    return {
        "schema": "voxelweave.volume-cache.v1",
        "scientific_source": {"path": full.path.name, "sha256": full.sha256, "header": full.header},
        "previews": [{"path": item.path.name, "sha256": item.sha256, "header": item.header} for item in previews],
    }


def sample_voxel(volume: Volume, position_lps: Vec3, *, method: str = "linear") -> float:
    return volume.sample(position_lps, method=method)


def calculate_histogram(
    volume: Volume,
    *,
    bins: int = 256,
    hu_range: tuple[float, float] | None = None,
) -> dict[str, Any]:
    if bins < 1:
        raise ValueError("Histogram bins must be positive.")
    values = volume.hu[np.isfinite(volume.hu)]
    if hu_range is None:
        hu_range = (float(np.min(values)), float(np.max(values)))
    if hu_range[1] <= hu_range[0]:
        raise ValueError("Histogram HU range must be increasing.")
    counts, edges = np.histogram(values, bins=bins, range=hu_range)
    return {
        "schema": "voxelweave.histogram.v1",
        "bins": int(bins),
        "range_hu": [float(hu_range[0]), float(hu_range[1])],
        "counts": [int(item) for item in counts],
        "edges_hu": [float(item) for item in edges],
        "sample_count": int(values.size),
        "source_hash": volume.source_hash,
    }
