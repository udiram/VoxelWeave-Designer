from __future__ import annotations

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

import pytest

from voxelweave import (
    Calibration,
    CalibrationBinding,
    PrinterProfile,
    create_print_selection,
    create_synthetic_volume,
    generate_toolpath,
)
from voxelweave.engine import EngineSession, validate_scene
from voxelweave.errors import GeometryValidationError
from voxelweave.protocol import ControlEnvelope, Operation
from voxelweave.scene import ModeledPrintSelection, canonical_scene


def _calibration(tool: str = "T0") -> Calibration:
    return Calibration(
        calibration_id=f"cal-{tool}",
        binding=CalibrationBinding(
            pitch_mm=1.0,
            layer_height_mm=0.5,
            nozzle_mm=0.4,
            tool=tool,
            material=f"{tool} PLA",
            lot="L1",
            printer="Prusa XL",
            scanner="modeled source",
            reconstruction="canonical manifold",
        ),
        commanded_width_mm=(0.2, 0.5, 0.8),
        measured_hu_mean=(-800.0, 0.0, 800.0),
    )


def _box(identifier: str, *, x: float = 0, z: float = 1, size: tuple[float, float, float] = (4, 4, 2), visible: bool = True) -> dict[str, object]:
    dimensions = {"x": size[0], "y": size[1], "z": size[2]}
    return {
        "id": identifier,
        "kind": "box",
        "owner": "T0:measurement",
        "region": "measurement",
        "tool": "T0",
        "target_hu": 0,
        "visible": visible,
        "transform": {"position": {"x": x, "y": 0, "z": z}, "rotation": {"x": 0, "y": 0, "z": 0}, "scale": dimensions},
        "geometry": {"kind": "box", "dimensions": dimensions},
    }


def test_modeled_only_generation_clips_roads_to_canonical_occupancy() -> None:
    scene = {"regions": [_box("outer"), _box("hole", size=(2, 2, 2), visible=False), {
        "id": "result",
        "kind": "group",
        "owner": "T0:measurement",
        "region": "measurement",
        "tool": "T0",
        "target_hu": 0,
        "visible": True,
        "transform": {"position": {"x": 0, "y": 0, "z": 0}, "rotation": {"x": 0, "y": 0, "z": 0}, "scale": {"x": 1, "y": 1, "z": 1}},
        "geometry": {"kind": "group", "boolean_operands": ["outer", "hole"], "boolean_operation": "subtract"},
    }]}
    canonical = canonical_scene(scene)
    assert canonical.region_at(0, 0, 1) is None
    assert canonical.region_at(1.5, 0, 1) is not None
    selection = ModeledPrintSelection(canonical, 0.5)
    generated = generate_toolpath(selection, _calibration(), scene=scene, profile=PrinterProfile(sample_step_mm=4.0))
    assert generated.audit().passed
    assert generated.segments
    assert generated.report["canonical_scene_hash"] == canonical.source_hash
    assert generated.report["scene_manifest"] == scene
    for segment in generated.segments:
        midpoint = ((segment.start_xy_mm[0] + segment.end_xy_mm[0]) / 2, (segment.start_xy_mm[1] + segment.end_xy_mm[1]) / 2)
        scene_position = selection.scene_position(midpoint[0], midpoint[1], segment.z_mm)
        assert canonical.region_at(*scene_position) is not None
    assert any(abs(segment.start_xy_mm[0] - 1.0) < 1e-8 or abs(segment.end_xy_mm[0] - 1.0) < 1e-8 for segment in generated.segments)

    partial_scene = canonical_scene({"regions": [_box("partial", z=0.55, size=(2, 2, 1.1))]})
    partial = generate_toolpath(ModeledPrintSelection(partial_scene, 0.5), _calibration(), profile=PrinterProfile(sample_step_mm=2.0))
    assert {segment.layer_index for segment in partial.segments} == {0, 1, 2}


def test_modeled_only_engine_session_does_not_require_dicom_selection() -> None:
    scene = {"regions": [_box("solid")]}
    calibration = _calibration()
    payload = {
        "scene": scene,
        "calibration": calibration.to_dict(),
        "profile": {"printer": "Prusa XL", "sample_step_mm": 1.0},
    }
    with EngineSession() as session:
        result = session.handle(ControlEnvelope(request_id="modeled", operation=Operation.GENERATE_TOOLPATH, payload=payload))
    assert result["segment_count"] > 0
    assert result["selection"]["source"] == "canonical_manifold_scene"

    stale_volume = create_synthetic_volume(pattern="uniform", shape_zyx=(2, 4, 4), hu_min=0, hu_max=0)
    stale_selection = create_print_selection(stale_volume, plane="axial", mode="continuous", start_index=0, end_index=1, layer_height_mm=0.5)
    with EngineSession() as session:
        session.selection = stale_selection
        modeled_payload = {**payload, "generation_source": "modeled_scene"}
        modeled_result = session.handle(ControlEnvelope(request_id="modeled-after-dicom", operation=Operation.GENERATE_TOOLPATH, payload=modeled_payload))
        invalid_scene = {"regions": [{**_box("invalid"), "transform": {"position": {"x": 0, "y": 0, "z": 1}, "rotation": {"x": 0, "y": 0, "z": 0}, "scale": {"x": 0, "y": 4, "z": 2}}}]}
        with pytest.raises(GeometryValidationError, match="scale must be positive"):
            session.handle(ControlEnvelope(request_id="invalid-after-valid", operation=Operation.GENERATE_TOOLPATH, payload={**payload, "scene": invalid_scene, "generation_source": "modeled_scene"}))
        assert session.generated is None
    assert modeled_result["selection"]["source"] == "canonical_manifold_scene"


