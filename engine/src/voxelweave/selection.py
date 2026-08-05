"""Orthogonal physical print-selection definitions and source-to-print mapping."""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal, cast

import numpy as np

from .dicom import Volume
from .errors import GeometryValidationError
from .models import Vec3, canonicalize
from .mpr import PlaneName

SelectionMode = Literal["single", "continuous", "tile"]


def _axis_map(plane: PlaneName) -> tuple[int, int, int]:
    if plane == "axial":
        return 0, 1, 2  # print x/y/z -> source x/y/z
    if plane == "sagittal":
        return 1, 2, 0  # print x/y/z -> source y/z/x
    if plane == "coronal":
        return 0, 2, 1  # print x/y/z -> source x/z/y
    raise GeometryValidationError("Print plane must be axial, sagittal, or coronal.")


def _source_bounds_from_crop(volume: Volume, crop_min_lps: Vec3 | None, crop_max_lps: Vec3 | None) -> tuple[np.ndarray, np.ndarray]:
    if crop_min_lps is None and crop_max_lps is None:
        return np.zeros(3, dtype=np.float64), np.asarray(volume.shape_zyx[::-1], dtype=np.float64) - 1.0
    if crop_min_lps is None or crop_max_lps is None:
        raise GeometryValidationError("crop_min_lps and crop_max_lps must be supplied together.")
    corners = np.asarray(
        [
            [x, y, z]
            for x in (crop_min_lps[0], crop_max_lps[0])
            for y in (crop_min_lps[1], crop_max_lps[1])
            for z in (crop_min_lps[2], crop_max_lps[2])
        ],
        dtype=np.float64,
    )
    voxels = np.stack([volume.lps_to_voxel(tuple(float(value) for value in corner)) for corner in corners], axis=0)
    low, high = np.min(voxels, axis=0), np.max(voxels, axis=0)
    source_shape = np.asarray(volume.shape_zyx[::-1], dtype=np.float64)
    if np.any(high <= low):
        raise GeometryValidationError("Physical crop must have positive extent in all axes.")
    if np.any(high < -1e-6) or np.any(low > source_shape - 1.0 + 1e-6):
        raise GeometryValidationError("Physical crop does not intersect the CT volume.")
    return np.clip(low, 0.0, source_shape - 1.0), np.clip(high, 0.0, source_shape - 1.0)


@dataclass(frozen=True, slots=True)
class SelectionManifest:
    plane: PlaneName
    mode: SelectionMode
    crop_min_lps: Vec3
    crop_max_lps: Vec3
    source_bounds_voxel_xyz: tuple[Vec3, Vec3]
    selected_source_indices: tuple[int, ...]
    stride: int
    print_size_mm: Vec3
    layer_height_mm: float
    source_to_print_transform: tuple[tuple[float, ...], ...]
    resampling: str
    plate_layout: dict[str, Any]
    structural_regions: tuple[dict[str, Any], ...]
    source_hash: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": "voxelweave.selection-manifest.v1",
            "plane": self.plane,
            "mode": self.mode,
            "crop_min_lps": list(self.crop_min_lps),
            "crop_max_lps": list(self.crop_max_lps),
            "source_bounds_voxel_xyz": [list(self.source_bounds_voxel_xyz[0]), list(self.source_bounds_voxel_xyz[1])],
            "selected_source_indices": list(self.selected_source_indices),
            "stride": self.stride,
            "print_size_mm": list(self.print_size_mm),
            "layer_height_mm": self.layer_height_mm,
            "source_to_print_transform": [list(row) for row in self.source_to_print_transform],
            "resampling": self.resampling,
            "plate_layout": canonicalize(self.plate_layout),
            "structural_regions": [canonicalize(item) for item in self.structural_regions],
            "source_hash": self.source_hash,
            "physical_fidelity_claim": "not_established_by_software",
        }


