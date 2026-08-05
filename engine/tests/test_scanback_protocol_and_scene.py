from __future__ import annotations

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


def test_scan_back_keeps_hu_gamma_distinct_from_dose_gamma() -> None:
    source = create_synthetic_volume(pattern="phantom", shape_zyx=(5, 6, 7))
    scan_back = synthetic_scan_back(source, noise_hu=2.0)
    result = verify_scan_back(source, scan_back, registration_method="identity", registration_confidence=0.95)
    assert result.compared_voxel_count == source.hu.size
    assert result.hu_gamma_pass_percent > 90.0
    assert result.physical_fidelity_status == "evidence_recorded_not_established"
    assert result.to_dict()["dose_gamma"] == "not_used_hu_gamma_is_not_dose_gamma"


def test_protocol_operations_are_versioned_and_scene_is_fail_closed() -> None:
    operations = tuple(Operation)
    envelopes = [ControlEnvelope(f"r-{index}", operation, {}) for index, operation in enumerate(operations)]
    parsed = parse_jsonl(encode_jsonl(envelopes))
    assert [item.operation for item in parsed] == list(operations)
    session = EngineSession()
    scene_result = session.handle(ControlEnvelope("scene", Operation.VALIDATE_SCENE, {"scene": {"regions": [{"id": "x", "owner": "T0", "ambiguous_overlap": True}]}}))
    assert not scene_result["passed"]
    assert validate_scene({"regions": []})["warnings"]
