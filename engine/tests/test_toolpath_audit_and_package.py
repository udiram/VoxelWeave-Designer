from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from voxelweave import (
    Calibration,
    CalibrationBinding,
    CalibrationMismatchError,
    PrinterProfile,
    RailField,
    create_print_selection,
    create_synthetic_volume,
    export_run_package,
    generate_toolpath,
    request_volume_preview,
    reverse_audit_gcode,
)
from voxelweave.toolpath import _extrusion_and_feedrate


def _calibration() -> Calibration:
    return Calibration(
        calibration_id="cal-T0-PLA-L1",
        binding=CalibrationBinding(
            pitch_mm=1.0,
            layer_height_mm=0.5,
            nozzle_mm=0.4,
            tool="T0",
            material="natural PLA",
            lot="L1",
            printer="Prusa XL",
            scanner="synthetic CT",
            reconstruction="STANDARD",
        ),
        commanded_width_mm=(0.2, 0.5, 0.8),
        measured_hu_mean=(-800.0, 0.0, 800.0),
        evidence_reference="synthetic fixture only",
    )


def _generate() -> object:
    volume = create_synthetic_volume(pattern="ramp", shape_zyx=(6, 10, 10), hu_min=-800, hu_max=800)
    selection = create_print_selection(volume, plane="axial", mode="continuous", start_index=1, end_index=4, layer_height_mm=0.5, print_size_mm=(8.0, 8.0, 2.0))
    return generate_toolpath(selection, _calibration(), profile=PrinterProfile(sample_step_mm=4.0))


def _calibration_for_tool(tool: str, calibration_id: str, *, density: float | None = None) -> Calibration:
    base = _calibration()
    binding = CalibrationBinding(
        pitch_mm=base.binding.pitch_mm,
        layer_height_mm=base.binding.layer_height_mm,
        nozzle_mm=base.binding.nozzle_mm,
        tool=tool,
        material=f"{tool} PLA",
        lot=base.binding.lot,
        printer=base.binding.printer,
        scanner=base.binding.scanner,
        reconstruction=base.binding.reconstruction,
        flow_mm3_s=base.binding.effective_flow_mm3_s,
        material_density_g_cm3=density,
    )
    return Calibration(calibration_id=calibration_id, binding=binding, commanded_width_mm=base.commanded_width_mm, measured_hu_mean=base.measured_hu_mean)


def test_calibration_range_and_toolpath_preview_audit() -> None:
    calibration = _calibration()
    with pytest.raises(CalibrationMismatchError, match="outside calibration range"):
        calibration.map_hu(1200.0)
    _, widths, status = calibration.map_hu(1200.0, allow_clipping=True)
    assert status == "clipped"
    assert widths[0] == 0.8

    volume = create_synthetic_volume(pattern="uniform", shape_zyx=(4, 4, 4), hu_min=0, hu_max=100)
    rail = RailField(volume, calibration, calibration.binding)
    rail_sample = rail.query((1.0, 1.0, 1.0))
    assert rail_sample.occupied
    assert rail_sample.region == "measurement_roi"
    assert rail_sample.calibration_id == calibration.calibration_id

    generated = _generate()
    assert generated.segments
    assert generated.audit().passed
    assert generated.gcode_sha256 == hashlib.sha256(generated.gcode_text.encode("ascii")).hexdigest()
    altered = generated.gcode_text.replace("; VW_WRAPPER_ID=voxelweave.prusa-xl.wrapper.v1", "; VW_WRAPPER_ID=wrong", 1)
    assert not reverse_audit_gcode(altered, expected=generated).passed


def test_preview_resolution_does_not_change_gcode_and_package_is_deterministic(tmp_path: Path) -> None:
    generated_a = _generate()
    volume = generated_a.selection.volume
    request_volume_preview(volume, max_dimension=4)
    generated_b = _generate()
    request_volume_preview(volume, max_dimension=10)
    assert generated_a.gcode_text == generated_b.gcode_text
    assert generated_a.preview_sha256 == generated_b.preview_sha256

    first = export_run_package(generated_a, tmp_path / "one")
    second = export_run_package(generated_b, tmp_path / "two")
    assert first["files"] == second["files"]
    assert first["hashes"] == second["hashes"]
    assert (tmp_path / "one" / "toolpath.gcode").read_bytes() == (tmp_path / "two" / "toolpath.gcode").read_bytes()
    assert first["audit"]["passed"]
    assert first["package_name"] == "run-package.zip"
    assert (tmp_path / "one" / "run-package.zip").is_file()
    transforms = json.loads((tmp_path / "one" / "coordinate_transforms.json").read_text(encoding="utf-8"))
    assert transforms["schema"] == "voxelweave.coordinate-transforms.v3"
    assert len(transforms["source_to_print_matrix"]) == 4
    assert len(transforms["print_to_source_matrix"]) == 4
    assert "source_to_print_transform.json" not in first["files"]