@dataclass(slots=True)
class PrintSelection:
    volume: Volume
    plane: PlaneName
    mode: SelectionMode
    source_bounds_low_xyz: np.ndarray
    source_bounds_high_xyz: np.ndarray
    selected_source_indices: tuple[int, ...]
    print_size_mm: Vec3
    layer_height_mm: float
    stride: int
    plate_layout: dict[str, Any]
    structural_regions: tuple[dict[str, Any], ...]
    manifest: SelectionManifest

    @property
    def layer_count(self) -> int:
        return max(1, int(math.ceil(self.print_size_mm[2] / self.layer_height_mm - 1e-12)))

    @property
    def source_axes(self) -> tuple[int, int, int]:
        return _axis_map(self.plane)

    def _source_voxel_xyz(self, x_mm: float, y_mm: float, z_mm: float, *, tile_index: int | None = None) -> np.ndarray:
        if not (0.0 <= x_mm <= self.print_size_mm[0] + 1e-6 and 0.0 <= y_mm <= self.print_size_mm[1] + 1e-6 and 0.0 <= z_mm <= self.print_size_mm[2] + 1e-6):
            raise GeometryValidationError("Print sample is outside the selected physical crop.")
        axes = self.source_axes
        source = np.zeros(3, dtype=np.float64)
        for print_coord, axis, size in ((x_mm, axes[0], self.print_size_mm[0]), (y_mm, axes[1], self.print_size_mm[1])):
            fraction = 0.0 if size <= 0 else np.clip(print_coord / size, 0.0, 1.0)
            source[axis] = self.source_bounds_low_xyz[axis] + fraction * (self.source_bounds_high_xyz[axis] - self.source_bounds_low_xyz[axis])
        if self.mode == "single":
            source[axes[2]] = float(self.selected_source_indices[0])
        elif self.mode == "continuous":
            fraction = 0.0 if self.print_size_mm[2] <= 0 else np.clip(z_mm / self.print_size_mm[2], 0.0, 1.0)
            source[axes[2]] = self.source_bounds_low_xyz[axes[2]] + fraction * (self.source_bounds_high_xyz[axes[2]] - self.source_bounds_low_xyz[axes[2]])
        else:
            chosen = tile_index if tile_index is not None else 0
            if chosen < 0 or chosen >= len(self.selected_source_indices):
                raise GeometryValidationError("Tile index is outside the inclusive tile selection.")
            source[axes[2]] = float(self.selected_source_indices[chosen])
        return source

    def source_position_lps(self, x_mm: float, y_mm: float, z_mm: float, *, tile_index: int | None = None) -> Vec3:
        source = self._source_voxel_xyz(x_mm, y_mm, z_mm, tile_index=tile_index)
        return cast(Vec3, tuple(float(item) for item in self.volume.voxel_to_lps(tuple(float(value) for value in source))))

    def sample_hu(self, x_mm: float, y_mm: float, z_mm: float, *, tile_index: int | None = None, method: str = "linear") -> float:
        return self.volume.sample(self.source_position_lps(x_mm, y_mm, z_mm, tile_index=tile_index), method=method)

    def rail_sample_position(self, x_mm: float, y_mm: float, z_mm: float, *, tile_index: int | None = None) -> Vec3:
        return self.source_position_lps(x_mm, y_mm, z_mm, tile_index=tile_index)

    def to_dict(self) -> dict[str, Any]:
        return self.manifest.to_dict()


def _transform_for_selection(
    volume: Volume,
    plane: PlaneName,
    low: np.ndarray,
    high: np.ndarray,
    print_size: Vec3,
) -> tuple[tuple[float, ...], ...]:
    axes = _axis_map(plane)
    origin = volume.voxel_to_lps(tuple(float(value) for value in low))
    matrix = np.eye(4, dtype=np.float64)
    matrix[:3, 3] = origin
    for print_axis, source_axis in enumerate(axes):
        source_extent_mm = (high[source_axis] - low[source_axis]) * volume.spacing_mm[2 - source_axis] if source_axis < 2 else (high[source_axis] - low[source_axis]) * volume.spacing_mm[0]
        matrix[:3, print_axis] = volume.direction_lps[:, source_axis] * (source_extent_mm / print_size[print_axis])
    return tuple(tuple(float(f"{item:.12g}") for item in row) for row in matrix)


