"""Deterministic, non-patient fixtures for tests and reproducibility examples."""

from __future__ import annotations

from pathlib import Path

import numpy as np
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import UID, CTImageStorage, ExplicitVRLittleEndian

from .dicom import Volume


def create_synthetic_volume(
    *,
    pattern: str = "ramp",
    shape_zyx: tuple[int, int, int] = (8, 16, 20),
    spacing_mm: tuple[float, float, float] = (1.0, 1.0, 1.0),
    hu_min: float = -900.0,
    hu_max: float = 900.0,
) -> Volume:
    """Create a deterministic volume without reading or embedding patient data."""

    if len(shape_zyx) != 3 or any(int(item) < 2 for item in shape_zyx):
        raise ValueError("Synthetic volume shape must contain at least two samples per axis.")
    z_count, y_count, x_count = (int(item) for item in shape_zyx)
    z = np.linspace(0.0, 1.0, z_count, dtype=np.float32)[:, None, None]
    y = np.linspace(0.0, 1.0, y_count, dtype=np.float32)[None, :, None]
    x = np.linspace(0.0, 1.0, x_count, dtype=np.float32)[None, None, :]
    if pattern == "uniform":
        normalized = np.full(shape_zyx, 0.5, dtype=np.float32)
    elif pattern == "ramp":
        normalized = np.broadcast_to((0.2 * z + 0.3 * y + 0.5 * x), shape_zyx).astype(np.float32)
    elif pattern == "checkerboard":
        normalized = (((np.floor(x * 6) + np.floor(y * 6) + np.floor(z * 4)) % 2) * 0.8 + 0.1).astype(np.float32)
        normalized = np.broadcast_to(normalized, shape_zyx).copy()
    elif pattern == "radial":
        radius = np.sqrt((x - 0.5) ** 2 + (y - 0.5) ** 2 + (z - 0.5) ** 2)
        normalized = np.broadcast_to(np.clip(1.0 - radius / np.sqrt(0.75), 0.0, 1.0), shape_zyx).astype(np.float32)
    elif pattern == "phantom":
        normalized = np.full(shape_zyx, 0.04, dtype=np.float32)
        body = ((x - 0.5) / 0.43) ** 2 + ((y - 0.5) / 0.38) ** 2 + ((z - 0.5) / 0.48) ** 2 <= 1.0
        lung = ((x - 0.35) / 0.14) ** 2 + ((y - 0.5) / 0.25) ** 2 + ((z - 0.5) / 0.35) ** 2 <= 1.0
        normalized[body] = 0.52
        normalized[lung & body] = 0.16
        bone = ((x - 0.68) / 0.09) ** 2 + ((y - 0.54) / 0.10) ** 2 + ((z - 0.5) / 0.25) ** 2 <= 1.0
        normalized[bone & body] = 0.92
    else:
        raise ValueError("Synthetic pattern must be uniform, ramp, checkerboard, radial, or phantom.")
    hu = hu_min + normalized * (hu_max - hu_min)
    return Volume(
        hu=hu.astype(np.float32),
        spacing_mm=spacing_mm,
        origin_lps=np.zeros(3, dtype=np.float64),
        direction_lps=np.eye(3, dtype=np.float64),
        series_uid="2.25.999999999999999999999999999999.synthetic",
        metadata={"source": "synthetic_fixture", "pattern": pattern, "patient_identifiers": "none"},
    )


