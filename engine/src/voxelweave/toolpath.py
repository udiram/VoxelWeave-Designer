"""Deterministic alternating-road toolpath generation and reverse audit."""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

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

    def __post_init__(self) -> None:
        if any(float(item) <= 0 for item in self.build_volume_mm) or self.filament_diameter_mm <= 0 or self.max_flow_mm3_s <= 0:
            raise GeometryValidationError("Printer profile dimensions and flow limits must be positive.")
        if self.min_line_width_mm <= 0 or self.max_line_width_mm < self.min_line_width_mm or self.sample_step_mm <= 0:
            raise GeometryValidationError("Printer profile width and sampling limits are invalid.")


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


def _resolve_calibration(calibration: Calibration | CalibrationSet | Mapping[str, Calibration], tool: str | None = None) -> Calibration:
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
    else:
        if tool is None or tool not in calibration:
            raise CalibrationMismatchError("Generation requires an explicit calibration for the selected tool.")
        result = calibration[tool]
    if not result.accepted:
        raise CalibrationMismatchError("Generation cannot use an unaccepted calibration.")
    return result


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
    max_feed = min(profile.max_flow_mm3_s, calibration_flow_mm3_s) * 60.0 / max(width * layer_height, 1e-9)
    feed = min(profile.max_print_speed_mm_min, max_feed)
    feed = max(profile.min_print_speed_mm_min, feed)
    extrusion = volume / filament_area
    return extrusion, feed


def _segment_comment(segment: ToolpathSegment) -> str:
    tile = -1 if segment.tile_index is None else segment.tile_index
    return (
        f"; VW_SEG index={segment.segment_index} layer={segment.layer_index} tile={tile} tool={segment.tool} "
        f"width={segment.commanded_width_mm:.8f} hu={segment.source_hu:.8f} target_hu={segment.target_hu:.8f} "
        f"region={segment.region} start_x={segment.start_xy_mm[0]:.8f} start_y={segment.start_xy_mm[1]:.8f}"
    )


