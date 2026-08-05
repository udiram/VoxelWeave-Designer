"""Deterministic alternating-road toolpath generation and reverse audit."""

from __future__ import annotations

import hashlib
import json
import math
import re
import zipfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

import numpy as np

from .binary import write_binary_array
from .calibration import Calibration, CalibrationBinding, CalibrationSet
from .errors import CalibrationMismatchError, GeometryValidationError, ToolpathAuditError
from .models import CancellationToken, ProgressCallback, Vec3, canonicalize
from .selection import PrintSelection


@dataclass(frozen=True, slots=True)
class PrinterProfile:
    printer: str = "Prusa XL"
    build_volume_mm: Vec3 = (360.0, 360.0, 360.0)
    filament_diameter_mm: float = 1.75
    max_flow_mm3_s: float = 12.0
    min_print_speed_mm_min: float = 300.0
    max_print_speed_mm_min: float = 3600.0
    min_line_width_mm: float = 0.05
    max_line_width_mm: float = 1.0
    sample_step_mm: float = 2.0
    wrapper_id: str = "voxelweave.prusa-xl.wrapper.v1"
    # Wrapper controls are explicit and deterministic.  Heating remains off by
    # default because generating a research artifact must not implicitly start
    # a thermal/print operation when the file is later opened on a printer.
    home_before_print: bool = True
    heat_nozzle: bool = False
    nozzle_temperature_c: float = 0.0
    heat_bed: bool = False
    bed_temperature_c: float = 0.0
    prime_enabled: bool = False
    prime_length_mm: float = 0.0
    first_layer_speed_scale: float = 0.5
    park_after_print: bool = True
    park_position_mm: Vec3 = (0.0, 0.0, 5.0)

    def __post_init__(self) -> None:
        if any(float(item) <= 0 for item in self.build_volume_mm) or self.filament_diameter_mm <= 0 or self.max_flow_mm3_s <= 0:
            raise GeometryValidationError("Printer profile dimensions and flow limits must be positive.")
        if self.min_line_width_mm <= 0 or self.max_line_width_mm < self.min_line_width_mm or self.sample_step_mm <= 0:
            raise GeometryValidationError("Printer profile width and sampling limits are invalid.")
        if not 0.0 < self.first_layer_speed_scale <= 1.0 or not math.isfinite(self.first_layer_speed_scale):
            raise GeometryValidationError("First-layer speed scale must be finite and in (0, 1].")
        if self.heat_nozzle and self.nozzle_temperature_c <= 0:
            raise GeometryValidationError("A positive nozzle temperature is required when nozzle heating is enabled.")
        if self.heat_bed and self.bed_temperature_c <= 0:
            raise GeometryValidationError("A positive bed temperature is required when bed heating is enabled.")
        if self.prime_enabled and self.prime_length_mm <= 0:
            raise GeometryValidationError("A positive prime length is required when priming is enabled.")
        if len(self.park_position_mm) != 3 or any(not math.isfinite(float(item)) for item in self.park_position_mm):
            raise GeometryValidationError("Park position must contain three finite coordinates.")
        if any(float(item) < 0 or float(item) > float(limit) for item, limit in zip(self.park_position_mm, self.build_volume_mm, strict=True)):
            raise GeometryValidationError("Park position must remain inside the configured build volume.")


@dataclass(frozen=True, slots=True)
class ToolpathSegment:
    segment_index: int
    layer_index: int
    tile_index: int | None
    start_xy_mm: tuple[float, float]
    end_xy_mm: tuple[float, float]
    z_mm: float
    source_position_lps: Vec3
    source_hu: float
    target_hu: float
    clipped_hu: float
    commanded_width_mm: float
    effective_fill: float
    feedrate_mm_min: float
    extrusion_mm: float
    tool: str
    material: str
    calibration_id: str
    region: str = "measurement_roi"
    range_status: str = "in_range"

    @property
    def length_mm(self) -> float:
        return math.hypot(self.end_xy_mm[0] - self.start_xy_mm[0], self.end_xy_mm[1] - self.start_xy_mm[1])

    def to_dict(self) -> dict[str, Any]:
        return {
            "segment_index": self.segment_index,
            "layer_index": self.layer_index,
            "tile_index": self.tile_index,
            "start_xy_mm": list(self.start_xy_mm),
            "end_xy_mm": list(self.end_xy_mm),
            "z_mm": self.z_mm,
            "source_position_lps": list(self.source_position_lps),
            "source_hu": self.source_hu,
            "target_hu": self.target_hu,
            "clipped_hu": self.clipped_hu,
            "commanded_width_mm": self.commanded_width_mm,
            "effective_fill": self.effective_fill,
            "feedrate_mm_min": self.feedrate_mm_min,
            "extrusion_mm": self.extrusion_mm,
            "tool": self.tool,
            "material": self.material,
            "calibration_id": self.calibration_id,
            "region": self.region,
            "range_status": self.range_status,
        }


@dataclass(frozen=True, slots=True)
class AuditReport:
    passed: bool
    errors: tuple[str, ...]
    warnings: tuple[str, ...]
    wrapper_id: str | None
    segment_count: int
    extrusion_move_count: int
    tool_changes: tuple[str, ...]
    tool_change_count: int
    bounds_xyz: tuple[Vec3, Vec3] | None
    checked_expected_segments: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": "voxelweave.gcode-audit.v1",
            "passed": self.passed,
            "errors": list(self.errors),
            "warnings": list(self.warnings),
            "wrapper_id": self.wrapper_id,
            "segment_count": self.segment_count,
            "extrusion_move_count": self.extrusion_move_count,
            "tool_changes": list(self.tool_changes),
            "tool_change_count": self.tool_change_count,
            "bounds_xyz": None if self.bounds_xyz is None else [list(self.bounds_xyz[0]), list(self.bounds_xyz[1])],
            "checked_expected_segments": self.checked_expected_segments,
        }


@dataclass(frozen=True, slots=True)
class GeneratedToolpath:
    selection: PrintSelection
    segments: tuple[ToolpathSegment, ...]
    gcode_text: str
    preview_records: np.ndarray
    calibration_ids: tuple[str, ...]
    profile: PrinterProfile
    report: dict[str, Any]

    @property
    def gcode_sha256(self) -> str:
        return hashlib.sha256(self.gcode_text.encode("ascii")).hexdigest()

    @property
    def preview_sha256(self) -> str:
        return hashlib.sha256(self.preview_records.tobytes(order="C")).hexdigest()

    def audit(self) -> AuditReport:
        return reverse_audit_gcode(self.gcode_text, expected=self, profile=self.profile)


