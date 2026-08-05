"""Bounded, deterministic loading for authorized STL and 3MF scene sources."""

from __future__ import annotations

import hashlib
import struct
import zipfile
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from xml.etree import ElementTree

import numpy as np

from .errors import GeometryValidationError

MAX_MESH_SOURCE_BYTES = 512 * 1024 * 1024
MAX_3MF_UNCOMPRESSED_BYTES = 512 * 1024 * 1024
_IDENTITY_3MF = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0)
_UNIT_SCALE_MM = {"micron": 0.001, "millimeter": 1.0, "centimeter": 10.0, "meter": 1000.0, "inch": 25.4, "foot": 304.8}


@dataclass(frozen=True, slots=True)
class LoadedMesh:
    vertices: np.ndarray
    triangles: np.ndarray
    sha256: str


def _deduplicated_triangles(raw: list[tuple[float, float, float]]) -> tuple[np.ndarray, np.ndarray]:
    if len(raw) < 12 or len(raw) % 3:
        raise GeometryValidationError("STL did not contain a closed triangular mesh.")
    vertices: list[tuple[float, float, float]] = []
    triangles: list[tuple[int, int, int]] = []
    indices: dict[tuple[float, float, float], int] = {}
    for offset in range(0, len(raw), 3):
        face: list[int] = []
        for vertex in raw[offset : offset + 3]:
            if not all(np.isfinite(vertex)):
                raise GeometryValidationError("STL contains a non-finite vertex.")
            index = indices.get(vertex)
            if index is None:
                index = len(vertices)
                indices[vertex] = index
                vertices.append(vertex)
            face.append(index)
        if len(set(face)) != 3:
            raise GeometryValidationError("STL contains a degenerate triangle.")
        triangles.append((face[0], face[1], face[2]))
    return np.asarray(vertices, dtype=np.float32), np.asarray(triangles, dtype=np.uint32)


def _load_stl(data: bytes) -> tuple[np.ndarray, np.ndarray]:
    if len(data) >= 84:
        count = struct.unpack_from("<I", data, 80)[0]
        expected = 84 + count * 50
        if count > 0 and expected == len(data):
            raw = [
                struct.unpack_from("<fff", data, 84 + triangle * 50 + 12 + vertex * 12)
                for triangle in range(count)
                for vertex in range(3)
            ]
            return _deduplicated_triangles(raw)
    try:
        text = data.decode("ascii")
    except UnicodeDecodeError as exc:
        raise GeometryValidationError("STL is neither a valid binary STL nor ASCII STL.") from exc
    raw = []
    for line in text.splitlines():
        parts = line.strip().split()
        if len(parts) == 4 and parts[0].lower() == "vertex":
            try:
                raw.append((float(parts[1]), float(parts[2]), float(parts[3])))
            except ValueError as exc:
                raise GeometryValidationError("ASCII STL contains a non-numeric vertex.") from exc
    return _deduplicated_triangles(raw)


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _transform(value: str | None) -> tuple[float, ...]:
    if not value:
        return _IDENTITY_3MF
    try:
        result = tuple(float(item) for item in value.split())
    except ValueError as exc:
        raise GeometryValidationError("3MF transform must contain 12 finite values.") from exc
    if len(result) != 12 or not all(np.isfinite(result)):
        raise GeometryValidationError("3MF transform must contain 12 finite values.")
    return result


def _apply_transform(vertex: tuple[float, float, float], transform: tuple[float, ...]) -> tuple[float, float, float]:
    x, y, z = vertex
    return (
        x * transform[0] + y * transform[3] + z * transform[6] + transform[9],
        x * transform[1] + y * transform[4] + z * transform[7] + transform[10],
        x * transform[2] + y * transform[5] + z * transform[8] + transform[11],
    )