def create_print_selection(
    volume: Volume,
    *,
    plane: PlaneName,
    mode: SelectionMode,
    crop_min_lps: Vec3 | None = None,
    crop_max_lps: Vec3 | None = None,
    plane_index: int | None = None,
    start_index: int | None = None,
    end_index: int | None = None,
    thickness_mm: float | None = None,
    print_size_mm: Vec3 | None = None,
    layer_height_mm: float = 0.2,
    stride: int = 1,
    plate_layout: dict[str, Any] | None = None,
    labels: Sequence[str] | None = None,
) -> PrintSelection:
    if mode not in {"single", "continuous", "tile"}:
        raise GeometryValidationError("Selection mode must be single, continuous, or tile.")
    if layer_height_mm <= 0 or stride <= 0:
        raise GeometryValidationError("Layer height and tile stride must be positive.")
    low, high = _source_bounds_from_crop(volume, crop_min_lps, crop_max_lps)
    axes = _axis_map(plane)
    normal_axis = axes[2]
    source_count = volume.shape_zyx[::-1][normal_axis]
    source_low = int(round(low[normal_axis]))
    source_high = int(round(high[normal_axis]))
    if mode == "single":
        selected = (source_low + source_high) // 2 if plane_index is None else int(plane_index)
        if selected < 0 or selected >= source_count:
            raise GeometryValidationError("Single-plane source index is outside the CT volume.")
        selected_indices: tuple[int, ...] = (selected,)
        depth_mm = float(thickness_mm if thickness_mm is not None else volume.spacing_mm[2 - normal_axis])
        if depth_mm <= 0:
            raise GeometryValidationError("Single-plane print thickness must be positive.")
    else:
        start = source_low if start_index is None else int(start_index)
        end = source_high if end_index is None else int(end_index)
        if start < 0 or end >= source_count or end < start:
            raise GeometryValidationError("Selected source range must be an inclusive in-volume index range.")
        selected_indices = tuple(range(start, end + 1, stride))
        if not selected_indices:
            raise GeometryValidationError("Selected source range produced no planes.")
        axis_spacing = volume.spacing_mm[2 - normal_axis]
        depth_mm = axis_spacing if mode == "tile" else float((end - start + 1) * axis_spacing)
    inplane_axes = axes[:2]
    natural_size = tuple(float((high[axis] - low[axis] + 1.0) * (volume.spacing_mm[2 - axis] if axis < 2 else volume.spacing_mm[0])) for axis in inplane_axes)
    if any(item <= 0 for item in natural_size):
        raise GeometryValidationError("Print selection crop has no positive in-plane extent.")
    requested_size = cast(Vec3, print_size_mm or (natural_size[0], natural_size[1], depth_mm))
    if len(requested_size) != 3 or any(float(item) <= 0 or not math.isfinite(float(item)) for item in requested_size):
        raise GeometryValidationError("Print size must contain three positive finite dimensions.")
    requested_size = cast(Vec3, tuple(float(item) for item in requested_size))
    plate = dict(plate_layout or {})
    if mode == "tile":
        columns = max(1, int(plate.get("columns", min(len(selected_indices), 4))))
        plate.setdefault("columns", columns)
        plate.setdefault("rows", int(math.ceil(len(selected_indices) / columns)))
        plate.setdefault("tile_spacing_mm", [2.0, 2.0])
        plate.setdefault("tile_size_mm", [requested_size[0], requested_size[1]])
    structural = tuple(
        {
            "label": labels[index] if labels and index < len(labels) else f"tile-{index + 1:03d}",
            "tile_index": index,
            "region": "structural_outside_measurement_roi",
        }
        for index in range(len(selected_indices))
    ) if mode == "tile" else ()
    transform = _transform_for_selection(volume, plane, low, high, requested_size)
    crop_min = cast(Vec3, tuple(float(item) for item in volume.voxel_to_lps(tuple(float(value) for value in low))))
    crop_max = cast(Vec3, tuple(float(item) for item in volume.voxel_to_lps(tuple(float(value) for value in high))))
    low_tuple = cast(Vec3, tuple(float(item) for item in low))
    high_tuple = cast(Vec3, tuple(float(item) for item in high))
    manifest = SelectionManifest(
        plane=plane,
        mode=mode,
        crop_min_lps=crop_min,
        crop_max_lps=crop_max,
        source_bounds_voxel_xyz=(low_tuple, high_tuple),
        selected_source_indices=selected_indices,
        stride=stride,
        print_size_mm=requested_size,
        layer_height_mm=float(layer_height_mm),
        source_to_print_transform=transform,
        resampling="full_resolution_signed_hu_at_printer_layer_centers" if mode == "continuous" else "full_resolution_signed_hu_plane_sampling",
        plate_layout=plate,
        structural_regions=structural,
        source_hash=volume.source_hash,
    )
    return PrintSelection(volume, plane, mode, low, high, selected_indices, requested_size, float(layer_height_mm), stride, plate, structural, manifest)