def write_synthetic_dicom_series(
    directory: str | Path,
    *,
    volume: Volume | None = None,
    pattern: str = "ramp",
    shape_zyx: tuple[int, int, int] = (4, 8, 10),
    spacing_mm: tuple[float, float, float] = (1.0, 1.0, 1.0),
    slope: float = 1.0,
    intercept: float = 0.0,
    unsigned_storage: bool = False,
    multiframe: bool = False,
    localizer: bool = False,
) -> list[Path]:
    """Write deterministic anonymized CT instances for tests; never accepts patient tags."""

    source = volume or create_synthetic_volume(pattern=pattern, shape_zyx=shape_zyx, spacing_mm=spacing_mm)
    target = Path(directory)
    target.mkdir(parents=True, exist_ok=True)
    z_count, rows, columns = source.shape_zyx
    dz, dy, dx = source.spacing_mm
    stable_uid = str(int(source.source_hash[:20], 16))
    study_uid = f"2.25.{stable_uid}1"
    series_uid = f"2.25.{stable_uid}2"
    frame_uid = f"2.25.{stable_uid}3"
    stored = np.rint((source.hu - intercept) / slope)
    if unsigned_storage:
        stored = np.clip(stored + 32768, 0, 65535).astype(np.uint16)
        storage_intercept = float(intercept - 32768 * slope)
        pixel_representation = 0
    else:
        stored = np.clip(stored, -32768, 32767).astype(np.int16)
        storage_intercept = float(intercept)
        pixel_representation = 1
    written: list[Path] = []
    common = {
        "StudyInstanceUID": study_uid,
        "SeriesInstanceUID": series_uid,
        "FrameOfReferenceUID": frame_uid,
        "Modality": "CT",
        "PatientName": "SYNTHETIC",
        "PatientID": "SYNTHETIC-NO-PHI",
        "SeriesDescription": "Synthetic VoxelWeave fixture" + (" LOCALIZER" if localizer else ""),
        "ProtocolName": "VoxelWeave deterministic test",
        "ImageOrientationPatient": [1, 0, 0, 0, 1, 0],
        "PixelSpacing": [dy, dx],
        "SliceThickness": dz,
        "SpacingBetweenSlices": dz,
        "RescaleSlope": slope,
        "RescaleIntercept": storage_intercept,
        "RescaleType": "HU",
        "SamplesPerPixel": 1,
        "PhotometricInterpretation": "MONOCHROME2",
        "BitsAllocated": 16,
        "BitsStored": 16,
        "HighBit": 15,
        "PixelRepresentation": pixel_representation,
        "Rows": rows,
        "Columns": columns,
    }
    if multiframe:
        meta = FileMetaDataset()
        meta.MediaStorageSOPClassUID = CTImageStorage
        meta.MediaStorageSOPInstanceUID = UID(f"2.25.{stable_uid}100")
        meta.TransferSyntaxUID = ExplicitVRLittleEndian
        meta.ImplementationClassUID = UID(f"2.25.{stable_uid}101")
        path = target / "synthetic_multiframe.dcm"
        ds = FileDataset(str(path), {}, file_meta=meta, preamble=b"\0" * 128)
        for key, value in common.items():
            setattr(ds, key, value)
        ds.NumberOfFrames = z_count
        ds.ImagePositionPatient = [0.0, 0.0, 0.0]
        ds.PixelData = np.ascontiguousarray(stored).tobytes()
        try:
            ds.save_as(str(path), enforce_file_format=True)
        except TypeError:
            ds.save_as(str(path), write_like_original=False)
        return [path]
    for z_index in range(z_count):
        meta = FileMetaDataset()
        meta.MediaStorageSOPClassUID = CTImageStorage
        meta.MediaStorageSOPInstanceUID = UID(f"2.25.{stable_uid}{100 + z_index}")
        meta.TransferSyntaxUID = ExplicitVRLittleEndian
        meta.ImplementationClassUID = UID(f"2.25.{stable_uid}101")
        path = target / f"synthetic_{z_index:04d}.dcm"
        ds = FileDataset(str(path), {}, file_meta=meta, preamble=b"\0" * 128)
        for key, value in common.items():
            setattr(ds, key, value)
        ds.SOPClassUID = CTImageStorage
        ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
        ds.ImagePositionPatient = [0.0, 0.0, z_index * dz]
        ds.InstanceNumber = z_index + 1
        ds.PixelData = np.ascontiguousarray(stored[z_index]).tobytes()
        try:
            ds.save_as(str(path), enforce_file_format=True)
        except TypeError:
            ds.save_as(str(path), write_like_original=False)
        written.append(path)
    return written


def synthetic_scan_back(volume: Volume, *, noise_hu: float = 0.0, seed: int = 20260804) -> Volume:
    """Create scan-back-shaped synthetic evidence while preserving its non-clinical boundary."""

    if noise_hu < 0:
        raise ValueError("Synthetic scan-back noise must be non-negative.")
    rng = np.random.default_rng(seed)
    noise = rng.normal(0.0, noise_hu, size=volume.hu.shape).astype(np.float32) if noise_hu else 0.0
    return Volume(
        hu=(volume.hu + noise).astype(np.float32),
        spacing_mm=volume.spacing_mm,
        origin_lps=volume.origin_lps.copy(),
        direction_lps=volume.direction_lps.copy(),
        series_uid="2.25.999999999999999999999999999998.synthetic_scanback",
        metadata={"source": "synthetic_scan_back_fixture", "noise_hu": noise_hu, "physical_fidelity_claim": "not_established"},
    )