_PREVIEW_DTYPE = np.dtype(
    [
        ("segment_index", "<i8"),
        ("layer_index", "<i4"),
        ("tile_index", "<i4"),
        ("start_x", "<f8"),
        ("start_y", "<f8"),
        ("end_x", "<f8"),
        ("end_y", "<f8"),
        ("z", "<f8"),
        ("source_hu", "<f8"),
        ("target_hu", "<f8"),
        ("width", "<f8"),
        ("fill", "<f8"),
        ("feedrate", "<f8"),
        ("extrusion", "<f8"),
        ("tool_index", "<i4"),
    ],
    align=False,
)


def _positions(max_mm: float, pitch_mm: float) -> list[float]:
    if max_mm <= 0 or pitch_mm <= 0:
        return []
    values = [float(item) for item in np.arange(pitch_mm / 2.0, max_mm - 1e-9, pitch_mm, dtype=np.float64)]
    return values or [float(max_mm / 2.0)]


def _line_segments(start: float, end: float, step_mm: float) -> list[tuple[float, float]]:
    length = abs(end - start)
    count = max(1, int(math.ceil(length / step_mm)))
    increment = (end - start) / count
    return [(start + index * increment, start + (index + 1) * increment) for index in range(count)]


CalibrationInput = Calibration | CalibrationSet | Mapping[str, Calibration] | Sequence[Calibration]


def _resolve_calibration(calibration: CalibrationInput, tool: str | None = None) -> Calibration:
    if isinstance(calibration, Calibration):
        result = calibration
    elif isinstance(calibration, CalibrationSet):
        if tool is None:
            if len(calibration.calibrations) != 1:
                raise CalibrationMismatchError("Generation requires one explicitly bound calibration per tool.")
            result = calibration.calibrations[0]
        else:
            matches = [item for item in calibration.calibrations if item.binding.tool == tool]
            if len(matches) != 1:
                raise CalibrationMismatchError("Generation requires exactly one accepted calibration for the selected tool.")
            result = matches[0]
    elif isinstance(calibration, Mapping):
        if tool is None or tool not in calibration:
            raise CalibrationMismatchError("Generation requires an explicit calibration for the selected tool.")
        result = calibration[tool]
    else:
        values = tuple(calibration)
        if tool is None and len(values) == 1:
            result = values[0]
        else:
            matches = [item for item in values if item.binding.tool == tool]
            if len(matches) != 1:
                raise CalibrationMismatchError("Generation requires exactly one accepted calibration for the selected tool.")
            result = matches[0]
    if not result.accepted:
        raise CalibrationMismatchError("Generation cannot use an unaccepted calibration.")
    return result


def _calibration_by_tool(calibration: CalibrationInput) -> dict[str, Calibration]:
    if isinstance(calibration, Calibration):
        return {calibration.binding.tool: calibration}
    if isinstance(calibration, CalibrationSet):
        values = tuple(calibration.calibrations)
    elif isinstance(calibration, Mapping):
        values = tuple(calibration.values())
    else:
        values = tuple(calibration)
    result: dict[str, Calibration] = {}
    for item in values:
        tool_name = item.binding.tool
        if tool_name in result and result[tool_name].calibration_id != item.calibration_id:
            raise CalibrationMismatchError(f"More than one accepted calibration is bound to tool {tool_name}.")
        result[tool_name] = item
    if not result:
        raise CalibrationMismatchError("At least one accepted calibration is required.")
    return result


def _owner_tool(value: object) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    token = text.split(":", 1)[0].strip()
    return token if re.fullmatch(r"T\d+", token) else None


def _region_bounds(region: Mapping[str, Any]) -> tuple[float, float, float, float] | None:
    candidate = region.get("bounds_mm") or region.get("bounds")
    if isinstance(candidate, Mapping):
        values = (candidate.get("x_min"), candidate.get("y_min"), candidate.get("x_max"), candidate.get("y_max"))
    elif isinstance(candidate, (list, tuple)) and len(candidate) == 4:
        values = tuple(candidate)
    elif isinstance(region.get("x_range_mm"), (list, tuple)) and isinstance(region.get("y_range_mm"), (list, tuple)):
        x_range = cast(Sequence[Any], region["x_range_mm"])
        y_range = cast(Sequence[Any], region["y_range_mm"])
        if len(x_range) != 2 or len(y_range) != 2:
            raise GeometryValidationError("Region x_range_mm and y_range_mm must contain two coordinates each.")
        values = (x_range[0], y_range[0], x_range[1], y_range[1])
    else:
        values = (
            region.get("x_min_mm", region.get("min_x_mm")),
            region.get("y_min_mm", region.get("min_y_mm")),
            region.get("x_max_mm", region.get("max_x_mm")),
            region.get("y_max_mm", region.get("max_y_mm")),
        )
    if any(item is None for item in values):
        return None
    try:
        result = tuple(float(cast(Any, item)) for item in values)
    except (TypeError, ValueError):
        raise GeometryValidationError("Region bounds must contain four finite coordinates.") from None
    if len(result) != 4 or not all(math.isfinite(item) for item in result) or result[2] <= result[0] or result[3] <= result[1]:
        raise GeometryValidationError("Region bounds must be finite and increasing.")
    return result


def _dispatch_regions(selection: PrintSelection, scene: Mapping[str, Any] | None) -> tuple[dict[str, Any], ...]:
    """Return explicit region/tool ownership for deterministic multi-tool dispatch."""

    values: list[dict[str, Any]] = []
    for item in selection.structural_regions:
        if isinstance(item, Mapping):
            values.append(dict(item))
    if scene is not None:
        scene_regions = scene.get("regions", [])
        if not isinstance(scene_regions, list):
            raise GeometryValidationError("Scene regions must be an array for tool dispatch.")
        values.extend(dict(item) for item in scene_regions if isinstance(item, Mapping))
    normalized: list[dict[str, Any]] = []
    for item in values:
        owner = _owner_tool(item.get("tool") or item.get("owner"))
        region_name = str(item.get("region") or item.get("id") or "").strip()
        if owner is None or not region_name:
            continue
        if "measurement" in region_name.lower() or ":measurement" in str(item.get("owner", "")).lower():
            region_name = "measurement_roi"
        normalized.append({"region": region_name, "tool": owner, "bounds": _region_bounds(item), "owner": str(item.get("owner", owner))})
    return tuple(normalized)


