from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path

from voxelweave import (
    ControlEnvelope,
    EngineSession,
    Operation,
    create_synthetic_volume,
    encode_jsonl,
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
