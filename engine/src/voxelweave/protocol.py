"""Versioned bounded JSON-lines control envelopes.

Binary payloads are referenced by path/hash in these envelopes; no volume or
toolpath arrays are serialized here.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from .errors import ProtocolError
from .models import canonicalize

MAX_JSONL_BYTES = 256 * 1024
MAX_REQUEST_ID_BYTES = 128
MAX_JSON_DEPTH = 12
MAX_ARRAY_ITEMS = 4096
MAX_STRING_BYTES = 64 * 1024


def _validate_bounded(value: Any, *, depth: int = 0, location: str = "payload") -> None:
    """Reject payloads that could smuggle binary data through JSONL."""

    if depth > MAX_JSON_DEPTH:
        raise ProtocolError(f"{location} exceeds the maximum JSON nesting depth.")
    if isinstance(value, str):
        if len(value.encode("utf-8")) > MAX_STRING_BYTES:
            raise ProtocolError(f"{location} contains an oversized string; use a scoped artifact path instead.")
        return
    if isinstance(value, Mapping):
        for key, child in value.items():
            _validate_bounded(str(key), depth=depth + 1, location=f"{location}.key")
            _validate_bounded(child, depth=depth + 1, location=f"{location}.{key}")
        return
    if isinstance(value, (tuple, list)):
        if len(value) > MAX_ARRAY_ITEMS:
            raise ProtocolError(f"{location} contains too many array items; use a scoped binary artifact instead.")
        for index, child in enumerate(value):
            _validate_bounded(child, depth=depth + 1, location=f"{location}[{index}]")


class Operation(StrEnum):
    INSPECT_DICOM_SOURCE = "inspect_dicom_source"
    SELECT_DICOM_SERIES = "select_dicom_series"
    BUILD_VOLUME_CACHE = "build_volume_cache"
    REQUEST_MPR_PLANE = "request_mpr_plane"
    REQUEST_VOLUME_PREVIEW = "request_volume_preview"
    SAMPLE_VOXEL = "sample_voxel"
    CALCULATE_HISTOGRAM = "calculate_histogram"
    CREATE_PRINT_SELECTION = "create_print_selection"
    VALIDATE_SCENE = "validate_scene"
    GENERATE_TOOLPATH = "generate_toolpath"
    REVERSE_AUDIT_GCODE = "reverse_audit_gcode"
    EXPORT_RUN_PACKAGE = "export_run_package"
    VERIFY_SCAN_BACK = "verify_scan_back"
    EXPORT_VERIFICATION_REPORT = "export_verification_report"
    CANCEL = "cancel"


PROTOCOL_VERSION = "voxelweave.control.v1"


@dataclass(frozen=True, slots=True)
class ControlEnvelope:
    request_id: str
    operation: Operation
    payload: Mapping[str, Any] = field(default_factory=dict)
    protocol: str = PROTOCOL_VERSION

    def __post_init__(self) -> None:
        if not self.request_id or "\n" in self.request_id or "\r" in self.request_id:
            raise ProtocolError("Control request_id must be a non-empty single-line value.")
        if len(self.request_id.encode("utf-8")) > MAX_REQUEST_ID_BYTES:
            raise ProtocolError("Control request_id is too long.")
        if self.protocol != PROTOCOL_VERSION:
            raise ProtocolError(f"Unsupported control protocol: {self.protocol}.")
        if self.payload is None:
            object.__setattr__(self, "payload", {})
        _validate_bounded(self.payload)

    def to_dict(self) -> dict[str, Any]:
        return {
            "protocol": self.protocol,
            "request_id": self.request_id,
            "operation": self.operation.value,
            "payload": canonicalize(dict(self.payload)),
        }

    def to_json(self) -> str:
        encoded = json.dumps(self.to_dict(), sort_keys=True, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > MAX_JSONL_BYTES:
            raise ProtocolError("Control envelope exceeds the bounded JSONL line limit.")
        return encoded

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> ControlEnvelope:
        if not isinstance(value, Mapping):
            raise ProtocolError("Control envelope must be an object.")
        try:
            operation = Operation(str(value["operation"]))
            request_id = str(value["request_id"])
        except (KeyError, ValueError) as exc:
            raise ProtocolError("Control envelope requires a supported operation and request_id.") from exc
        payload = value.get("payload", {})
        if not isinstance(payload, Mapping):
            raise ProtocolError("Control envelope payload must be an object.")
        return cls(
            request_id=request_id,
            operation=operation,
            payload=dict(payload),
            protocol=str(value.get("protocol", "")),
        )

    @classmethod
    def from_json(cls, value: str) -> ControlEnvelope:
        if len(value.encode("utf-8")) > MAX_JSONL_BYTES:
            raise ProtocolError("Control envelope exceeds the bounded JSONL line limit.")
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError as exc:
            raise ProtocolError("Control envelope is not valid JSON.") from exc
        return cls.from_dict(parsed)


def encode_jsonl(envelopes: Iterable[ControlEnvelope]) -> str:
    """Encode bounded envelopes as deterministic newline-delimited JSON."""

    return "".join(f"{envelope.to_json()}\n" for envelope in envelopes)


def parse_jsonl(value: str) -> list[ControlEnvelope]:
    result: list[ControlEnvelope] = []
    for line_number, line in enumerate(value.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            result.append(ControlEnvelope.from_json(line))
        except ProtocolError as exc:
            raise ProtocolError(f"Invalid control envelope on line {line_number}: {exc}") from exc
    return result
