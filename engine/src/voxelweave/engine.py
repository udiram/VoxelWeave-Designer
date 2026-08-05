"""Stateful sidecar-facing facade for the versioned engine operations."""

from __future__ import annotations

import shutil
from collections.abc import Mapping
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from tempfile import mkdtemp
from threading import Lock
from typing import Any, cast
from uuid import uuid4

import numpy as np

from .binary import write_binary_array
from .calibration import Calibration, CalibrationSet
from .dicom import DicomInspection, Volume, inspect_dicom_source, load_dicom_series, select_dicom_series
from .errors import EngineError, GeometryValidationError, ProtocolError
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

_CREATE_SELECTION_FIELDS = {
    "source",
    "series_uid",
    "plane",
    "mode",
    "crop_min_lps",
    "crop_max_lps",
    "plane_index",
    "start_index",
    "end_index",
    "thickness_mm",
    "print_size_mm",
    "layer_height_mm",
    "stride",
    "plate_layout",
    "labels",
    "structural_regions",
    "structural_markers",
    "tile_thickness_mode",
    "build_volume_mm",
    "resampling",
}


def _normalize_create_selection_payload(session: EngineSession, payload: Mapping[str, Any]) -> dict[str, Any]:
    """Validate native UI transport metadata before calling the typed API."""

    unknown = sorted(set(payload) - _CREATE_SELECTION_FIELDS)
    if unknown:
        raise ProtocolError(f"create_print_selection contains unsupported fields: {', '.join(unknown)}")
    if session.volume is None:
        raise EngineError("Create a print selection after selecting a complete CT series.")
    if payload.get("source") is not None:
        resolved = session._resolve_source(str(payload["source"]))
        if session.source is None or resolved != session.source:
            raise ProtocolError("create_print_selection source does not match the inspected DICOM source.")
    if payload.get("series_uid") is not None and str(payload["series_uid"]) != session.volume.series_uid:
        raise ProtocolError("create_print_selection series_uid does not match the selected DICOM series.")
    normalized = {key: payload[key] for key in payload if key not in {"source", "series_uid"}}
    structural = normalized.get("structural_regions")
    if structural is not None and not isinstance(structural, (list, tuple)):
        raise GeometryValidationError("structural_regions must be an array of explicit scene/structural regions.")
    return normalized