def test_volumetric_flow_cap_wins_over_minimum_speed_preference() -> None:
    profile = PrinterProfile(
        max_flow_mm3_s=0.01,
        min_print_speed_mm_min=10000.0,
        max_print_speed_mm_min=20000.0,
        min_line_width_mm=0.01,
        max_line_width_mm=10.0,
    )
    extrusion, feedrate = _extrusion_and_feedrate(10.0, 10.0, 5.0, profile, 0.01)
    assert extrusion > 0.0
    assert feedrate < profile.min_print_speed_mm_min
    assert feedrate * 10.0 * 5.0 / 60.0 <= profile.max_flow_mm3_s + 1e-12


def test_clipping_requires_acknowledgement_and_is_reported() -> None:
    volume = create_synthetic_volume(pattern="uniform", shape_zyx=(4, 4, 4), hu_min=1200.0, hu_max=1200.0)
    selection = create_print_selection(volume, plane="axial", mode="continuous", start_index=1, end_index=2, layer_height_mm=0.5)
    with pytest.raises(CalibrationMismatchError, match="outside calibration range"):
        generate_toolpath(selection, _calibration(), profile=PrinterProfile(sample_step_mm=4.0))
    with pytest.raises(CalibrationMismatchError, match="acknowledge_calibration_clipping"):
        generate_toolpath(selection, _calibration(), profile=PrinterProfile(sample_step_mm=4.0), allow_calibration_clipping=True)
    generated = generate_toolpath(
        selection,
        _calibration(),
        profile=PrinterProfile(sample_step_mm=4.0),
        allow_calibration_clipping=True,
        acknowledge_calibration_clipping=True,
    )
    assert generated.report["clipping"]["occurred"] is True
    assert generated.report["clipping"]["acknowledged"] is True
    assert generated.audit().passed


def test_multi_tool_dispatch_requires_ownership_and_audits_tool_changes(tmp_path: Path) -> None:
    volume = create_synthetic_volume(pattern="ramp", shape_zyx=(6, 10, 10), hu_min=-700, hu_max=700)
    selection = create_print_selection(
        volume,
        plane="axial",
        mode="continuous",
        start_index=1,
        end_index=4,
        layer_height_mm=0.5,
        print_size_mm=(8.0, 8.0, 2.0),
        structural_regions=(
            {"id": "left", "region": "measurement_roi", "owner": "T0", "bounds_mm": [0, 0, 4, 8]},
            {"id": "right", "region": "measurement_roi", "owner": "T1", "bounds_mm": [4, 0, 8, 8]},
        ),
    )
    t0 = _calibration_for_tool("T0", "cal-T0", density=1.2)
    t1 = _calibration_for_tool("T1", "cal-T1", density=None)
    generated = generate_toolpath(selection, [t0, t1], profile=PrinterProfile(sample_step_mm=4.0))
    assert {segment.tool for segment in generated.segments} == {"T0", "T1"}
    assert generated.report["tool_change_count"] > 0
    assert generated.report["estimated"]["per_tool"]["T0"]["mass_g"] is not None
    assert generated.report["estimated"]["per_tool"]["T1"]["mass_g"] is None
    assert generated.audit().passed
    package = export_run_package(generated, tmp_path / "multi")
    trace_path = tmp_path / "multi" / "toolpath_trace.bin"
    from voxelweave.binary import read_binary_array

    trace, _trace_header = read_binary_array(trace_path)
    tool_names = tuple(sorted({segment.tool for segment in generated.segments}))
    assert set(trace["tool"].tolist()) == {tool_names.index(segment.tool) for segment in generated.segments}
    assert trace["tool"].tolist() == [tool_names.index(segment.tool) for segment in generated.segments]
    report = json.loads((tmp_path / "multi" / "run_report.json").read_text(encoding="utf-8"))
    assert report["estimated"]["source"] == "emitted_audited_segments"
    assert package["tool_id_encoding"] == {str(index): name for index, name in enumerate(tool_names)}


def test_multi_tool_generation_fails_without_explicit_region_ownership() -> None:
    volume = create_synthetic_volume(pattern="uniform", shape_zyx=(5, 8, 8), hu_min=-100, hu_max=100)
    selection = create_print_selection(volume, plane="axial", mode="continuous", start_index=1, end_index=2, layer_height_mm=0.5, print_size_mm=(6, 6, 1.0))
    with pytest.raises(CalibrationMismatchError, match="implicit multi-tool dispatch"):
        generate_toolpath(selection, [_calibration_for_tool("T0", "a"), _calibration_for_tool("T1", "b")], profile=PrinterProfile(sample_step_mm=3.0))
