"""Stateful sidecar-facing facade for the versioned engine operations."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from tempfile import mkdtemp
from threading import Lock
from typing import Any, cast

from .binary import write_binary_array
from .calibration import Calibration, CalibrationSet
from .dicom import DicomInspection, Volume, inspect_dicom_source, load_dicom_series, select_dicom_series
from .errors import EngineError, ProtocolError
from .models import CancellationToken, ProgressCallback
from .mpr import (
    build_volume_cache,
    calculate_histogram,
    request_mpr_plane,
    request_volume_preview,
    sample_voxel,
)
from .protocol import ControlEnvelope, Operation
from .scanback import verify_scan_back
from .selection import create_print_selection
from .synthetic import synthetic_scan_back, write_synthetic_dicom_series
from .toolpath import PrinterProfile, export_run_package, generate_toolpath, reverse_audit_gcode


@dataclass(slots=True)
class EngineSession:
    """In-process equivalent of the Python sidecar lifecycle.

    The session keeps arrays on the Python side. Control responses return bounded
    metadata and scoped artifact references, not volume or toolpath arrays.
    """

    inspection: DicomInspection | None = None
    source: str | None = None
    volume: Volume | None = None
    selection: Any | None = None
    generated: Any | None = None
    _cancellations: dict[str, CancellationToken] = field(default_factory=dict)
    _cancellation_lock: Lock = field(default_factory=Lock)
    _workspace: Path = field(default_factory=lambda: Path(mkdtemp(prefix="voxelweave-sidecar-")))

    def _token(self, request_id: str) -> CancellationToken:
        with self._cancellation_lock:
            token = self._cancellations.get(request_id)
            if token is None:
                token = CancellationToken()
                self._cancellations[request_id] = token
        return token

    def register_request(self, request_id: str) -> None:
        """Reserve a cooperative token before a worker thread starts."""

        self._token(request_id)

    def cancel(self, request_id: str) -> dict[str, Any]:
        with self._cancellation_lock:
            token = self._cancellations.get(request_id)
        if token is None:
            return {"request_id": request_id, "cancelled": False, "reason": "unknown_request"}
        token.cancel()
        return {"request_id": request_id, "cancelled": True}

    def _resolve_source(self, source: str) -> str:
        """Resolve the explicit non-PHI synthetic fixture URI used by desktop smoke flows."""

        if not source.startswith("synthetic://"):
            return source
        fixture_name = source.removeprefix("synthetic://").strip("/").replace("/", "-") or "fixture"
        fixture_path = self._workspace / "fixtures" / fixture_name
        if not any(fixture_path.glob("*.dcm")):
            if fixture_name.endswith("scan-back"):
                if self.volume is None:
                    raise EngineError("Create the synthetic source before requesting synthetic scan-back evidence.")
                write_synthetic_dicom_series(fixture_path, volume=synthetic_scan_back(self.volume, noise_hu=2.0))
            else:
                write_synthetic_dicom_series(
                    fixture_path,
                    pattern="phantom",
                    shape_zyx=(12, 32, 40),
                    spacing_mm=(1.0, 1.0, 1.0),
                )
        return str(fixture_path)

    def _workspace_path(self, value: object, default_name: str) -> str:
        candidate = Path(str(value)) if value is not None else Path(default_name)
        if not candidate.is_absolute():
            candidate = self._workspace / candidate
        return str(candidate)

    def _require_volume(self) -> Volume:
        if self.volume is None:
            raise EngineError("No DICOM volume is loaded; inspect and select a complete CT series first.")
        return self.volume

    def handle(self, envelope: ControlEnvelope, *, progress: ProgressCallback | None = None) -> dict[str, Any]:
        if envelope.operation == Operation.CANCEL:
            target = str(envelope.payload.get("request_id", ""))
            return self.cancel(target)
        token = self._token(envelope.request_id)
        callback = progress or (lambda _event: None)
        payload = envelope.payload
        try:
            op = envelope.operation
            if op == Operation.INSPECT_DICOM_SOURCE:
                self.source = self._resolve_source(str(payload["source"]))
                self.inspection = inspect_dicom_source(self.source, request_id=envelope.request_id, cancellation=token, progress=callback)
                return self.inspection.to_dict()
            if op == Operation.SELECT_DICOM_SERIES:
                source = self._resolve_source(str(payload["source"])) if payload.get("source") is not None else self.source
                if source is None:
                    raise EngineError("Select a DICOM source before selecting a series.")
                inspection = self.inspection if source == self.source and self.inspection is not None else inspect_dicom_source(source, request_id=envelope.request_id, cancellation=token, progress=callback)
                summary = select_dicom_series(inspection, series_uid=payload.get("series_uid"))
                if self.volume is None or self.volume.series_uid != summary.series_uid:
                    self.volume = load_dicom_series(source, series_uid=summary.series_uid, request_id=envelope.request_id, cancellation=token, progress=callback)
                return summary.to_dict()
            if op == Operation.BUILD_VOLUME_CACHE:
                result = build_volume_cache(self._require_volume(), self._workspace_path(payload.get("directory"), "cache"), request_id=envelope.request_id, cancellation=token, progress=callback)
                return result
            if op == Operation.REQUEST_MPR_PLANE:
                plane = request_mpr_plane(
                    self._require_volume(),
                    cast(Any, str(payload["plane"])),
                    index=payload.get("index"),
                    coordinate_mm=payload.get("coordinate_mm"),
                    output_shape_yx=tuple(payload["output_shape_yx"]) if payload.get("output_shape_yx") else None,
                    method=str(payload.get("method", "linear")),
                    cancellation=token,
                )
                if payload.get("output_path"):
                    artifact = write_binary_array(self._workspace_path(payload["output_path"], "mpr-plane.bin"), plane.array, artifact_type="mpr_plane", metadata=plane.to_dict())
                    return {"plane": plane.to_dict(), "artifact": {"path": artifact.path.name, "sha256": artifact.sha256, "header": artifact.header}}
                return plane.to_dict()
            if op == Operation.REQUEST_VOLUME_PREVIEW:
                preview = request_volume_preview(self._require_volume(), max_dimension=int(payload.get("max_dimension", 128)), cancellation=token)
                if payload.get("output_path"):
                    artifact = write_binary_array(
                        self._workspace_path(payload["output_path"], "volume-preview.bin"),
                        preview.array,
                        artifact_type="volume_preview",
                        metadata={
                            **preview.to_dict(),
                            "origin_lps": [float(item) for item in self._require_volume().origin_lps],
                            "direction_lps": [[float(item) for item in row] for row in self._require_volume().direction_lps],
                        },
                    )
                    return {"preview": preview.to_dict(), "artifact": {"path": artifact.path.name, "sha256": artifact.sha256, "header": artifact.header}}
                return preview.to_dict()
            if op == Operation.SAMPLE_VOXEL:
                return {"hu": sample_voxel(self._require_volume(), tuple(payload["position_lps"]), method=str(payload.get("method", "linear")))}
            if op == Operation.CALCULATE_HISTOGRAM:
                return calculate_histogram(self._require_volume(), bins=int(payload.get("bins", 256)))
            if op == Operation.CREATE_PRINT_SELECTION:
                self.selection = create_print_selection(self._require_volume(), **dict(payload))
                return self.selection.manifest.to_dict()
            if op == Operation.VALIDATE_SCENE:
                return validate_scene(payload.get("scene", payload))
            if op == Operation.GENERATE_TOOLPATH:
                if self.selection is None:
                    raise EngineError("Create a print selection before generating a toolpath.")
                calibration_value = payload.get("calibration")
                if calibration_value is None:
                    raise EngineError("Generation requires an explicit calibration object.")
                calibration: Calibration | CalibrationSet
                if isinstance(calibration_value, list):
                    calibration = CalibrationSet.from_iterable(Calibration.from_dict(item) for item in calibration_value)
                else:
                    calibration = Calibration.from_dict(dict(calibration_value))
                self.generated = generate_toolpath(
                    self.selection,
                    calibration,
                    profile=PrinterProfile(**dict(payload.get("profile", {}))),
                    tool=(str(payload["tool"]) if payload.get("tool") is not None else None),
                    allow_calibration_clipping=bool(payload.get("allow_calibration_clipping", False)),
                    request_id=envelope.request_id,
                    cancellation=token,
                    progress=callback,
                )
                return {**self.generated.report, "gcode_sha256": self.generated.gcode_sha256, "audit": self.generated.audit().to_dict()}
            if op == Operation.REVERSE_AUDIT_GCODE:
                target = payload.get("path", payload.get("gcode"))
                if target is None:
                    if self.generated is None:
                        raise ProtocolError("reverse_audit_gcode requires path or gcode.")
                    return reverse_audit_gcode(self.generated.gcode_text, expected=self.generated).to_dict()
                return reverse_audit_gcode(target, expected=self.generated).to_dict()
            if op == Operation.EXPORT_RUN_PACKAGE:
                if self.generated is None:
                    raise EngineError("Generate and audit a toolpath before exporting its run package.")
                return export_run_package(self.generated, self._workspace_path(payload.get("directory"), "run-package"))
            if op == Operation.VERIFY_SCAN_BACK:
                scan_back_source = self._resolve_source(str(payload["scan_back_source"]))
                scan_back = load_dicom_series(scan_back_source, series_uid=payload.get("series_uid"), request_id=envelope.request_id, cancellation=token, progress=callback)
                verification = verify_scan_back(
                    self._require_volume(),
                    scan_back,
                    registration_method=str(payload.get("registration_method", "identity")),
                    registration_confidence=float(payload.get("registration_confidence", 1.0)),
                    translation_voxel_zyx=tuple(payload.get("translation_voxel_zyx", (0, 0, 0))),
                    hu_gamma_tolerance_hu=float(payload.get("hu_gamma_tolerance_hu", 40.0)),
                    expected_source_hash=payload.get("expected_source_hash"),
                )
                return verification.to_dict()
            raise ProtocolError(f"Unsupported operation: {op.value}")
        finally:
            with self._cancellation_lock:
                self._cancellations.pop(envelope.request_id, None)


def validate_scene(scene: Mapping[str, Any]) -> dict[str, Any]:
    """Validate the bounded scene contract without claiming canonical CSG fidelity."""

    errors: list[str] = []
    warnings: list[str] = []
    regions = scene.get("regions", [])
    if not isinstance(regions, list):
        errors.append("Scene regions must be an array.")
        regions = []
    identifiers: set[str] = set()
    for region in regions:
        if not isinstance(region, Mapping):
            errors.append("Every scene region must be an object with explicit ownership.")
            continue
        identifier = str(region.get("id", ""))
        if not identifier or identifier in identifiers:
            errors.append("Scene region identifiers must be unique and non-empty.")
        identifiers.add(identifier)
        if not region.get("owner"):
            errors.append(f"Scene region {identifier or '<unnamed>'} has no material/tool owner.")
        if region.get("ambiguous_overlap"):
            errors.append(f"Scene region {identifier or '<unnamed>'} has an ambiguous overlap.")
        if region.get("boolean_operands") and not isinstance(region["boolean_operands"], list):
            errors.append(f"Scene region {identifier or '<unnamed>'} has invalid Boolean operands.")
    if not regions:
        warnings.append("Scene contains no printable regions.")
    return {
        "schema": "voxelweave.scene-validation.v1",
        "passed": not errors,
        "errors": errors,
        "warnings": warnings,
        "physical_geometry_claim": "canonical_geometry_validation_required_for_generation",
    }