@dataclass(slots=True)
class EngineSession:
    """In-process equivalent of the Python sidecar lifecycle.

    The session keeps arrays on the Python side. Control responses return bounded
    metadata and scoped artifact references, not volume or toolpath arrays.
    """

    inspection: DicomInspection | None = None
    source: str | tuple[str, ...] | None = None
    volume: Volume | None = None
    selection: Any | None = None
    generated: Any | None = None
    _cancellations: dict[str, CancellationToken] = field(default_factory=dict)
    _cancellation_lock: Lock = field(default_factory=Lock)
    workspace: str | Path | None = None
    _workspace: Path = field(init=False)
    _closed: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        """Create a scoped workspace with an explicit, bounded lifecycle.

        A caller may provide an Application Support/cache root.  We still
        create and own a per-session child so closing a session cannot remove
        unrelated user files.  With no root, the child is a private temporary
        directory and is removed on ``close``/context exit.
        """

        if self.workspace is None:
            self._workspace = Path(mkdtemp(prefix="voxelweave-sidecar-"))
        else:
            root = Path(self.workspace).expanduser()
            root.mkdir(parents=True, exist_ok=True)
            self._workspace = Path(mkdtemp(prefix=f"session-{uuid4().hex[:12]}-", dir=str(root)))

    def _ensure_open(self) -> None:
        if self._closed:
            raise EngineError("Engine session is closed; create a new session before issuing requests.")

    def cleanup(self) -> None:
        """Remove all session-owned temporary caches and artifacts."""

        if self._closed:
            return
        with self._cancellation_lock:
            for token in self._cancellations.values():
                token.cancel()
            self._cancellations.clear()
        shutil.rmtree(self._workspace, ignore_errors=True)
        self._closed = True

    close = cleanup

    def __enter__(self) -> EngineSession:
        self._ensure_open()
        return self

    def __exit__(self, _exc_type: object, _exc_value: object, _traceback: object) -> None:
        self.cleanup()

    def __del__(self) -> None:
        # Destructors must never mask an interpreter-shutdown exception.
        with suppress(Exception):
            self.cleanup()

    def _token(self, request_id: str) -> CancellationToken:
        self._ensure_open()
        with self._cancellation_lock:
            token = self._cancellations.get(request_id)
            if token is None:
                token = CancellationToken()
                self._cancellations[request_id] = token
        return token

    def register_request(self, request_id: str) -> None:
        """Reserve a cooperative token before a worker thread starts."""

        self._ensure_open()
        self._token(request_id)

    def cancel(self, request_id: str) -> dict[str, Any]:
        self._ensure_open()
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

    def _resolve_source_payload(self, payload: Mapping[str, Any]) -> str | tuple[str, ...]:
        """Resolve either one directory/archive path or an explicit file group."""

        raw_sources = payload.get("sources")
        if isinstance(raw_sources, (list, tuple)):
            resolved = tuple(self._resolve_source(str(item)) for item in raw_sources if str(item).strip())
            if not resolved:
                raise EngineError("Choose at least one DICOM source path.")
            return resolved[0] if len(resolved) == 1 else resolved
        if payload.get("source") is None:
            raise EngineError("Choose a DICOM source before inspecting it.")
        return self._resolve_source(str(payload["source"]))

    def _workspace_path(self, value: object, default_name: str) -> str:
        self._ensure_open()
        candidate = Path(str(value)) if value is not None else Path(default_name)
        if not candidate.is_absolute():
            candidate = self._workspace / candidate
        return str(candidate)

    def _require_volume(self) -> Volume:
        if self.volume is None:
            raise EngineError("No DICOM volume is loaded; inspect and select a complete CT series first.")
        return self.volume

    def handle(self, envelope: ControlEnvelope, *, progress: ProgressCallback | None = None) -> dict[str, Any]:
        self._ensure_open()
        if envelope.operation == Operation.CANCEL:
            target = str(envelope.payload.get("request_id", ""))
            return self.cancel(target)
        token = self._token(envelope.request_id)
        callback = progress or (lambda _event: None)
        payload = envelope.payload
        try:
            op = envelope.operation
            if op == Operation.INSPECT_DICOM_SOURCE:
                self.source = self._resolve_source_payload(payload)
                self.inspection = inspect_dicom_source(self.source, request_id=envelope.request_id, cancellation=token, progress=callback)
                return self.inspection.to_dict()
            if op == Operation.SELECT_DICOM_SERIES:
                source = self._resolve_source_payload(payload) if payload.get("source") is not None or payload.get("sources") is not None else self.source
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
                self.selection = create_print_selection(self._require_volume(), **_normalize_create_selection_payload(self, payload))
                return self.selection.manifest.to_dict()
            if op == Operation.VALIDATE_SCENE:
                return validate_scene(payload.get("scene", payload))
            if op == Operation.GENERATE_TOOLPATH:
                if self.selection is None:
                    raise EngineError("Create a print selection before generating a toolpath.")
                if payload.get("scene") is not None:
                    scene_result = validate_scene(payload.get("scene", {}))
                    if not scene_result["passed"]:
                        raise GeometryValidationError("Scene canonical geometry validation failed: " + "; ".join(scene_result["errors"]))
                calibration_value = payload.get("calibrations", payload.get("calibration"))
                if calibration_value is None:
                    raise EngineError("Generation requires an explicit calibration object.")
                calibration: Calibration | CalibrationSet | Mapping[str, Calibration]
                if isinstance(calibration_value, list):
                    calibration = CalibrationSet.from_iterable(Calibration.from_dict(item) for item in calibration_value)
                elif isinstance(calibration_value, Mapping) and "binding" not in calibration_value:
                    calibration = cast(dict[str, Calibration], {str(key): Calibration.from_dict(dict(value)) for key, value in calibration_value.items()})
                else:
                    calibration = Calibration.from_dict(dict(calibration_value))
                self.generated = generate_toolpath(
                    self.selection,
                    calibration,
                    profile=PrinterProfile(**dict(payload.get("profile", {}))),
                    tool=(str(payload["tool"]) if payload.get("tool") is not None else None),
                    scene=(payload.get("scene") if isinstance(payload.get("scene"), Mapping) else None),
                    allow_calibration_clipping=bool(payload.get("allow_calibration_clipping", False)),
                    acknowledge_calibration_clipping=bool(payload.get("acknowledge_calibration_clipping", False)),
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
    """Validate scene ownership and canonical geometry inputs fail-closed.

    Primitive dimensions and explicit ownership can be checked without an
    optional native geometry dependency.  Imported meshes and Boolean CSG are
    never accepted on a bounded metadata check: they require ``manifold3d``
    and valid topology.  This keeps the engine honest when the package is
    deployed without the native extension.
    """

    errors: list[str] = []
    warnings: list[str] = []
    regions = scene.get("regions", [])
    if not isinstance(regions, list):
        errors.append("Scene regions must be an array.")
        regions = []
    identifiers: set[str] = set()
    manifold_available = False
    manifold_error: str | None = None
    try:
        from manifold3d import Manifold, Mesh

        manifold_available = True
    except Exception as exc:  # pragma: no cover - exercised on native package builds
        manifold_error = f"manifold3d unavailable: {type(exc).__name__}"

    def finite_positive(value: object, label: str) -> bool:
        try:
            number = float(cast(Any, value))
        except (TypeError, ValueError):
            errors.append(f"{label} must be a finite positive number.")
            return False
        if not np.isfinite(number) or number <= 0:
            errors.append(f"{label} must be a finite positive number.")
            return False
        return True

    def validate_mesh(region_id: str, geometry: Mapping[str, Any]) -> None:
        vertices = geometry.get("vertices")
        faces = geometry.get("faces")
        if not isinstance(vertices, list) or not isinstance(faces, list):
            errors.append(f"Scene region {region_id} imported mesh requires vertices and faces for topology validation.")
            return
        if len(vertices) < 4 or not all(isinstance(item, (list, tuple)) and len(item) == 3 for item in vertices):
            errors.append(f"Scene region {region_id} imported mesh has invalid vertex topology.")
            return
        if not faces or not all(isinstance(item, (list, tuple)) and len(item) >= 3 for item in faces):
            errors.append(f"Scene region {region_id} imported mesh has invalid face topology.")
            return
        try:
            vertex_array = np.asarray(vertices, dtype=np.float64)
            face_array = np.asarray(faces, dtype=np.int64)
        except (TypeError, ValueError):
            errors.append(f"Scene region {region_id} imported mesh contains non-numeric topology.")
            return
        if not np.all(np.isfinite(vertex_array)) or np.any(face_array < 0) or np.any(face_array >= len(vertices)):
            errors.append(f"Scene region {region_id} imported mesh contains invalid coordinates or face indices.")
            return
        if not manifold_available:
            errors.append(f"Scene region {region_id} requires canonical manifold3d validation; {manifold_error}.")
            return
        try:  # manifold3d's constructor performs duplicate/non-manifold checks.
            triangles = []
            for face_value in faces:
                face = [int(cast(Any, item)) for item in cast(list[object], face_value)]
                for index in range(1, len(face) - 1):
                    triangles.append((face[0], face[index], face[index + 1]))
            Mesh(vert=vertex_array, tri=np.asarray(triangles, dtype=np.int32))
            # Constructing a Manifold also validates the resulting mesh.
            Manifold(Mesh(vert=vertex_array, tri=np.asarray(triangles, dtype=np.int32)))
        except Exception as exc:  # pragma: no cover - depends on native extension
            errors.append(f"Scene region {region_id} failed manifold3d topology validation: {type(exc).__name__}.")

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
        if region.get("ambiguous_overlap") or region.get("overlap_policy") in {None, "ambiguous"} and region.get("overlaps"):
            errors.append(f"Scene region {identifier or '<unnamed>'} has an unresolved overlap policy.")
        geometry_value = region.get("geometry", region)
        geometry = geometry_value if isinstance(geometry_value, Mapping) else {}
        kind = str(geometry.get("kind", region.get("kind", ""))).lower()
        if kind in {"box", "cube", "cylinder", "wedge", "prism", "polygon_prism"}:
            dimensions = geometry.get("dimensions", geometry.get("size", geometry.get("scale")))
            if dimensions is None:
                errors.append(f"Scene region {identifier or '<unnamed>'} primitive is missing dimensions.")
            elif isinstance(dimensions, Mapping):
                for axis in ("x", "y", "z"):
                    finite_positive(dimensions.get(axis), f"Scene region {identifier or '<unnamed>'} dimension {axis}")
            elif isinstance(dimensions, (list, tuple)):
                if len(dimensions) != 3:
                    errors.append(f"Scene region {identifier or '<unnamed>'} primitive dimensions must have three entries.")
                else:
                    for axis, value in zip(("x", "y", "z"), dimensions, strict=True):
                        finite_positive(value, f"Scene region {identifier or '<unnamed>'} dimension {axis}")
            else:
                errors.append(f"Scene region {identifier or '<unnamed>'} primitive dimensions are invalid.")
        if kind in {"imported", "stl", "3mf", "mesh", "imported_mesh"} or "vertices" in geometry or "faces" in geometry:
            validate_mesh(identifier or "<unnamed>", geometry)
        operands = geometry.get("boolean_operands", region.get("boolean_operands"))
        operation = geometry.get("boolean_operation", geometry.get("operation"))
        if operands or operation:
            if not isinstance(operands, list) or len(operands) < 2 or str(operation).lower() not in {"union", "subtract", "intersection"}:
                errors.append(f"Scene region {identifier or '<unnamed>'} has an invalid Boolean CSG contract.")
            elif not manifold_available:
                errors.append(f"Scene region {identifier or '<unnamed>'} requires canonical manifold3d Boolean validation; {manifold_error}.")
    if not regions:
        warnings.append("Scene contains no printable regions.")
    return {
        "schema": "voxelweave.scene-validation.v1",
        "passed": not errors,
        "errors": errors,
        "warnings": warnings,
        "canonical_geometry_validation": "manifold3d" if manifold_available else "primitive_contract_only",
        "canonical_geometry_dependency": "available" if manifold_available else manifold_error,
        "physical_geometry_claim": "canonical_geometry_validated" if not errors and manifold_available else "canonical_geometry_validation_required_for_generation",
    }