def test_scene_graph_visibility_unknown_cycle_and_transform_are_canonical() -> None:
    translated = canonical_scene({"regions": [_box("moved", x=5)]})
    assert translated.bounds == pytest.approx((3, -2, 0, 7, 2, 2))
    hidden = canonical_scene({"regions": [_box("visible"), _box("hidden", x=20, visible=False)]})
    assert hidden.bounds == pytest.approx((-2, -2, 0, 2, 2, 2))
    unknown = {"regions": [{**_box("result"), "geometry": {"kind": "group", "boolean_operands": ["missing", "also-missing"], "boolean_operation": "union"}}]}
    assert not validate_scene(unknown)["passed"]
    cyclic_regions = [
        {**_box("a"), "geometry": {"kind": "group", "boolean_operands": ["b", "solid"], "boolean_operation": "union"}},
        {**_box("b"), "geometry": {"kind": "group", "boolean_operands": ["a", "solid"], "boolean_operation": "union"}},
        _box("solid", visible=False),
    ]
    with pytest.raises(GeometryValidationError, match="missing or cyclic"):
        canonical_scene({"regions": cyclic_regions})
    overlap_a = _box("overlap-a")
    overlap_b = {**_box("overlap-b"), "target_hu": 200}
    overlap = canonical_scene({"regions": [overlap_a, overlap_b]})
    with pytest.raises(GeometryValidationError, match="ownership is ambiguous"):
        overlap.region_at(0, 0, 1)
    mixed_owner = [
        _box("left", x=-1, visible=False),
        {**_box("right", x=1, visible=False), "owner": "T1:support", "tool": "T1", "region": "support", "target_hu": 200},
        {**_box("union"), "geometry": {"kind": "group", "boolean_operands": ["left", "right"], "boolean_operation": "union"}},
    ]
    with pytest.raises(GeometryValidationError, match="cannot silently collapse"):
        canonical_scene({"regions": mixed_owner})


def test_imported_mesh_uses_current_manifold_mesh_contract() -> None:
    vertices = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]
    faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
    imported = {
        "id": "mesh",
        "kind": "imported_mesh",
        "owner": "T0:measurement",
        "region": "measurement",
        "tool": "T0",
        "target_hu": 0,
        "visible": True,
        "transform": {"position": {"x": 0, "y": 0, "z": 0}, "rotation": {"x": 0, "y": 0, "z": 0}, "scale": {"x": 1, "y": 1, "z": 1}},
        "geometry": {"kind": "imported_mesh", "dimensions": {"x": 1, "y": 1, "z": 1}, "vertices": vertices, "faces": faces},
    }
    scene = canonical_scene({"regions": [imported]})
    assert scene.bounds == pytest.approx((0, 0, 0, 1, 1, 1))
    assert scene.region_at(0.5, 0.5, 0.5) is not None

    malformed = {**imported, "geometry": {**imported["geometry"], "faces": [[0.9, 2, 1], *faces[1:]]}}
    result = validate_scene({"regions": [malformed]})
    assert not result["passed"]
    assert any("indices must be integers" in error for error in result["errors"])


def test_imported_stl_uses_scoped_path_and_content_hash(tmp_path: Path) -> None:
    vertices = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0), (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]
    faces = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)]
    source = tmp_path / "cube.stl"
    lines = ["solid cube"]
    for face in faces:
        lines.extend(["facet normal 0 0 0", "outer loop", *(f"vertex {vertices[index][0]} {vertices[index][1]} {vertices[index][2]}" for index in face), "endloop", "endfacet"])
    lines.append("endsolid cube")
    source.write_text("\n".join(lines), encoding="ascii")
    imported = {
        "id": "mesh-path",
        "kind": "fixture",
        "owner": "T0:measurement",
        "region": "measurement",
        "tool": "T0",
        "target_hu": 0,
        "visible": True,
        "source_path": str(source),
        "transform": {"position": {"x": 0, "y": 0, "z": 0}, "rotation": {"x": 0, "y": 0, "z": 0}, "scale": {"x": 1, "y": 1, "z": 1}},
        "geometry": {"kind": "fixture", "dimensions": {"x": 1, "y": 1, "z": 1}},
    }
    scene = {"regions": [imported]}
    assert validate_scene(scene)["passed"]
    canonical = canonical_scene(scene)
    assert canonical.region_at(0.5, 0.5, 0.5) is not None
    first_hash = canonical.source_hash
    source.write_text(source.read_text(encoding="ascii") + "\n", encoding="ascii")
    assert canonical_scene(scene).source_hash != first_hash


