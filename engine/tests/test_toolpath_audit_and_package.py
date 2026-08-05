from __future__ import annotations

import hashlib
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