def _format_gcode(segments: Sequence[ToolpathSegment], profile: PrinterProfile, source_hash: str) -> str:
    lines = [
        "; VoxelWeave Designer research-use deterministic toolpath",
        "; VW_BEGIN",
        f"; VW_WRAPPER_ID={profile.wrapper_id}",
        f"; VW_SOURCE_HASH={source_hash}",
        "; VW_SCIENTIFIC_BOUNDARY=software_audit_does_not_establish_physical_fidelity",
        "G90",
        "M82",
        "G21",
        "G92 E0",
    ]
    cumulative_e = 0.0
    current_tool: str | None = None
    previous_end: tuple[float, float] | None = None
    previous_z: float | None = None
    for segment in segments:
        if current_tool != segment.tool:
            lines.append(f"{segment.tool}")
            current_tool = segment.tool
        start_x, start_y = segment.start_xy_mm
        if previous_end is None or previous_z != segment.z_mm or math.hypot(previous_end[0] - start_x, previous_end[1] - start_y) > 1e-7:
            lines.append(f"G0 X{start_x:.5f} Y{start_y:.5f} Z{segment.z_mm:.5f}")
        cumulative_e += segment.extrusion_mm
        lines.append(_segment_comment(segment))
        lines.append(
            f"G1 X{segment.end_xy_mm[0]:.5f} Y{segment.end_xy_mm[1]:.5f} Z{segment.z_mm:.5f} "
            f"E{cumulative_e:.5f} F{segment.feedrate_mm_min:.3f}"
        )
        previous_end = segment.end_xy_mm
        previous_z = segment.z_mm
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
    calibration: Calibration | CalibrationSet | Mapping[str, Calibration],
    *,
    profile: PrinterProfile | None = None,
    tool: str | None = None,
    allow_calibration_clipping: bool = False,
    request_id: str = "toolpath",
    progress: ProgressCallback | None = None,
    cancellation: CancellationToken | None = None,
) -> GeneratedToolpath:
    profile = profile or PrinterProfile()
    selected_calibration = _resolve_calibration(calibration, tool)
    _profile_binding(selection, selected_calibration, profile)
    pitch = selected_calibration.binding.pitch_mm
    if pitch <= 0:
        raise CalibrationMismatchError("Calibration pitch must be positive.")
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
    positions_x = _positions(selection.print_size_mm[0], pitch)
    positions_y = _positions(selection.print_size_mm[1], pitch)
    total_layers = selection.layer_count * tile_count
    completed = 0
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
                    source_position = selection.rail_sample_position(x, y, z_sample, tile_index=tile_index if selection.mode == "tile" else None)
                    source_hu = selection.sample_hu(x, y, z_sample, tile_index=tile_index if selection.mode == "tile" else None)
                    clipped_hu, widths, range_status = selected_calibration.map_hu(np.asarray([source_hu]), allow_clipping=allow_calibration_clipping)
                    width = float(np.clip(widths[0], width_limit[0], width_limit[1]))
                    target_hu = source_hu
                    fill = width / pitch
                    local_start = (a, line_coordinate) if direction_x else (line_coordinate, a)
                    local_end = (b, line_coordinate) if direction_x else (line_coordinate, b)
                    extrusion, feedrate = _extrusion_and_feedrate(
                        math.hypot(b - a, 0.0),
                        width,
                        selection.layer_height_mm,
                        profile,
                        selected_calibration.binding.effective_flow_mm3_s,
                    )
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
                            target_hu=float(target_hu),
                            clipped_hu=float(clipped_hu[0]),
                            commanded_width_mm=width,
                            effective_fill=float(fill),
                            feedrate_mm_min=float(feedrate),
                            extrusion_mm=float(extrusion),
                            tool=selected_calibration.binding.tool,
                            material=selected_calibration.binding.material,
                            calibration_id=selected_calibration.calibration_id,
                            region="measurement_roi" if selection.mode != "tile" else "measurement_roi_tile",
                            range_status=range_status,
                        )
                    )
            completed += 1
            if progress:
                from .models import ProgressEvent

                progress(ProgressEvent(request_id, "generate_toolpath", "layer", completed, total_layers, "Generating full-resolution toolpath."))
    if not segments:
        raise GeometryValidationError("Selection generated no printable roads.")
    max_x = max(segment.end_xy_mm[0] for segment in segments)
    max_y = max(segment.end_xy_mm[1] for segment in segments)
    max_z = max(segment.z_mm for segment in segments)
    if max_x > profile.build_volume_mm[0] + 1e-6 or max_y > profile.build_volume_mm[1] + 1e-6 or max_z > profile.build_volume_mm[2] + 1e-6:
        raise GeometryValidationError("Generated toolpath exceeds the configured printer build volume.")
    tool_names = tuple(sorted({segment.tool for segment in segments}))
    preview = _preview_records(segments, tool_names)
    gcode = _format_gcode(segments, profile, selection.volume.source_hash)
    result = GeneratedToolpath(
        selection=selection,
        segments=tuple(segments),
        gcode_text=gcode,
        preview_records=preview,
        calibration_ids=(selected_calibration.calibration_id,),
        profile=profile,
        report={
            "schema": "voxelweave.toolpath-report.v1",
            "selection": selection.manifest.to_dict(),
            "segment_count": len(segments),
            "layer_count": selection.layer_count,
            "tile_count": tile_count,
            "calibration_ids": [selected_calibration.calibration_id],
            "preview_is_non_authoritative": True,
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
    found_wrapper = next((line.split("=", 1)[1] for line in lines if line.startswith("; VW_WRAPPER_ID=")), None)
    expected_wrapper = wrapper_id or profile.wrapper_id
    if found_wrapper != expected_wrapper:
        errors.append("G-code wrapper identity does not match the expected VoxelWeave wrapper.")
    if "; VW_BEGIN" not in lines or "; VW_END" not in lines:
        errors.append("G-code is missing the VoxelWeave wrapper boundary markers.")
    if "M82" not in lines:
        errors.append("G-code must use absolute extrusion mode M82 for audited output.")
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
        if fields["F"] < profile.min_print_speed_mm_min - 1e-3 or fields["F"] > profile.max_print_speed_mm_min + 1e-3:
            errors.append(f"Segment {index} feedrate exceeds the printer motion contract.")
        parsed_count += 1
        pending = None
    if expected_segments and parsed_count != len(expected_segments):
        errors.append("G-code segment count differs from the exact preview stream.")
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
    trace_dtype = np.dtype([("x", "<f8"), ("y", "<f8"), ("z", "<f8"), ("e", "<f8"), ("tool", "<i4")])
    trace = np.zeros(len(generated.segments), dtype=trace_dtype)
    for index, segment in enumerate(generated.segments):
        trace[index] = (segment.end_xy_mm[0], segment.end_xy_mm[1], segment.z_mm, segment.extrusion_mm, 0)
    trace_artifact = write_binary_array(target / "toolpath_trace.bin", trace, artifact_type="audited_toolpath_trace", metadata={"segment_count": len(trace)})
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
    return {
        "schema": "voxelweave.run-package.v1",
        "directory": str(target),
        "files": sorted([path.name for path in (*artifact_paths, hashes_path)]),
        "hashes": {**hashes, hashes_path.name: hashlib.sha256(hashes_path.read_bytes()).hexdigest()},
        "audit": audit.to_dict(),
        "automatic_print_start": False,
        "physical_fidelity_claim": "not_established_by_software",
    }