def test_imported_3mf_applies_units_and_build_transform(tmp_path: Path) -> None:
    source = tmp_path / "cube.3mf"
    model = """<?xml version="1.0" encoding="UTF-8"?>
<model unit="inch" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources><object id="1" type="model"><mesh><vertices>
    <vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="1" y="1" z="0"/><vertex x="0" y="1" z="0"/>
    <vertex x="0" y="0" z="1"/><vertex x="1" y="0" z="1"/><vertex x="1" y="1" z="1"/><vertex x="0" y="1" z="1"/>
  </vertices><triangles>
    <triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="3" v3="2"/><triangle v1="4" v2="5" v3="6"/><triangle v1="4" v2="6" v3="7"/>
    <triangle v1="0" v2="1" v3="5"/><triangle v1="0" v2="5" v3="4"/><triangle v1="1" v2="2" v3="6"/><triangle v1="1" v2="6" v3="5"/>
    <triangle v1="2" v2="3" v3="7"/><triangle v1="2" v2="7" v3="6"/><triangle v1="3" v2="0" v3="4"/><triangle v1="3" v2="4" v3="7"/>
  </triangles></mesh></object></resources>
  <build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 1 0 0"/></build>
</model>"""
    with ZipFile(source, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("3D/3dmodel.model", model)
    region = {
        "id": "3mf-path", "kind": "fixture", "owner": "T0:measurement", "region": "measurement", "tool": "T0", "target_hu": 0, "visible": True,
        "source_path": str(source),
        "transform": {"position": {"x": 0, "y": 0, "z": 0}, "rotation": {"x": 0, "y": 0, "z": 0}, "scale": {"x": 25.4, "y": 25.4, "z": 25.4}},
        "geometry": {"kind": "fixture", "dimensions": {"x": 25.4, "y": 25.4, "z": 25.4}},
    }
    scene = canonical_scene({"regions": [region]})
    assert scene.bounds == pytest.approx((25.4, 0.0, 0.0, 50.8, 25.4, 25.4))


@pytest.mark.parametrize("kind", ["cylinder", "polygon_prism", "wedge"])
def test_curved_and_rotated_canonical_solids_survive_gcode_rounding(kind: str) -> None:
    region = _box("shape", z=1, size=(4, 2, 2))
    region["kind"] = kind
    region["transform"] = {"position": {"x": 0, "y": 0, "z": 1}, "rotation": {"x": 0, "y": 0, "z": 30}, "scale": {"x": 4, "y": 2, "z": 2}}
    region["geometry"] = {"kind": kind, "dimensions": {"x": 4, "y": 2, "z": 2}, "polygon_sides": 6}
    selection = ModeledPrintSelection(canonical_scene({"regions": [region]}), 0.5)
    generated = generate_toolpath(selection, _calibration(), profile=PrinterProfile(sample_step_mm=0.5))
    assert generated.segments
    assert generated.audit().passed


def test_combined_dicom_and_modeled_solid_uses_explicit_tool_ownership() -> None:
    volume = create_synthetic_volume(pattern="uniform", shape_zyx=(2, 8, 8), hu_min=0, hu_max=0)
    selection = create_print_selection(volume, plane="axial", mode="continuous", start_index=0, end_index=1, print_size_mm=(8, 8, 2), layer_height_mm=0.5)
    support = _box("support", z=0, size=(2, 2, 2))
    support.update({"owner": "T1:support", "tool": "T1", "region": "support", "target_hu": 200})
    scene = {
        "regions": [
            {"id": "dicom", "kind": "dicom", "owner": "T0:measurement", "region": "measurement", "tool": "T0", "visible": True},
            support,
        ]
    }
    generated = generate_toolpath(selection, [_calibration("T0"), _calibration("T1")], scene=scene, profile=PrinterProfile(sample_step_mm=4.0))
    assert {segment.tool for segment in generated.segments} == {"T0", "T1"}
    assert all(segment.region == "support" for segment in generated.segments if segment.tool == "T1")
    assert all(segment.region == "measurement_roi" for segment in generated.segments if segment.tool == "T0")
    assert all(segment.source_hu == 0 and segment.target_hu == 200 for segment in generated.segments if segment.tool == "T1")