def _load_3mf(path: Path) -> tuple[np.ndarray, np.ndarray]:
    try:
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
            if any(item.flag_bits & 1 for item in entries):
                raise GeometryValidationError("Encrypted 3MF archives are not supported.")
            if sum(item.file_size for item in entries) > MAX_3MF_UNCOMPRESSED_BYTES:
                raise GeometryValidationError("3MF archive exceeds the bounded uncompressed size limit.")
            model_entry = next((item for item in entries if item.filename.lower().endswith("/3dmodel.model") or item.filename.lower() == "3d/3dmodel.model"), None)
            if model_entry is None:
                raise GeometryValidationError("3MF archive does not contain 3D/3dmodel.model.")
            root = ElementTree.fromstring(archive.read(model_entry))
    except (OSError, zipfile.BadZipFile, ElementTree.ParseError) as exc:
        raise GeometryValidationError(f"3MF source is invalid: {type(exc).__name__}.") from exc
    unit = root.attrib.get("unit", "millimeter")
    unit_scale = _UNIT_SCALE_MM.get(unit)
    if unit_scale is None:
        raise GeometryValidationError(f"Unsupported 3MF unit: {unit}.")
    objects = {node.attrib.get("id", ""): node for node in root.iter() if _local_name(node.tag) == "object" and node.attrib.get("id")}
    vertices: list[tuple[float, float, float]] = []
    triangles: list[tuple[int, int, int]] = []

    def direct_children(node: ElementTree.Element, name: str) -> list[ElementTree.Element]:
        return [child for child in node if _local_name(child.tag) == name]

    def append_object(identifier: str, transforms: tuple[tuple[float, ...], ...], resolving: frozenset[str] = frozenset()) -> None:
        if identifier in resolving:
            raise GeometryValidationError(f"3MF component graph is cyclic at object {identifier}.")
        node = objects.get(identifier)
        if node is None:
            raise GeometryValidationError(f"3MF build references missing object {identifier}.")
        mesh_nodes = direct_children(node, "mesh")
        if mesh_nodes:
            mesh = mesh_nodes[0]
            vertex_containers = direct_children(mesh, "vertices")
            triangle_containers = direct_children(mesh, "triangles")
            if not vertex_containers or not triangle_containers:
                raise GeometryValidationError(f"3MF object {identifier} has incomplete mesh topology.")
            local_vertices: list[tuple[float, float, float]] = []
            for item in direct_children(vertex_containers[0], "vertex"):
                try:
                    vertex = (float(item.attrib["x"]), float(item.attrib["y"]), float(item.attrib["z"]))
                except (KeyError, ValueError) as exc:
                    raise GeometryValidationError(f"3MF object {identifier} contains an invalid vertex.") from exc
                for matrix in transforms:
                    vertex = _apply_transform(vertex, matrix)
                vertex = (vertex[0] * unit_scale, vertex[1] * unit_scale, vertex[2] * unit_scale)
                if not all(np.isfinite(vertex)):
                    raise GeometryValidationError(f"3MF object {identifier} contains a non-finite vertex.")
                local_vertices.append(vertex)
            offset = len(vertices)
            vertices.extend(local_vertices)
            for item in direct_children(triangle_containers[0], "triangle"):
                try:
                    face = tuple(int(item.attrib[key]) for key in ("v1", "v2", "v3"))
                except (KeyError, ValueError) as exc:
                    raise GeometryValidationError(f"3MF object {identifier} contains an invalid triangle.") from exc
                if len(set(face)) != 3 or any(index < 0 or index >= len(local_vertices) for index in face):
                    raise GeometryValidationError(f"3MF object {identifier} contains an invalid triangle index.")
                triangles.append((face[0] + offset, face[1] + offset, face[2] + offset))
            return
        component_containers = direct_children(node, "components")
        components = direct_children(component_containers[0], "component") if component_containers else []
        if not components:
            raise GeometryValidationError(f"3MF object {identifier} contains neither a mesh nor components.")
        next_resolving = resolving | {identifier}
        for component in components:
            append_object(component.attrib.get("objectid", ""), (_transform(component.attrib.get("transform")), *transforms), next_resolving)

    build_nodes = [node for node in root if _local_name(node.tag) == "build"]
    build_items = direct_children(build_nodes[0], "item") if build_nodes else []
    if build_items:
        for item in build_items:
            append_object(item.attrib.get("objectid", ""), (_transform(item.attrib.get("transform")),))
    else:
        for identifier in objects:
            append_object(identifier, (_IDENTITY_3MF,))
    if len(vertices) < 4 or not triangles:
        raise GeometryValidationError("3MF model did not contain a closed triangular mesh.")
    return np.asarray(vertices, dtype=np.float32), np.asarray(triangles, dtype=np.uint32)


@lru_cache(maxsize=8)
def _load_cached(path_value: str, size: int, modified_ns: int) -> LoadedMesh:
    del size, modified_ns
    path = Path(path_value)
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if path.suffix.lower() == ".stl":
        vertices, triangles = _load_stl(data)
    elif path.suffix.lower() == ".3mf":
        vertices, triangles = _load_3mf(path)
    else:
        raise GeometryValidationError("Imported mesh source must use the .stl or .3mf extension.")
    return LoadedMesh(vertices, triangles, digest)


def load_mesh_file(source: object) -> LoadedMesh:
    if not isinstance(source, str) or not source:
        raise GeometryValidationError("Imported scene geometry requires an authorized STL or 3MF source path.")
    path = Path(source).expanduser()
    try:
        stat = path.stat()
    except OSError as exc:
        raise GeometryValidationError(f"Imported mesh source is unavailable: {path.name}.") from exc
    if not path.is_file() or stat.st_size <= 0 or stat.st_size > MAX_MESH_SOURCE_BYTES:
        raise GeometryValidationError("Imported mesh source must be a non-empty file within the 512 MiB safety limit.")
    return _load_cached(str(path.resolve()), stat.st_size, stat.st_mtime_ns)