def _tool_for_sample(
    *,
    x_mm: float,
    y_mm: float,
    default_region: str,
    available_tools: Mapping[str, Calibration],
    regions: Sequence[Mapping[str, Any]],
    explicit_tool: str | None,
) -> str:
    if explicit_tool is not None:
        if explicit_tool not in available_tools:
            raise CalibrationMismatchError(f"No accepted calibration is bound to explicit tool {explicit_tool}.")
        return explicit_tool
    matches: list[str] = []
    for item in regions:
        bounds = item.get("bounds")
        if bounds is not None:
            low_x, low_y, high_x, high_y = cast(tuple[float, float, float, float], bounds)
            if low_x - 1e-9 <= x_mm <= high_x + 1e-9 and low_y - 1e-9 <= y_mm <= high_y + 1e-9:
                matches.append(str(item["tool"]))
        elif str(item.get("region")) in {default_region, "measurement", "measurement_roi", "measurement_roi_tile"}:
            matches.append(str(item["tool"]))
    unique = tuple(dict.fromkeys(matches))
    if len(unique) == 1:
        if unique[0] not in available_tools:
            raise CalibrationMismatchError(f"No accepted calibration is bound to explicitly owned tool {unique[0]}.")
        return unique[0]
    if len(unique) > 1:
        raise CalibrationMismatchError(f"Region ownership is ambiguous at print coordinate ({x_mm:g}, {y_mm:g}).")
    if len(available_tools) == 1:
        return next(iter(available_tools))
    raise CalibrationMismatchError(
        f"No explicit calibration ownership covers measurement region {default_region}; refusing implicit multi-tool dispatch."
    )


def _profile_binding(selection: PrintSelection, calibration: Calibration, profile: PrinterProfile) -> CalibrationBinding:
    binding = calibration.binding
    if abs(binding.layer_height_mm - selection.layer_height_mm) > 1e-6:
        raise CalibrationMismatchError("Selection layer height does not match the accepted calibration.")
    if not math.isfinite(binding.pitch_mm) or binding.pitch_mm <= 0:
        raise CalibrationMismatchError("Calibration pitch is not finite and positive.")
    if binding.printer != profile.printer:
        raise CalibrationMismatchError("Calibration printer identity does not match the selected printer profile.")
    return binding


def _extrusion_and_feedrate(
    length: float,
    width: float,
    layer_height: float,
    profile: PrinterProfile,
    calibration_flow_mm3_s: float,
) -> tuple[float, float]:
    filament_area = math.pi * (profile.filament_diameter_mm / 2.0) ** 2
    volume = length * width * layer_height
    if length <= 0 or width <= 0 or layer_height <= 0:
        raise GeometryValidationError("Printable segment length, width, and layer height must be positive.")
    max_flow = min(profile.max_flow_mm3_s, calibration_flow_mm3_s)
    # The volumetric cap is a hard safety limit.  A minimum-speed preference
    # must never be clamped back up when a wide road/layer would require a
    # slower feed to stay below that cap.
    max_feed = max_flow * 60.0 / (width * layer_height)
    feed = min(profile.max_print_speed_mm_min, max_feed)
    if not math.isfinite(feed) or feed <= 0:
        raise GeometryValidationError("No positive feedrate satisfies the configured volumetric-flow cap.")
    extrusion = volume / filament_area
    return extrusion, feed


def _segment_comment(segment: ToolpathSegment) -> str:
    tile = -1 if segment.tile_index is None else segment.tile_index
    return (
        f"; VW_SEG index={segment.segment_index} layer={segment.layer_index} tile={tile} tool={segment.tool} "
        f"width={segment.commanded_width_mm:.8f} hu={segment.source_hu:.8f} target_hu={segment.target_hu:.8f} "
        f"region={segment.region} start_x={segment.start_xy_mm[0]:.8f} start_y={segment.start_xy_mm[1]:.8f}"
    )


