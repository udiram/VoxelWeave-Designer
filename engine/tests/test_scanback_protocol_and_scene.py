from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path

from voxelweave import (
    Calibration,
    CalibrationBinding,
    ControlEnvelope,
    EngineSession,
    Operation,
    PrinterProfile,
    create_print_selection,
    create_synthetic_volume,
    encode_jsonl,
    generate_toolpath,
    parse_jsonl,
    synthetic_scan_back,
    verify_scan_back,
)
from voxelweave.engine import validate_scene
from voxelweave.scanback import export_verification_package


def test_scan_back_keeps_hu_gamma_distinct_from_dose_gamma() -> None:
    source = create_synthetic_volume(pattern="phantom", shape_zyx=(5, 6, 7))
    scan_back = synthetic_scan_back(source, noise_hu=2.0)
    result = verify_scan_back(source, scan_back, registration_method="identity", registration_confidence=0.95)
    assert result.compared_voxel_count == source.hu.size
    assert result.hu_gamma_pass_percent > 90.0
    assert result.physical_fidelity_status == "evidence_recorded_not_established"
    assert result.to_dict()["dose_gamma"] == "not_used_hu_gamma_is_not_dose_gamma"


def test_verification_package_preserves_hashed_provenance(tmp_path: Path) -> None:
    source = create_synthetic_volume(pattern="phantom", shape_zyx=(5, 6, 7))
    result = verify_scan_back(source, synthetic_scan_back(source, noise_hu=2.0))
    exported = export_verification_package(result, tmp_path / "report", run_id="run-1", gcode_sha256="abc")
    report_path = Path(exported["report_path"])
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["verification"]["source_hash"] == result.source_hash
    assert report["verification"]["scan_back_hash"] == result.scan_back_hash
    assert report["verification"]["dose_gamma"] == "not_used_hu_gamma_is_not_dose_gamma"
    assert exported["hashes"][report_path.name] == hashlib.sha256(report_path.read_bytes()).hexdigest()
    with zipfile.ZipFile(exported["package_path"]) as archive:
        assert set(archive.namelist()) == {"verification-report.json", "provenance.json", "hashes.json"}


def test_engine_session_verification_export_carries_versioned_bidirectional_transforms(tmp_path: Path) -> None:
    source = create_synthetic_volume(pattern="ramp", shape_zyx=(5, 6, 7), hu_min=-800, hu_max=800)
    selection = create_print_selection(
        source,
        plane="axial",
        mode="continuous",
        start_index=1,
        end_index=3,
        layer_height_mm=0.5,
        print_size_mm=(6.0, 5.0, 1.5),
    )
    calibration = Calibration(
        calibration_id="verification-export-fixture",
        binding=CalibrationBinding(
            pitch_mm=1.0,
            layer_height_mm=0.5,
            nozzle_mm=0.4,
            tool="T0",
            material="synthetic PLA",
            lot="test-only",
            printer="Prusa XL",
            scanner="synthetic CT",
            reconstruction="STANDARD",
        ),
        commanded_width_mm=(0.2, 0.5, 0.8),
        measured_hu_mean=(-800.0, 0.0, 800.0),
        evidence_reference="synthetic fixture only",
    )
    generated = generate_toolpath(selection, calibration, profile=PrinterProfile(sample_step_mm=3.0))
    verification = verify_scan_back(source, synthetic_scan_back(source, noise_hu=1.0))
    with EngineSession(workspace=tmp_path) as session:
        session.volume = source
        session.selection = selection
        session.generated = generated
        session.verification = verification
        exported = session.handle(
            ControlEnvelope(
                "export-verification",
                Operation.EXPORT_VERIFICATION_REPORT,
                {"directory": "verification", "run_id": "run-1"},
            )
        )
        report = json.loads(Path(exported["report_path"]).read_text(encoding="utf-8"))
    assert report["schema"] == "voxelweave.verification-report.v2"
    transforms = report["coordinate_transforms"]
    assert transforms["schema"] == "voxelweave.coordinate-transforms.v3"
    assert len(transforms["source_to_print_matrix"]) == 4
    assert len(transforms["print_to_source_matrix"]) == 4
    assert transforms["single_and_tile_normal_policy"] == "selected_source_plane_repeated_through_print_thickness"


def test_protocol_operations_are_versioned_and_scene_is_fail_closed() -> None:
    operations = tuple(Operation)
    envelopes = [ControlEnvelope(f"r-{index}", operation, {}) for index, operation in enumerate(operations)]
    parsed = parse_jsonl(encode_jsonl(envelopes))
    assert [item.operation for item in parsed] == list(operations)
    session = EngineSession()
    scene_result = session.handle(ControlEnvelope("scene", Operation.VALIDATE_SCENE, {"scene": {"regions": [{"id": "x", "owner": "T0", "ambiguous_overlap": True}]}}))
    assert not scene_result["passed"]
    assert validate_scene({"regions": []})["warnings"]


def test_scene_mesh_and_boolean_require_canonical_geometry_validation() -> None:
    malformed_mesh = validate_scene(
        {
            "regions": [
                {
                    "id": "mesh",
                    "owner": "T0:measurement",
                    "geometry": {"kind": "imported_mesh", "vertices": [[0.0, 0.0]], "faces": [[0, 1, 2]]},
                }
            ]
        }
    )
    assert not malformed_mesh["passed"]
    primitive = validate_scene(
        {"regions": [{"id": "box", "owner": "T0:fixture", "target_hu": 0, "geometry": {"kind": "box", "dimensions": [2, 3, 4]}}]}
    )
    assert primitive["passed"]
