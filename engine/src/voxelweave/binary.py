"""Typed binary artifacts for volumes, MPR planes, previews, and traces."""

from __future__ import annotations

import hashlib
import json
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from .errors import EngineError
from .models import canonicalize

MAGIC = b"VWBF\x01\x00"


@dataclass(frozen=True, slots=True)
class BinaryArtifact:
    path: Path
    artifact_type: str
    dtype: str
    shape: tuple[int, ...]
    sha256: str
    header: dict[str, Any]


def _payload_sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def write_binary_array(
    path: str | Path,
    array: np.ndarray,
    *,
    artifact_type: str,
    metadata: dict[str, Any] | None = None,
) -> BinaryArtifact:
    """Write a little-endian typed payload with a canonical JSON header."""

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    source = np.ascontiguousarray(array)
    dtype = source.dtype.newbyteorder("<")
    payload = np.asarray(source, dtype=dtype).tobytes(order="C")
    header: dict[str, Any] = {
        "format": "voxelweave.binary.v1",
        "artifact_type": artifact_type,
        "dtype": dtype.str,
        "shape": [int(item) for item in source.shape],
        "payload_bytes": len(payload),
        "payload_sha256": _payload_sha256(payload),
    }
    if source.dtype.fields:
        header["dtype_descr"] = source.dtype.descr
    if metadata:
        header.update(canonicalize(metadata))
    encoded = json.dumps(header, sort_keys=True, separators=(",", ":")).encode("utf-8")
    with target.open("wb") as handle:
        handle.write(MAGIC)
        handle.write(struct.pack(">I", len(encoded)))
        handle.write(encoded)
        handle.write(payload)
    return BinaryArtifact(
        path=target,
        artifact_type=artifact_type,
        dtype=dtype.str,
        shape=tuple(int(item) for item in source.shape),
        sha256=header["payload_sha256"],
        header=header,
    )


def _read_header(handle: Any) -> dict[str, Any]:
    if handle.read(len(MAGIC)) != MAGIC:
        raise EngineError("Binary artifact has an unsupported magic header.")
    raw_length = handle.read(4)
    if len(raw_length) != 4:
        raise EngineError("Binary artifact header is truncated.")
    header_length = struct.unpack(">I", raw_length)[0]
    if header_length <= 0 or header_length > 16 * 1024 * 1024:
        raise EngineError("Binary artifact header length is invalid.")
    try:
        header = json.loads(handle.read(header_length).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise EngineError("Binary artifact header is not valid JSON.") from exc
    if not isinstance(header, dict) or header.get("format") != "voxelweave.binary.v1":
        raise EngineError("Binary artifact format is unsupported.")
    return header


def read_binary_array(path: str | Path) -> tuple[np.ndarray, dict[str, Any]]:
    source = Path(path)
    with source.open("rb") as handle:
        header = _read_header(handle)
        payload = handle.read()
    expected = int(header.get("payload_bytes", -1))
    if expected != len(payload):
        raise EngineError("Binary artifact payload length does not match its typed header.")
    digest = _payload_sha256(payload)
    if digest != header.get("payload_sha256"):
        raise EngineError("Binary artifact SHA-256 does not match its payload.")
    try:
        descriptor = header.get("dtype_descr")
        if isinstance(descriptor, list):
            descriptor = [tuple(item) if isinstance(item, list) else item for item in descriptor]
        dtype = np.dtype(descriptor if descriptor is not None else str(header["dtype"]))
        shape = tuple(int(item) for item in header["shape"])
    except (KeyError, TypeError, ValueError) as exc:
        raise EngineError("Binary artifact dtype or shape metadata is invalid.") from exc
    expected_items = int(np.prod(shape, dtype=np.int64))
    if expected_items != 0 and len(payload) != expected_items * dtype.itemsize:
        raise EngineError("Binary artifact payload does not fit the declared shape and dtype.")
    array = np.frombuffer(payload, dtype=dtype).reshape(shape).copy()
    return array, header