def _format_gcode(
    segments: Sequence[ToolpathSegment],
    profile: PrinterProfile,
    source_hash: str,
    *,
    layer_height_mm: float,
    calibration_flows_mm3_s: Mapping[str, float],
) -> str:
    first_flow = next(iter(calibration_flows_mm3_s.values()))
    lines = [
        "; VoxelWeave Designer research-use deterministic toolpath",
        "; VW_BEGIN",
        f"; VW_WRAPPER_ID={profile.wrapper_id}",
        f"; VW_SOURCE_HASH={source_hash}",
        "; VW_WRAPPER_CONTRACT=prusa-xl-safe-research-v2",
        f"; VW_HOME_BEFORE_PRINT={int(profile.home_before_print)}",
        f"; VW_HEAT_NOZZLE={int(profile.heat_nozzle)}",
        f"; VW_NOZZLE_TEMPERATURE_C={profile.nozzle_temperature_c:.3f}",
        f"; VW_HEAT_BED={int(profile.heat_bed)}",
        f"; VW_BED_TEMPERATURE_C={profile.bed_temperature_c:.3f}",
        f"; VW_PRIME_ENABLED={int(profile.prime_enabled)}",
        f"; VW_PRIME_LENGTH_MM={profile.prime_length_mm:.6f}",
        f"; VW_FIRST_LAYER_SPEED_SCALE={profile.first_layer_speed_scale:.6f}",
        f"; VW_PARK_AFTER_PRINT={int(profile.park_after_print)}",
        f"; VW_PARK_POSITION_MM={profile.park_position_mm[0]:.5f},{profile.park_position_mm[1]:.5f},{profile.park_position_mm[2]:.5f}",
        f"; VW_MAX_FLOW_MM3_S={profile.max_flow_mm3_s:.9g}",
        f"; VW_CALIBRATION_FLOW_MM3_S={first_flow:.9g}",
        f"; VW_LAYER_HEIGHT_MM={layer_height_mm:.9g}",
        f"; VW_FILAMENT_DIAMETER_MM={profile.filament_diameter_mm:.9g}",
        "; VW_SCIENTIFIC_BOUNDARY=software_audit_does_not_establish_physical_fidelity",
        "G90",
        "M82",
        "G21",
        "G92 E0",
    ]
    for flow_tool in sorted(calibration_flows_mm3_s):
        lines.insert(20, f"; VW_CALIBRATION_FLOW_MM3_S_{flow_tool}={calibration_flows_mm3_s[flow_tool]:.9g}")
    if profile.home_before_print:
        lines.append("G28")
    if profile.heat_bed:
        lines.extend([f"M140 S{profile.bed_temperature_c:.1f}", f"M190 S{profile.bed_temperature_c:.1f}"])
    if profile.heat_nozzle:
        lines.extend([f"M104 S{profile.nozzle_temperature_c:.1f}", f"M109 S{profile.nozzle_temperature_c:.1f}"])
    # Priming is represented as an explicit control marker.  Actual extrusion
    # remains disabled by default and is intentionally not mixed into the
    # audited measurement stream.
    if profile.prime_enabled:
        prime_width = max(profile.min_line_width_mm, min(profile.max_line_width_mm, profile.filament_diameter_mm * 0.5))
        prime_feed = min(
            profile.max_print_speed_mm_min,
            min(profile.max_flow_mm3_s, first_flow) * 60.0 / max(prime_width * layer_height_mm, 1e-9),
        )
        prime_feed = math.floor(prime_feed * 1000.0) / 1000.0
        prime_e = profile.prime_length_mm * prime_width * layer_height_mm / (math.pi * (profile.filament_diameter_mm / 2.0) ** 2)
        prime_y = max(0.0, profile.build_volume_mm[1] - prime_width)
        lines.extend(
            [
                "; VW_PRIME_BEGIN",
                f"; VW_AUX_PRIME start_x=0.00000 start_y={prime_y:.5f} width={prime_width:.8f}",
                f"G0 X0.00000 Y{prime_y:.5f} Z{layer_height_mm:.5f}",
                f"G1 X{profile.prime_length_mm:.5f} Y{prime_y:.5f} Z{layer_height_mm:.5f} E{prime_e:.8f} F{prime_feed:.3f}",
                "; VW_PRIME_END",
            ]
        )
    else:
        prime_e = 0.0
    cumulative_e = prime_e
    current_tool: str | None = None
    previous_end: tuple[float, float] | None = None
    previous_z: float | None = None
    for segment in segments:
        if current_tool != segment.tool:
            if current_tool is not None:
                lines.append(f"; VW_TOOL_CHANGE from={current_tool} to={segment.tool} safe=1")
                lines.append(f"G0 X0.00000 Y0.00000 Z{min(5.0, profile.build_volume_mm[2]):.5f}")
            lines.append(f"{segment.tool}")
            lines.append(f"; VW_TOOL_FLOW tool={segment.tool} mm3_s={calibration_flows_mm3_s[segment.tool]:.9g}")
            current_tool = segment.tool
        start_x, start_y = segment.start_xy_mm
        if previous_end is None or previous_z != segment.z_mm or math.hypot(previous_end[0] - start_x, previous_end[1] - start_y) > 1e-7:
            lines.append(f"G0 X{start_x:.5f} Y{start_y:.5f} Z{segment.z_mm:.5f}")
        cumulative_e += segment.extrusion_mm
        lines.append(_segment_comment(segment))
        lines.append(
            f"G1 X{segment.end_xy_mm[0]:.5f} Y{segment.end_xy_mm[1]:.5f} Z{segment.z_mm:.5f} "
            f"E{cumulative_e:.8f} F{segment.feedrate_mm_min:.3f}"
        )
        previous_end = segment.end_xy_mm
        previous_z = segment.z_mm
    if profile.park_after_print:
        px, py, pz = profile.park_position_mm
        lines.append(f"G0 X{px:.5f} Y{py:.5f} Z{pz:.5f}")
    lines.extend(["; VW_END", "M104 S0", "M140 S0", "M84"])
    return "\n".join(lines) + "\n"


def _preview_records(segments: Sequence[ToolpathSegment], tools: Sequence[str]) -> np.ndarray:
    records = np.zeros(len(segments), dtype=_PREVIEW_DTYPE)
    for index, segment in enumerate(segments):
        records[index] = (
            segment.segment_index,
            segment.layer_index,
            -1 if segment.tile_index is None else segment.tile_index,
            segment.start_xy_mm[0],
            segment.start_xy_mm[1],
            segment.end_xy_mm[0],
            segment.end_xy_mm[1],
            segment.z_mm,
            segment.source_hu,
            segment.target_hu,
            segment.commanded_width_mm,
            segment.effective_fill,
            segment.feedrate_mm_min,
            segment.extrusion_mm,
            tools.index(segment.tool),
        )
    return records


