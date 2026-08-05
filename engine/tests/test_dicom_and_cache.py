from __future__ import annotations

import zipfile
from pathlib import Path

import numpy as np
import pydicom
import pytest

from voxelweave import (
    CancellationError,
    CancellationToken,
    DicomValidationError,
    build_volume_cache,
    create_synthetic_volume,
    inspect_dicom_source,
    load_dicom_series,
    read_binary_array,
    select_dicom_series,
    write_synthetic_dicom_series,
)


def test_complete_series_signed_unsigned_and_multiframe(tmp_path: Path) -> None:
    source = create_synthetic_volume(pattern="ramp", shape_zyx=(4, 5, 6), spacing_mm=(1.5, 0.8, 0.7), hu_min=-900, hu_max=900)
    signed_dir = tmp_path / "signed"
    unsigned_dir = tmp_path / "unsigned"
    multiframe_dir = tmp_path / "multiframe"
    write_synthetic_dicom_series(signed_dir, volume=source)
    write_synthetic_dicom_series(unsigned_dir, volume=source, unsigned_storage=True)
    write_synthetic_dicom_series(multiframe_dir, volume=source, multiframe=True)

    signed = load_dicom_series(signed_dir)
    unsigned = load_dicom_series(unsigned_dir)
    multiframe = load_dicom_series(multiframe_dir)
    assert signed.shape_zyx == (4, 5, 6)
    assert signed.spacing_mm == (1.5, 0.8, 0.7)
    np.testing.assert_allclose(signed.hu, source.hu, atol=1.0)
    np.testing.assert_allclose(unsigned.hu, signed.hu, atol=1.0)
    np.testing.assert_allclose(multiframe.hu, signed.hu, atol=1.0)

    inspection = inspect_dicom_source(multiframe_dir)
    summary = select_dicom_series(inspection)
    assert summary.multiframe
    assert inspection.to_dict()["source_label"] == "<dicom-source>"
    assert "PatientName" not in str(inspection.to_dict())


def test_localizer_and_duplicate_positions_fail_closed(tmp_path: Path) -> None:
    localizer_dir = tmp_path / "localizer"
    write_synthetic_dicom_series(localizer_dir, localizer=True)
    inspection = inspect_dicom_source(localizer_dir)
    assert not inspection.eligible_series
    assert inspection.series[0].exclusion_reason == "localizer_or_scout"

    duplicate_dir = tmp_path / "duplicate"
    files = write_synthetic_dicom_series(duplicate_dir, shape_zyx=(3, 4, 4))
    first = pydicom.dcmread(str(files[1]))
    first.ImagePositionPatient = [0.0, 0.0, 0.0]
    first.save_as(str(files[1]))
    with pytest.raises(DicomValidationError, match="duplicate"):
        load_dicom_series(duplicate_dir)

    missing_dir = tmp_path / "missing-position"
    missing_files = write_synthetic_dicom_series(missing_dir, shape_zyx=(3, 4, 4))
    missing = pydicom.dcmread(str(missing_files[1]))
    del missing.ImagePositionPatient
    missing.save_as(str(missing_files[1]))
    assert not inspect_dicom_source(missing_dir).eligible_series
    with pytest.raises(DicomValidationError, match="eligible CT series"):
        load_dicom_series(missing_dir)

    tilt_dir = tmp_path / "tilt"
    tilt_files = write_synthetic_dicom_series(tilt_dir, shape_zyx=(3, 4, 4))
    tilted = pydicom.dcmread(str(tilt_files[1]))
    tilted.ImagePositionPatient = [0.5, 0.0, 1.0]
    tilted.save_as(str(tilt_files[1]))
    tilt_inspection = inspect_dicom_source(tilt_dir)
    assert tilt_inspection.series[0].orientation["gantry_tilt_detected"]
    with pytest.raises(DicomValidationError, match="gantry tilt"):
        load_dicom_series(tilt_dir)


def test_typed_volume_cache_round_trip(tmp_path: Path) -> None:
    volume = create_synthetic_volume(pattern="checkerboard", shape_zyx=(5, 6, 7))
    report = build_volume_cache(volume, tmp_path / "cache", preview_dimensions=(8, 4))
    array, header = read_binary_array(tmp_path / "cache" / "volume_hu.bin")
    np.testing.assert_array_equal(array, volume.hu)
    assert header["artifact_type"] == "signed_hu_volume"
    assert header["dtype"] == "<f4"
    assert header["shape"] == [5, 6, 7]
    assert report["scientific_source"]["sha256"] == header["payload_sha256"]


def test_progress_has_request_identity_and_cancellation_is_cooperative(tmp_path: Path) -> None:
    source_dir = tmp_path / "progress"
    write_synthetic_dicom_series(source_dir, shape_zyx=(4, 4, 4))
    events = []
    inspection = inspect_dicom_source(source_dir, request_id="req-123", progress=events.append)
    assert inspection.eligible_series
    assert events and all(event.request_id == "req-123" for event in events)
    token = CancellationToken()
    token.cancel()
    with pytest.raises(CancellationError):
        inspect_dicom_source(source_dir, cancellation=token)


def test_zip_and_explicit_file_sources_and_metadata_first_inspection(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source_dir = tmp_path / "zip-source"
    files = write_synthetic_dicom_series(source_dir, shape_zyx=(3, 4, 4))
    archive = tmp_path / "series.zip"
    with zipfile.ZipFile(archive, "w") as handle:
        for path in files:
            handle.write(path, arcname=path.name)

    import pydicom

    calls: list[bool] = []
    original = pydicom.dcmread

    def recording_dcmread(*args: object, **kwargs: object) -> object:
        calls.append(bool(kwargs.get("stop_before_pixels")))
        return original(*args, **kwargs)

    monkeypatch.setattr(pydicom, "dcmread", recording_dcmread)
    inspection = inspect_dicom_source(archive)
    assert inspection.eligible_series
    assert calls and all(calls)
    loaded = load_dicom_series([files[0], files[1], files[2]])
    assert loaded.shape_zyx == (3, 4, 4)
    assert any(not value for value in calls)
