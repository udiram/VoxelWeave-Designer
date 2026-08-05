from __future__ import annotations

import numpy as np
import pytest

from voxelweave import (
    calculate_histogram,
    create_print_selection,
    create_synthetic_volume,
    request_mpr_plane,
    request_volume_preview,
    sample_voxel,
)
from voxelweave.errors import GeometryValidationError


def test_mpr_planes_use_physical_source_and_preview_is_derived() -> None:
    volume = create_synthetic_volume(pattern="ramp", shape_zyx=(6, 8, 10), spacing_mm=(2.0, 1.0, 0.5), hu_min=-100, hu_max=900)
    axial = request_mpr_plane(volume, "axial", index=2)
    sagittal = request_mpr_plane(volume, "sagittal", index=4)
    coronal = request_mpr_plane(volume, "coronal", index=3)
    assert axial.array.shape == (8, 10)
    assert sagittal.array.shape == (6, 8)
    assert coronal.array.shape == (6, 10)
    assert axial.source_hash == volume.source_hash
    assert sample_voxel(volume, (2.0, 3.0, 4.0)) == volume.sample((2.0, 3.0, 4.0))

    small = request_volume_preview(volume, max_dimension=4)
    larger = request_volume_preview(volume, max_dimension=10)
    assert max(small.array.shape) <= 4
    assert max(larger.array.shape) <= 10
    assert small.source_hash == larger.source_hash == volume.source_hash
    histogram = calculate_histogram(volume, bins=16)
    assert sum(histogram["counts"]) == int(np.prod(volume.shape_zyx))


def test_preview_defaults_to_block_average_and_preserves_source() -> None:
    from voxelweave.dicom import Volume

    source = np.arange(64, dtype=np.float32).reshape(4, 4, 4)
    volume = Volume(source.copy(), (1.0, 1.0, 1.0), np.zeros(3), np.eye(3), "preview-average")
    before = volume.hu.copy()
    preview = request_volume_preview(volume, max_dimension=2)
    expected = source.reshape(2, 2, 2, 2, 2, 2).mean(axis=(1, 3, 5))
    np.testing.assert_allclose(preview.array, expected)
    assert preview.to_dict()["resampling"] == "block_average_signed_hu"
    np.testing.assert_array_equal(volume.hu, before)


def test_continuous_tile_and_single_selection_contracts() -> None:
    volume = create_synthetic_volume(pattern="ramp", shape_zyx=(8, 8, 8), spacing_mm=(1.0, 1.0, 1.0), hu_min=0, hu_max=700)
    continuous = create_print_selection(
        volume,
        plane="axial",
        mode="continuous",
        start_index=1,
        end_index=4,
        layer_height_mm=1.0,
    )
    assert continuous.selected_source_indices == (1, 2, 3, 4)
    assert continuous.manifest.resampling == "full_resolution_signed_hu_at_printer_layer_centers"
    first_layer = continuous.sample_hu(4.0, 4.0, 0.5)
    last_layer = continuous.sample_hu(4.0, 4.0, 3.5)
    assert first_layer != last_layer

    tile = create_print_selection(
        volume,
        plane="sagittal",
        mode="tile",
        start_index=1,
        end_index=6,
        stride=2,
        layer_height_mm=0.5,
        plate_layout={"columns": 2},
        labels=("A", "B", "C"),
    )
    assert tile.selected_source_indices == (1, 3, 5)
    assert tile.manifest.plate_layout["rows"] == 2
    assert [item["label"] for item in tile.manifest.structural_regions] == ["A", "B", "C"]
    assert tile.manifest.structural_regions[0]["region"] == "structural_outside_measurement_roi"
    assert len(tile.manifest.tile_source_to_print_transforms) == 3
    assert [item["source_index"] for item in tile.manifest.tile_source_to_print_transforms] == [1, 3, 5]
    assert [item["matrix"][0][3] for item in tile.manifest.tile_source_to_print_transforms] == [1.0, 3.0, 5.0]
    assert all(item["matrix"][0][2] == 0.0 for item in tile.manifest.tile_source_to_print_transforms)
    with pytest.raises(GeometryValidationError, match="Tile thickness must agree"):
        create_print_selection(
            volume,
            plane="sagittal",
            mode="tile",
            start_index=1,
            end_index=2,
            thickness_mm=0.5,
            print_size_mm=(8.0, 8.0, 0.5),
            plate_layout={"columns": 2, "tile_thickness_mm": 0.7},
        )

    single = create_print_selection(volume, plane="coronal", mode="single", plane_index=3, thickness_mm=2.0, layer_height_mm=1.0)
    assert single.selected_source_indices == (3,)
    assert single.print_size_mm[2] == 2.0
    assert single.manifest.source_bounds_voxel_xyz[0][1] == 3.0
    assert single.manifest.source_bounds_voxel_xyz[1][1] == 3.0
    assert single.manifest.source_to_print_transform[1][2] == 0.0
    assert single.manifest.source_to_print_transform[1][3] == 3.0


def test_continuous_range_samples_only_selected_slab_endpoints() -> None:
    hu = np.zeros((8, 4, 4), dtype=np.float32)
    for z_index in range(8):
        hu[z_index, :, :] = z_index * 1000.0
    from voxelweave.dicom import Volume

    volume = Volume(
        hu=hu,
        spacing_mm=(2.0, 1.0, 1.0),
        origin_lps=np.zeros(3),
        direction_lps=np.eye(3),
        series_uid="synthetic-slab",
    )
    selection = create_print_selection(
        volume,
        plane="axial",
        mode="continuous",
        start_index=2,
        end_index=4,
        layer_height_mm=1.0,
        print_size_mm=(4.0, 4.0, 6.0),
    )
    assert selection.sample_hu(2.0, 2.0, 0.0, method="nearest") == 2000.0
    assert selection.sample_hu(2.0, 2.0, 6.0, method="nearest") == 4000.0
    assert selection.manifest.source_bounds_voxel_xyz[0][2] == 2.0
    assert selection.manifest.source_bounds_voxel_xyz[1][2] == 4.0