def generate_toolpath(
    selection: PrintSelection,
    calibration: CalibrationInput,
    *,
    profile: PrinterProfile | None = None,
    tool: str | None = None,
    scene: Mapping[str, Any] | None = None,
    allow_calibration_clipping: bool = False,
    acknowledge_calibration_clipping: bool = False,
    request_id: str = "toolpath",
    progress: ProgressCallback | None = None,
    cancellation: CancellationToken | None = None,
) -> GeneratedToolpath:
    profile = profile or PrinterProfile()
    if allow_calibration_clipping and not acknowledge_calibration_clipping:
        raise CalibrationMismatchError(
            "Calibration clipping is fail-closed; set acknowledge_calibration_clipping=True to export clipped output."
        )
    calibrations = _calibration_by_tool(calibration)
    if tool is not None and tool not in calibrations:
        raise CalibrationMismatchError(f"No accepted calibration is bound to explicit tool {tool}.")
    for candidate in calibrations.values():
        _profile_binding(selection, candidate, profile)
    regions = _dispatch_regions(selection, scene)
    width_limit = (profile.min_line_width_mm, profile.max_line_width_mm)
    segments: list[ToolpathSegment] = []
    tile_count = len(selection.selected_source_indices) if selection.mode == "tile" else 1
    columns = int(selection.plate_layout.get("columns", tile_count)) if selection.mode == "tile" else 1
    tile_spacing = tuple(float(item) for item in selection.plate_layout.get("tile_spacing_mm", [2.0, 2.0])) if selection.mode == "tile" else (0.0, 0.0)
    tile_size = selection.print_size_mm[:2]

    def tile_plate_offset(tile: int) -> tuple[float, float]:
        return (
            (tile % columns) * (tile_size[0] + tile_spacing[0]),
            (tile // columns) * (tile_size[1] + tile_spacing[1]),
        )

    positions_x = _positions(selection.print_size_mm[0], min(item.binding.pitch_mm for item in calibrations.values()))
    positions_y = _positions(selection.print_size_mm[1], min(item.binding.pitch_mm for item in calibrations.values()))
    total_layers = selection.layer_count * tile_count
    completed = 0
    clipped_count = 0
    clipped_by_layer: dict[str, int] = {}
    clipped_by_tile: dict[str, int] = {}
    clipped_by_region: dict[str, int] = {}
    used_calibrations: dict[str, Calibration] = {}
    for tile_index in range(tile_count):
        offset_x, offset_y = tile_plate_offset(tile_index)
        for layer_index in range(selection.layer_count):
            if cancellation:
                cancellation.checkpoint()
            z_sample = min(selection.print_size_mm[2], (layer_index + 0.5) * selection.layer_height_mm)
            z_print = z_sample
            direction_x = layer_index % 2 == 0
            for line_number, line_coordinate in enumerate(positions_y if direction_x else positions_x):
                if direction_x:
                    start, end = (0.0, selection.print_size_mm[0]) if line_number % 2 == 0 else (selection.print_size_mm[0], 0.0)
                else:
                    start, end = (0.0, selection.print_size_mm[1]) if line_number % 2 == 0 else (selection.print_size_mm[1], 0.0)
                for a, b in _line_segments(start, end, profile.sample_step_mm):
                    midpoint = (a + b) / 2.0
                    x, y = (midpoint, line_coordinate) if direction_x else (line_coordinate, midpoint)
                    region_name = "measurement_roi_tile" if selection.mode == "tile" else "measurement_roi"
                    active_tool = _tool_for_sample(
                        x_mm=x,
                        y_mm=y,
                        default_region=region_name,
                        available_tools=calibrations,
                        regions=regions,
                        explicit_tool=tool,
                    )
                    selected_calibration = calibrations[active_tool]
                    used_calibrations[active_tool] = selected_calibration
                    pitch = selected_calibration.binding.pitch_mm
                    source_position = selection.rail_sample_position(x, y, z_sample, tile_index=tile_index if selection.mode == "tile" else None)
                    source_hu = selection.sample_hu(x, y, z_sample, tile_index=tile_index if selection.mode == "tile" else None)
                    clipped_hu, widths, range_status = selected_calibration.map_hu(np.asarray([source_hu]), allow_clipping=allow_calibration_clipping)
                    width = float(np.clip(widths[0], width_limit[0], width_limit[1]))
                    local_start = (a, line_coordinate) if direction_x else (line_coordinate, a)
                    local_end = (b, line_coordinate) if direction_x else (line_coordinate, b)
                    extrusion, feedrate = _extrusion_and_feedrate(
                        math.hypot(b - a, 0.0), width, selection.layer_height_mm, profile, selected_calibration.binding.effective_flow_mm3_s
                    )
                    if layer_index == 0:
                        feedrate *= profile.first_layer_speed_scale
                    feedrate = math.floor(feedrate * 1000.0) / 1000.0
                    if range_status == "clipped":
                        clipped_count += 1
                        clipped_by_layer[str(layer_index)] = clipped_by_layer.get(str(layer_index), 0) + 1
                        tile_key = str(tile_index if selection.mode == "tile" else 0)
                        clipped_by_tile[tile_key] = clipped_by_tile.get(tile_key, 0) + 1
                        clipped_by_region[region_name] = clipped_by_region.get(region_name, 0) + 1
                    segments.append(
                        ToolpathSegment(
                            segment_index=len(segments),
                            layer_index=layer_index,
                            tile_index=tile_index if selection.mode == "tile" else None,
                            start_xy_mm=(local_start[0] + offset_x, local_start[1] + offset_y),
                            end_xy_mm=(local_end[0] + offset_x, local_end[1] + offset_y),
                            z_mm=z_print,
                            source_position_lps=source_position,
                            source_hu=float(source_hu),
                            target_hu=float(source_hu),
                            clipped_hu=float(clipped_hu[0]),
                            commanded_width_mm=width,
                            effective_fill=float(width / pitch),
                            feedrate_mm_min=float(feedrate),
                            extrusion_mm=float(extrusion),
                            tool=active_tool,
                            material=selected_calibration.binding.material,
                            calibration_id=selected_calibration.calibration_id,
                            region=region_name,
                            range_status=range_status,
                        )
                    )
            completed += 1
            if progress:
                from .models import ProgressEvent

                progress(ProgressEvent(request_id, "generate_toolpath", "layer", completed, total_layers, "Generating full-resolution toolpath."))
    if not segments:
        raise GeometryValidationError("Selection generated no printable roads.")

    # Requested labels/orientation markers/notches/tabs/anchors are emitted as
    # short, owned roads outside the measurement stream.  They never sample HU.
    structural_items = [item for item in selection.structural_regions if item.get("structural") and item.get("marker_type")]
    for item in structural_items:
        marker_tool = _owner_tool(item.get("tool") or item.get("owner")) or tool
        if marker_tool is None:
            if len(calibrations) != 1:
                raise CalibrationMismatchError("Structural marker ownership is ambiguous across multiple tools.")
            marker_tool = next(iter(calibrations))
        marker_calibration = calibrations.get(marker_tool)
        if marker_calibration is None:
            raise CalibrationMismatchError(f"No accepted calibration is bound to structural marker tool {marker_tool}.")
        marker_type = str(item.get("marker_type"))
        marker_tile_index = int(item.get("tile_index", -1)) if item.get("tile_index") is not None else None
        offset_x, offset_y = tile_plate_offset(marker_tile_index) if marker_tile_index is not None and marker_tile_index >= 0 else (0.0, 0.0)
        marker_length = min(1.0, max(profile.min_line_width_mm * 2.0, tile_size[0] * 0.1))
        x0 = offset_x + max(0.0, tile_size[0] - marker_length - profile.min_line_width_mm)
        y0 = offset_y + max(0.0, tile_size[1] - profile.min_line_width_mm)
        width = float(np.clip(profile.min_line_width_mm, width_limit[0], width_limit[1]))
        extrusion, feedrate = _extrusion_and_feedrate(marker_length, width, selection.layer_height_mm, profile, marker_calibration.binding.effective_flow_mm3_s)
        segments.append(
            ToolpathSegment(
                segment_index=len(segments), layer_index=0, tile_index=marker_tile_index, start_xy_mm=(x0, y0), end_xy_mm=(x0 + marker_length, y0),
                z_mm=min(selection.print_size_mm[2], selection.layer_height_mm * 0.5), source_position_lps=selection.rail_sample_position(min(selection.print_size_mm[0] * 0.5, selection.print_size_mm[0]), min(selection.print_size_mm[1] * 0.5, selection.print_size_mm[1]), min(selection.print_size_mm[2], selection.layer_height_mm * 0.5), tile_index=marker_tile_index if selection.mode == "tile" and marker_tile_index is not None else None),
                source_hu=float(marker_calibration.hu_range[0]), target_hu=float(marker_calibration.hu_range[0]), clipped_hu=float(marker_calibration.hu_range[0]),
                commanded_width_mm=width, effective_fill=width / marker_calibration.binding.pitch_mm, feedrate_mm_min=float(feedrate), extrusion_mm=float(extrusion),
                tool=marker_tool, material=marker_calibration.binding.material, calibration_id=marker_calibration.calibration_id, region=f"structural_{marker_type}", range_status="structural",
            )
        )
        used_calibrations[marker_tool] = marker_calibration
    max_x = max(segment.end_xy_mm[0] for segment in segments)
    max_y = max(segment.end_xy_mm[1] for segment in segments)
    max_z = max(segment.z_mm for segment in segments)
    if max_x > profile.build_volume_mm[0] + 1e-6 or max_y > profile.build_volume_mm[1] + 1e-6 or max_z > profile.build_volume_mm[2] + 1e-6:
        raise GeometryValidationError("Generated toolpath exceeds the configured printer build volume.")
    tool_names = tuple(sorted({segment.tool for segment in segments}))
    preview = _preview_records(segments, tool_names)
    calibration_flows = {tool_name: used_calibrations[tool_name].binding.effective_flow_mm3_s for tool_name in tool_names}
    gcode = _format_gcode(
        segments,
        profile,
        selection.volume.source_hash,
        layer_height_mm=selection.layer_height_mm,
        calibration_flows_mm3_s=calibration_flows,
    )
    per_tool: dict[str, dict[str, Any]] = {}
    for tool_name in tool_names:
        candidate = used_calibrations[tool_name]
        volume_mm3 = float(sum(segment.length_mm * segment.commanded_width_mm * selection.layer_height_mm for segment in segments if segment.tool == tool_name))
        density = candidate.binding.material_density_g_cm3
        per_tool[tool_name] = {
            "material": candidate.binding.material,
            "calibration_id": candidate.calibration_id,
            "volume_mm3": volume_mm3,
            "material_density_g_cm3": density,
            "mass_g": None if density is None else volume_mm3 * density / 1000.0,
            "mass_status": "available" if density is not None else "unavailable_material_density_not_bound",
        }
    motion_seconds = float(sum(segment.length_mm / segment.feedrate_mm_min * 60.0 for segment in segments))
    tool_change_count = sum(1 for previous, current in zip(segments, segments[1:], strict=False) if previous.tool != current.tool)
    whole_minutes = int(motion_seconds // 60)
    seconds_remainder = int(round(motion_seconds - whole_minutes * 60))
    if seconds_remainder >= 60:
        whole_minutes += seconds_remainder // 60
        seconds_remainder %= 60
    estimate = {
        "print_time_seconds": motion_seconds,
        "print_time": f"{whole_minutes}m {seconds_remainder:02d}s",
        "tool_changes": tool_change_count,
        "per_tool": per_tool,
        "mass_status": "available" if all(item["mass_g"] is not None for item in per_tool.values()) else "unavailable_material_density_not_bound",
        "source": "emitted_audited_segments",
    }
    result = GeneratedToolpath(
        selection=selection,
        segments=tuple(segments),
        gcode_text=gcode,
        preview_records=preview,
        calibration_ids=tuple(used_calibrations[name].calibration_id for name in tool_names),
        profile=profile,
        report={
            "schema": "voxelweave.toolpath-report.v1",
            "selection": selection.manifest.to_dict(),
            "segment_count": len(segments),
            "layer_count": selection.layer_count,
            "tile_count": tile_count,
            "calibration_ids": [used_calibrations[name].calibration_id for name in tool_names],
            "tools": list(tool_names),
            "estimated": estimate,
            "tool_change_count": tool_change_count,
            "preview_is_non_authoritative": True,
            "clipping": {
                "occurred": clipped_count > 0,
                "sample_count": clipped_count,
                "acknowledged": bool(acknowledge_calibration_clipping),
                "by_layer": clipped_by_layer,
                "by_tile": clipped_by_tile,
                "by_region": clipped_by_region,
            },
            "physical_fidelity_claim": "not_established_by_software",
        },
    )
    audit = result.audit()
    if not audit.passed:
        raise ToolpathAuditError("Generated toolpath failed its own reverse audit: " + "; ".join(audit.errors))
    return result


_TOKEN_RE = re.compile(r"([A-Z])([-+]?\d+(?:\.\d+)?)")
_SEGMENT_RE = re.compile(
    r"^; VW_SEG index=(\d+) layer=(\d+) tile=(-?\d+) tool=(\S+) width=([-+]?\d+(?:\.\d+)?) hu=([-+]?\d+(?:\.\d+)?) target_hu=([-+]?\d+(?:\.\d+)?) region=(\S+) start_x=([-+]?\d+(?:\.\d+)?) start_y=([-+]?\d+(?:\.\d+)?)$"
)


def reverse_audit_gcode(
    gcode: str | Path,
    *,
    expected: GeneratedToolpath | Sequence[ToolpathSegment] | None = None,
    profile: PrinterProfile | None = None,
    wrapper_id: str | None = None,
) -> AuditReport:
    """Reverse parse G-code and compare its emitted physics with the exact preview."""

    profile = profile or (expected.profile if isinstance(expected, GeneratedToolpath) else PrinterProfile())
    if isinstance(gcode, Path):
        text = gcode.read_text(encoding="ascii")
    elif isinstance(gcode, str) and "\n" not in gcode:
        try:
            candidate = Path(gcode)
            text = candidate.read_text(encoding="ascii") if candidate.is_file() else gcode
        except OSError:
            text = gcode
    else:
        text = str(gcode)
    lines = text.splitlines()
    errors: list[str] = []
    warnings: list[str] = []
    low_speed_warning_count = 0
    found_wrapper = next((line.split("=", 1)[1] for line in lines if line.startswith("; VW_WRAPPER_ID=")), None)
    expected_wrapper = wrapper_id or profile.wrapper_id
    if found_wrapper != expected_wrapper:
        errors.append("G-code wrapper identity does not match the expected VoxelWeave wrapper.")
    source_hash_line = next((line for line in lines if line.startswith("; VW_SOURCE_HASH=")), None)
    if source_hash_line is None or not source_hash_line.split("=", 1)[1].strip():
        errors.append("G-code wrapper is missing the scientific source hash.")
    if "; VW_BEGIN" not in lines or "; VW_END" not in lines:
        errors.append("G-code is missing the VoxelWeave wrapper boundary markers.")
    elif lines.index("; VW_BEGIN") >= lines.index("; VW_END"):
        errors.append("G-code wrapper boundary markers are out of order.")
    if "M82" not in lines:
        errors.append("G-code must use absolute extrusion mode M82 for audited output.")
    for required_line in ("G90", "G21", "G92 E0"):
        if required_line not in lines:
            errors.append(f"G-code wrapper is missing required setup command {required_line}.")
    contract_values: dict[str, str] = {}
    for line in lines:
        if line.startswith("; VW_") and "=" in line:
            key, value = line[2:].split("=", 1)
            contract_values[key] = value
    if contract_values.get("VW_WRAPPER_CONTRACT") != "prusa-xl-safe-research-v2":
        errors.append("G-code is missing the supported Prusa XL research wrapper contract.")
    try:
        emitted_max_flow = float(contract_values["VW_MAX_FLOW_MM3_S"])
        emitted_calibration_flow = float(contract_values["VW_CALIBRATION_FLOW_MM3_S"])
        emitted_layer_height = float(contract_values["VW_LAYER_HEIGHT_MM"])
        emitted_filament_diameter = float(contract_values["VW_FILAMENT_DIAMETER_MM"])
    except (KeyError, TypeError, ValueError):
        emitted_max_flow = profile.max_flow_mm3_s
        emitted_calibration_flow = profile.max_flow_mm3_s
        emitted_layer_height = 0.0
        emitted_filament_diameter = profile.filament_diameter_mm
        errors.append("G-code wrapper is missing finite volumetric-flow contract metadata.")
    tool_flow_values: dict[str, float] = {}
    for line in lines:
        match = re.match(r"^; VW_TOOL_FLOW tool=(\S+) mm3_s=([-+]?\d+(?:\.\d+)?)$", line)
        if match:
            tool_flow_values[match.group(1)] = float(match.group(2))
    if emitted_max_flow <= 0 or emitted_calibration_flow <= 0 or emitted_filament_diameter <= 0:
        errors.append("G-code wrapper volumetric-flow contract is not positive.")
    if profile.home_before_print and "G28" not in lines:
        errors.append("G-code wrapper is configured to home before print but emits no G28.")
    if profile.heat_nozzle and not any(line.startswith("M109 S") for line in lines):
        errors.append("G-code wrapper is configured to heat the nozzle but emits no wait command.")
    if profile.heat_bed and not any(line.startswith("M190 S") for line in lines):
        errors.append("G-code wrapper is configured to heat the bed but emits no wait command.")
    if profile.park_after_print:
        park = f"G0 X{profile.park_position_mm[0]:.5f} Y{profile.park_position_mm[1]:.5f} Z{profile.park_position_mm[2]:.5f}"
        if park not in lines:
            errors.append("G-code wrapper is configured to park but emits no deterministic park move.")
    if profile.prime_enabled and not any(line.startswith("; VW_AUX_PRIME ") for line in lines):
        errors.append("G-code wrapper is configured to prime but emits no deterministic auxiliary prime move.")
    expected_segments: Sequence[ToolpathSegment] = ()
    if isinstance(expected, GeneratedToolpath):
        expected_segments = expected.segments
    elif expected is not None:
        expected_segments = expected
    cumulative_e = 0.0
    tool: str | None = None
    tool_changes: list[str] = []
    parsed_count = 0
    extrusion_moves = 0
    pending: re.Match[str] | None = None
    auxiliary_prime = False
    minimum = np.full(3, np.inf, dtype=np.float64)
    maximum = np.full(3, -np.inf, dtype=np.float64)
    for line_number, line in enumerate(lines, start=1):
        stripped = line.strip()
        if stripped.startswith("T") and len(stripped) > 1 and stripped[1:].isdigit():
            tool = stripped
            if not tool_changes or tool_changes[-1] != tool:
                tool_changes.append(tool)
            continue
        match = _SEGMENT_RE.match(stripped)
        if match:
            pending = match
            continue
        if stripped.startswith("; VW_AUX_PRIME "):
            auxiliary_prime = True
            continue
        is_print_move = stripped.startswith("G1")
        if not (is_print_move or stripped.startswith("G0")):
            continue
        fields = {key: float(value) for key, value in _TOKEN_RE.findall(stripped)}
        if not all(key in fields for key in ("X", "Y", "Z")):
            errors.append(f"Line {line_number} is missing audited X/Y/Z fields.")
            continue
        next_position = np.asarray([fields["X"], fields["Y"], fields["Z"]], dtype=np.float64)
        minimum = np.minimum(minimum, next_position)
        maximum = np.maximum(maximum, next_position)
        if np.any(next_position < -1e-6) or np.any(next_position > np.asarray(profile.build_volume_mm) + 1e-6):
            errors.append(f"Line {line_number} leaves the configured build volume.")
        if not is_print_move:
            continue
        if not all(key in fields for key in ("E", "F")):
            errors.append(f"Line {line_number} is missing audited E/F fields.")
            continue
        delta_e = fields["E"] - cumulative_e
        cumulative_e = fields["E"]
        if delta_e <= 0:
            errors.append(f"Line {line_number} has non-positive extrusion for a printable move.")
            continue
        extrusion_moves += 1
        if auxiliary_prime and pending is None:
            if delta_e <= 0 or fields["F"] <= 0:
                errors.append(f"Line {line_number} has invalid auxiliary prime extrusion.")
            auxiliary_prime = False
            continue
        if pending is None:
            errors.append(f"Line {line_number} has no VoxelWeave segment identity comment.")
            continue
        if tool is None:
            errors.append(f"Line {line_number} has no active tool identity.")
        index = int(pending.group(1))
        if index != parsed_count:
            errors.append(f"G-code segment ordering is not contiguous at index {index}.")
        if index < len(expected_segments):
            reference = expected_segments[index]
            comment_tool = pending.group(4)
            if comment_tool != reference.tool or tool != reference.tool:
                errors.append(f"Segment {index} tool identity differs from the exact preview.")
            checks = (
                (fields["X"], reference.end_xy_mm[0], "end X"),
                (fields["Y"], reference.end_xy_mm[1], "end Y"),
                (fields["Z"], reference.z_mm, "Z"),
                (fields["F"], reference.feedrate_mm_min, "feedrate"),
                (float(pending.group(5)), reference.commanded_width_mm, "width"),
            )
            for actual, target, label in checks:
                if abs(actual - target) > 1e-3:
                    errors.append(f"Segment {index} {label} differs from the exact preview.")
            if abs(delta_e - reference.extrusion_mm) > 2e-3:
                errors.append(f"Segment {index} extrusion differs from the exact preview.")
        width = float(pending.group(5))
        if width < profile.min_line_width_mm - 1e-6 or width > profile.max_line_width_mm + 1e-6:
            errors.append(f"Segment {index} commanded width exceeds the printer width contract.")
        if fields["F"] <= 0 or fields["F"] > profile.max_print_speed_mm_min + 1e-3:
            errors.append(f"Segment {index} feedrate exceeds the printer motion contract.")
        elif fields["F"] < profile.min_print_speed_mm_min - 1e-3:
            # This is advisory only: enforcing the configured floor here would
            # force a feedrate above the hard volumetric-flow cap.
            low_speed_warning_count += 1
        if pending is not None and emitted_layer_height > 0:
            segment_length = math.hypot(
                fields["X"] - float(pending.group(9)),
                fields["Y"] - float(pending.group(10)),
            )
            if segment_length <= 0:
                errors.append(f"Segment {index} has zero printable length.")
            else:
                filament_area = math.pi * (emitted_filament_diameter / 2.0) ** 2
                flow = delta_e * filament_area * fields["F"] / 60.0 / segment_length
                hard_cap = min(emitted_max_flow, tool_flow_values.get(tool or "", emitted_calibration_flow))
                if flow > hard_cap + 1e-5:
                    errors.append(f"Segment {index} exceeds the emitted volumetric-flow cap.")
        parsed_count += 1
        pending = None
    if expected_segments and parsed_count != len(expected_segments):
        errors.append("G-code segment count differs from the exact preview stream.")
    if parsed_count == 0:
        errors.append("G-code contains no audited printable segment moves.")
    if low_speed_warning_count:
        warnings.append(f"{low_speed_warning_count} segment(s) are below the preferred minimum speed to preserve the flow cap.")
    bounds = None if parsed_count == 0 else (
        (float(minimum[0]), float(minimum[1]), float(minimum[2])),
        (float(maximum[0]), float(maximum[1]), float(maximum[2])),
    )
    return AuditReport(
        passed=not errors,
        errors=tuple(errors),
        warnings=tuple(warnings),
        wrapper_id=found_wrapper,
        segment_count=parsed_count,
        extrusion_move_count=extrusion_moves,
        tool_changes=tuple(tool_changes),
        tool_change_count=max(0, len(tool_changes) - 1),
        bounds_xyz=bounds,
        checked_expected_segments=min(parsed_count, len(expected_segments)) if expected_segments else 0,
    )


def _write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(canonicalize(value), sort_keys=True, indent=2) + "\n", encoding="utf-8")


def export_run_package(generated: GeneratedToolpath, directory: str | Path) -> dict[str, Any]:
    """Export a deterministic, hash-indexed run package without printer side effects."""

    target = Path(directory)
    target.mkdir(parents=True, exist_ok=True)
    gcode_path = target / "toolpath.gcode"
    gcode_path.write_text(generated.gcode_text, encoding="ascii", newline="\n")
    preview = write_binary_array(
        target / "toolpath_preview.bin",
        generated.preview_records,
        artifact_type="exact_generated_segment_preview",
        metadata={
            "source_hash": generated.selection.volume.source_hash,
            "segment_count": len(generated.segments),
            "dtype_fields": list((_PREVIEW_DTYPE.fields or {}).keys()),
            "preview_is_non_authoritative": True,
        },
    )
    tool_names = tuple(sorted({segment.tool for segment in generated.segments}))
    tool_index = {name: index for index, name in enumerate(tool_names)}
    trace_dtype = np.dtype([("x", "<f8"), ("y", "<f8"), ("z", "<f8"), ("e", "<f8"), ("tool", "<i4")])
    trace = np.zeros(len(generated.segments), dtype=trace_dtype)
    for index, segment in enumerate(generated.segments):
        trace[index] = (segment.end_xy_mm[0], segment.end_xy_mm[1], segment.z_mm, segment.extrusion_mm, tool_index[segment.tool])
    trace_artifact = write_binary_array(
        target / "toolpath_trace.bin",
        trace,
        artifact_type="audited_toolpath_trace",
        metadata={"segment_count": len(trace), "tool_id_encoding": "sorted_tool_names_zero_based", "tool_ids": tool_names},
    )
    selection_path = target / "selection_manifest.json"
    transform_path = target / "source_to_print_transform.json"
    report_path = target / "run_report.json"
    audit = generated.audit()
    _write_json(selection_path, generated.selection.manifest.to_dict())
    _write_json(transform_path, {"schema": "voxelweave.source-to-print-transform.v1", "matrix": generated.selection.manifest.source_to_print_transform})
    report = {**generated.report, "gcode_sha256": generated.gcode_sha256, "preview_sha256": generated.preview_sha256, "audit": audit.to_dict()}
    _write_json(report_path, report)
    artifact_paths = [gcode_path, preview.path, trace_artifact.path, selection_path, transform_path, report_path]
    hashes = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(artifact_paths, key=lambda item: item.name)}
    hashes_path = target / "hashes.json"
    _write_json(hashes_path, {"schema": "voxelweave.run-hashes.v1", "files": hashes})
    package_path = target / "run-package.zip"
    with zipfile.ZipFile(package_path, "w", compression=zipfile.ZIP_STORED, strict_timestamps=False) as archive:
        for path in sorted((*artifact_paths, hashes_path), key=lambda item: item.name):
            info = zipfile.ZipInfo(path.name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes())
    package_hash = hashlib.sha256(package_path.read_bytes()).hexdigest()
    return {
        "schema": "voxelweave.run-package.v1",
        "directory": str(target),
        "files": sorted([path.name for path in (*artifact_paths, hashes_path, package_path)]),
        "package_name": package_path.name,
        "package_path": str(package_path),
        "hashes": {**hashes, hashes_path.name: hashlib.sha256(hashes_path.read_bytes()).hexdigest(), package_path.name: package_hash},
        "tool_id_encoding": {str(index): name for name, index in tool_index.items()},
        "audit": audit.to_dict(),
        "automatic_print_start": False,
        "physical_fidelity_claim": "not_established_by_software",
    }
