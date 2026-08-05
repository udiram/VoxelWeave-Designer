"""Canonical Manifold-backed scene evaluation and modeled-solid selections."""

from __future__ import annotations

import hashlib
import json
import math
import re
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any, cast

import numpy as np

from .errors import GeometryValidationError
from .mesh import LoadedMesh, load_mesh_file
from .models import Vec3, canonicalize


def _manifold_api() -> tuple[Any, Any, Any]:
    try:
        from manifold3d import CrossSection, Manifold, Mesh
    except Exception as exc:  # pragma: no cover - native release dependency
        raise GeometryValidationError(f"Canonical modeled geometry requires manifold3d: {type(exc).__name__}.") from exc
    return Manifold, Mesh, CrossSection


def _vector(value: object, *, default: Vec3) -> Vec3:
    if isinstance(value, dict):
        raw = (value.get("x"), value.get("y"), value.get("z"))
    elif isinstance(value, (list, tuple)) and len(value) == 3:
        raw = tuple(value)
    else:
        return default
    try:
        result = cast(Vec3, tuple(float(cast(Any, item)) for item in raw))
    except (TypeError, ValueError):
        raise GeometryValidationError("Scene transforms and dimensions must contain finite XYZ values.") from None
    if not all(math.isfinite(item) for item in result):
        raise GeometryValidationError("Scene transforms and dimensions must contain finite XYZ values.")
    return result


def _triangles(faces: object) -> np.ndarray:
    if not isinstance(faces, list):
        raise GeometryValidationError("Imported scene geometry requires triangle faces.")
    values: list[tuple[int, int, int]] = []
    for raw_face in faces:
        if not isinstance(raw_face, (list, tuple)) or len(raw_face) < 3:
            raise GeometryValidationError("Imported scene faces must contain at least three indices.")
        face = []
        for item in raw_face:
            if isinstance(item, bool) or not isinstance(item, (int, np.integer)):
                raise GeometryValidationError("Imported scene face indices must be integers.")
            face.append(int(item))
        values.extend((face[0], face[index], face[index + 1]) for index in range(1, len(face) - 1))
    return np.asarray(values, dtype=np.int32)


def _mesh_data(region: dict[str, Any], geometry: dict[str, Any]) -> LoadedMesh:
    vertices = geometry.get("vertices")
    faces = geometry.get("faces")
    if isinstance(vertices, list) and isinstance(faces, list):
        vertex_array = np.asarray(vertices, dtype=np.float32)
        triangle_array = _triangles(faces)
        payload = json.dumps({"vertices": vertices, "faces": faces}, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return LoadedMesh(vertex_array, triangle_array, hashlib.sha256(payload).hexdigest())
    return load_mesh_file(region.get("source_path") or geometry.get("source_path"))


def _mesh_manifold(vertices: np.ndarray, triangles: np.ndarray) -> Any:
    Manifold, Mesh, _ = _manifold_api()
    vertex_array = np.asarray(vertices, dtype=np.float32)
    triangle_array = np.asarray(triangles, dtype=np.uint32)
    manifold = Manifold(Mesh(vert_properties=vertex_array, tri_verts=triangle_array))
    if manifold.volume() < 0:
        manifold = Manifold(Mesh(vert_properties=vertex_array, tri_verts=triangle_array[:, ::-1].copy()))
    if manifold.is_empty() or str(manifold.status()) != "Error.NoError" or manifold.volume() <= 0:
        raise GeometryValidationError("Imported scene mesh must be closed, oriented, and have positive occupied volume.")
    return manifold


def _primitive_manifold(region: dict[str, Any]) -> Any:
    Manifold, Mesh, CrossSection = _manifold_api()
    geometry_value = region.get("geometry", region)
    geometry = dict(geometry_value) if isinstance(geometry_value, dict) else {}
    kind = str(geometry.get("kind", region.get("kind", ""))).lower().replace("-", "_")
    dimensions = _vector(geometry.get("dimensions", region.get("dimensions_mm")), default=(1.0, 1.0, 1.0))
    if any(item <= 0 for item in dimensions):
        raise GeometryValidationError(f"Scene region {region.get('id', '<unnamed>')} has non-positive dimensions.")
    vertices = geometry.get("vertices")
    faces = geometry.get("faces")
    source_path = region.get("source_path") or geometry.get("source_path")
    if isinstance(vertices, list) and isinstance(faces, list) or source_path:
        mesh = _mesh_data(region, geometry)
        manifold = _mesh_manifold(mesh.vertices, mesh.triangles)
    elif kind in {"box", "cube", "fixture", "group"}:
        manifold = Manifold.cube(dimensions, center=True)
    elif kind == "cylinder":
        manifold = Manifold.cylinder(dimensions[2], dimensions[0] / 2.0, circular_segments=48, center=True)
        if abs(dimensions[1] - dimensions[0]) > 1e-9:
            manifold = manifold.scale((1.0, dimensions[1] / dimensions[0], 1.0))
    elif kind == "wedge":
        x, y, z = dimensions
        verts = np.asarray(
            [(-x / 2, -y / 2, -z / 2), (x / 2, -y / 2, -z / 2), (-x / 2, y / 2, -z / 2), (x / 2, y / 2, -z / 2), (-x / 2, -y / 2, z / 2), (-x / 2, y / 2, z / 2)],
            dtype=np.float64,
        )
        tris = np.asarray([(0, 2, 1), (1, 2, 3), (0, 1, 4), (0, 4, 2), (2, 4, 5), (2, 5, 3), (1, 3, 4), (3, 5, 4)], dtype=np.int32)
        manifold = _mesh_manifold(verts, tris)
    elif kind in {"polygon_prism", "prism", "extrusion"}:
        points = geometry.get("polygon_points")
        if isinstance(points, list) and len(points) >= 3:
            try:
                contour = [[float(point["x"]), float(point["y"])] if isinstance(point, dict) else [float(point[0]), float(point[1])] for point in points]
            except (KeyError, IndexError, TypeError, ValueError):
                raise GeometryValidationError("Polygon prism points must contain finite numeric XY coordinates.") from None
            if not all(math.isfinite(value) for point in contour for value in point):
                raise GeometryValidationError("Polygon prism points must contain finite numeric XY coordinates.")
            try:
                cross_section = CrossSection([contour])
            except Exception as exc:
                raise GeometryValidationError(f"Polygon prism contour is invalid: {type(exc).__name__}.") from exc
            bounds = cross_section.bounds()
            width = max(float(bounds[2] - bounds[0]), 1e-9)
            height = max(float(bounds[3] - bounds[1]), 1e-9)
            cross_section = cross_section.translate((-(bounds[0] + bounds[2]) / 2.0, -(bounds[1] + bounds[3]) / 2.0)).scale((dimensions[0] / width, dimensions[1] / height))
        else:
            try:
                polygon_sides = int(geometry.get("polygon_sides", 6))
            except (TypeError, ValueError, OverflowError):
                raise GeometryValidationError("Polygon prism side count must be an integer of at least three.") from None
            if polygon_sides < 3:
                raise GeometryValidationError("Polygon prism side count must be an integer of at least three.")
            cross_section = CrossSection.circle(0.5, polygon_sides).scale((dimensions[0], dimensions[1]))
        manifold = Manifold.extrude(cross_section, dimensions[2]).translate((0.0, 0.0, -dimensions[2] / 2.0))
    else:
        raise GeometryValidationError(f"Scene region {region.get('id', '<unnamed>')} uses unsupported canonical geometry kind {kind or '<empty>'}.")
    if manifold.is_empty() or str(manifold.status()) != "Error.NoError":
        raise GeometryValidationError(f"Scene region {region.get('id', '<unnamed>')} did not produce a valid occupied manifold.")
    return manifold


def _apply_transform(manifold: Any, region: dict[str, Any]) -> Any:
    geometry_value = region.get("geometry", region)
    geometry = dict(geometry_value) if isinstance(geometry_value, dict) else {}
    dimensions = _vector(geometry.get("dimensions", region.get("dimensions_mm")), default=(1.0, 1.0, 1.0))
    transform_value = region.get("transform", {})
    transform = dict(transform_value) if isinstance(transform_value, dict) else {}
    position = _vector(transform.get("position"), default=(0.0, 0.0, 0.0))
    rotation = _vector(transform.get("rotation"), default=(0.0, 0.0, 0.0))
    scale_value = _vector(transform.get("scale"), default=dimensions)
    if any(item <= 0 for item in scale_value):
        raise GeometryValidationError(f"Scene region {region.get('id', '<unnamed>')} transform scale must be positive on every axis.")
    relative_scale = tuple(scale_value[index] / dimensions[index] for index in range(3))
    result = manifold.scale(relative_scale).rotate(rotation).translate(position)
    if result.is_empty() or str(result.status()) != "Error.NoError":
        raise GeometryValidationError(f"Scene region {region.get('id', '<unnamed>')} transform produced invalid geometry.")
    return result


def _point_in_contour(point: tuple[float, float], contour: np.ndarray) -> bool:
    x, y = point
    inside = False
    previous = contour[-1]
    for current in contour:
        x1, y1 = float(previous[0]), float(previous[1])
        x2, y2 = float(current[0]), float(current[1])
        cross = (x - x1) * (y2 - y1) - (y - y1) * (x2 - x1)
        if abs(cross) <= 1e-8 and min(x1, x2) - 1e-8 <= x <= max(x1, x2) + 1e-8 and min(y1, y2) - 1e-8 <= y <= max(y1, y2) + 1e-8:
            return True
        if (y1 > y) != (y2 > y):
            intersection_x = (x2 - x1) * (y - y1) / (y2 - y1) + x1
            if x < intersection_x:
                inside = not inside
        previous = current
    return inside


@dataclass(slots=True)
class CanonicalRegion:
    identifier: str
    region: str
    tool: str
    target_hu: float
    manifold: Any
    _slice_cache: dict[float, tuple[np.ndarray, ...]] = field(default_factory=dict)

    @property
    def bounds(self) -> tuple[float, float, float, float, float, float]:
        return cast(tuple[float, float, float, float, float, float], tuple(float(item) for item in self.manifold.bounding_box()))

    def contains(self, x: float, y: float, z: float) -> bool:
        low_x, low_y, low_z, high_x, high_y, high_z = self.bounds
        if x < low_x - 1e-8 or x > high_x + 1e-8 or y < low_y - 1e-8 or y > high_y + 1e-8 or z < low_z - 1e-8 or z >= high_z + 1e-8:
            return False
        key = round(float(z), 9)
        polygons = self._slice_cache.get(key)
        if polygons is None:
            polygons = tuple(np.asarray(polygon, dtype=np.float64) for polygon in self.manifold.slice(float(z)).to_polygons())
            self._slice_cache[key] = polygons
        return sum(1 for contour in polygons if len(contour) >= 3 and _point_in_contour((x, y), contour)) % 2 == 1

    def polygons_at(self, z: float) -> tuple[np.ndarray, ...]:
        """Return the exact Manifold slice contours used for deposition clipping."""

        key = round(float(z), 9)
        polygons = self._slice_cache.get(key)
        if polygons is None:
            polygons = tuple(np.asarray(polygon, dtype=np.float64) for polygon in self.manifold.slice(float(z)).to_polygons())
            self._slice_cache[key] = polygons
        return polygons


@dataclass(slots=True)
class CanonicalScene:
    regions: tuple[CanonicalRegion, ...]
    source_hash: str

    @property
    def bounds(self) -> tuple[float, float, float, float, float, float]:
        if not self.regions:
            raise GeometryValidationError("Scene contains no visible modeled solids.")
        values = [region.bounds for region in self.regions]
        return (
            min(item[0] for item in values), min(item[1] for item in values), min(item[2] for item in values),
            max(item[3] for item in values), max(item[4] for item in values), max(item[5] for item in values),
        )

    def region_at(self, x: float, y: float, z: float) -> CanonicalRegion | None:
        matches = [region for region in self.regions if region.contains(x, y, z)]
        if not matches:
            return None
        owners = {(region.tool, region.region, region.target_hu) for region in matches}
        if len(owners) > 1:
            raise GeometryValidationError(f"Canonical modeled ownership is ambiguous at ({x:.4f}, {y:.4f}, {z:.4f}).")
        return matches[-1]

    def partition_line(
        self,
        *,
        z: float,
        fixed: float,
        start: float,
        end: float,
        direction_x: bool,
    ) -> tuple[tuple[float, float, CanonicalRegion | None], ...]:
        """Partition a horizontal/vertical road at every exact slice-contour crossing."""

        low, high = sorted((float(start), float(end)))
        boundaries = [low, high]
        for region in self.regions:
            for contour in region.polygons_at(z):
                if len(contour) < 2:
                    continue
                for first, second in zip(contour, np.roll(contour, -1, axis=0), strict=True):
                    along_1, cross_1 = (float(first[0]), float(first[1])) if direction_x else (float(first[1]), float(first[0]))
                    along_2, cross_2 = (float(second[0]), float(second[1])) if direction_x else (float(second[1]), float(second[0]))
                    if (cross_1 > fixed) == (cross_2 > fixed) or abs(cross_2 - cross_1) <= 1e-12:
                        continue
                    crossing = along_1 + (fixed - cross_1) * (along_2 - along_1) / (cross_2 - cross_1)
                    if low < crossing < high:
                        boundaries.append(crossing)
        unique = sorted({round(item, 10) for item in boundaries})
        partitions: list[tuple[float, float, CanonicalRegion | None]] = []
        for first, second in zip(unique, unique[1:], strict=False):
            if second - first <= 1e-9:
                continue
            midpoint = (first + second) / 2.0
            x, y = (midpoint, fixed) if direction_x else (fixed, midpoint)
            partitions.append((first, second, self.region_at(x, y, z)))
        return tuple((second, first, region) for first, second, region in reversed(partitions)) if end < start else tuple(partitions)


def canonical_scene(scene: dict[str, Any]) -> CanonicalScene:
    raw_regions = scene.get("regions", [])
    if not isinstance(raw_regions, list):
        raise GeometryValidationError("Scene regions must be an array.")
    by_id = {str(region.get("id", "")): dict(region) for region in raw_regions if isinstance(region, dict) and region.get("id")}
    built: dict[str, Any] = {}
    resolving: set[str] = set()

    def build(identifier: str) -> Any:
        if identifier in built:
            return built[identifier]
        if identifier in resolving or identifier not in by_id:
            raise GeometryValidationError(f"Boolean scene operand {identifier or '<empty>'} is missing or cyclic.")
        resolving.add(identifier)
        region = by_id[identifier]
        geometry_value = region.get("geometry", region)
        geometry = dict(geometry_value) if isinstance(geometry_value, dict) else {}
        operands = geometry.get("boolean_operands", region.get("boolean_operands"))
        operation = str(geometry.get("boolean_operation", region.get("boolean_operation", ""))).lower()
        if isinstance(operands, list) and operands:
            if len(operands) < 2:
                raise GeometryValidationError(f"Boolean scene region {identifier} requires at least two operands.")
            operand_semantics = {
                (str(by_id[str(operand)].get("owner", "")), by_id[str(operand)].get("target_hu"))
                for operand in operands
                if str(operand) in by_id
            }
            root_semantics = (str(region.get("owner", "")), region.get("target_hu"))
            if len(operand_semantics) > 1 or (operand_semantics and root_semantics not in operand_semantics):
                raise GeometryValidationError(f"Boolean scene region {identifier} cannot silently collapse conflicting tool/target ownership.")
            values = [build(str(operand)) for operand in operands]
            result = values[0]
            for operand in values[1:]:
                if operation == "union":
                    result = result + operand
                elif operation == "subtract":
                    result = result - operand
                elif operation in {"intersect", "intersection"}:
                    result = result ^ operand
                else:
                    raise GeometryValidationError(f"Boolean scene region {identifier} has unsupported operation {operation or '<empty>'}.")
            manifold = _apply_transform(result, region)
        else:
            manifold = _apply_transform(_primitive_manifold(region), region)
        resolving.remove(identifier)
        if manifold.is_empty() or str(manifold.status()) != "Error.NoError":
            raise GeometryValidationError(f"Scene region {identifier} evaluates to an empty or invalid manifold.")
        built[identifier] = manifold
        return manifold

    referenced_operands: set[str] = set()
    for raw in raw_regions:
        if not isinstance(raw, dict):
            continue
        geometry_value = raw.get("geometry", raw)
        geometry = geometry_value if isinstance(geometry_value, dict) else {}
        operands = geometry.get("boolean_operands", raw.get("boolean_operands", []))
        if isinstance(operands, list):
            referenced_operands.update(str(operand) for operand in operands)
    visible_modeled_ids = [
        str(raw.get("id", ""))
        for raw in raw_regions
        if isinstance(raw, dict) and raw.get("visible", True) and str(raw.get("kind", "")).lower() != "dicom"
    ]
    for identifier in visible_modeled_ids:
        build(identifier)
    regions: list[CanonicalRegion] = []
    for raw in raw_regions:
        if not isinstance(raw, dict) or not raw.get("visible", True) or str(raw.get("kind", "")).lower() == "dicom":
            continue
        identifier = str(raw.get("id", ""))
        if identifier in referenced_operands:
            continue
        owner = str(raw.get("owner", ""))
        tool, _, owner_region = owner.partition(":")
        region_name = str(raw.get("region") or owner_region or identifier)
        if not re.fullmatch(r"T[01]", tool) or not region_name:
            raise GeometryValidationError(f"Scene region {identifier or '<unnamed>'} requires explicit tool and region ownership.")
        if raw.get("target_hu") is None:
            raise GeometryValidationError(f"Scene region {identifier} requires an explicit finite target_hu.")
        target_hu = float(raw["target_hu"])
        if not math.isfinite(target_hu):
            raise GeometryValidationError(f"Scene region {identifier} target HU must be finite.")
        regions.append(CanonicalRegion(identifier, region_name, tool, target_hu, build(identifier)))
    if visible_modeled_ids and not regions:
        raise GeometryValidationError("Scene has modeled operands but no visible root solid to own printable occupancy.")
    hash_scene = canonical_scene_manifest(scene)
    payload = json.dumps(canonicalize(hash_scene), sort_keys=True, separators=(",", ":")).encode("utf-8")
    return CanonicalScene(tuple(regions), hashlib.sha256(payload).hexdigest())


def canonical_scene_manifest(scene: dict[str, Any]) -> dict[str, Any]:
    """Return a path-safe, content-addressed scene manifest for hashing/export."""

    hash_scene = deepcopy(scene)
    hash_regions = hash_scene.get("regions", [])
    if isinstance(hash_regions, list):
        for raw in hash_regions:
            if not isinstance(raw, dict):
                continue
            geometry_value = raw.get("geometry", raw)
            geometry = geometry_value if isinstance(geometry_value, dict) else {}
            source_path = raw.get("source_path") or geometry.get("source_path")
            if source_path:
                if str(raw.get("kind", "")).lower() == "dicom":
                    raw["source_path"] = {"source_reference": "selection_manifest"}
                else:
                    mesh = load_mesh_file(source_path)
                    raw["source_path"] = {"sha256": mesh.sha256, "format": str(source_path).rsplit(".", 1)[-1].lower()}
                geometry.pop("vertices", None)
                geometry.pop("faces", None)
    return hash_scene


@dataclass(frozen=True, slots=True)
class ModeledVolumeIdentity:
    source_hash: str


@dataclass(frozen=True, slots=True)
class ModeledSelectionManifest:
    source_hash: str
    print_size_mm: Vec3
    source_bounds_mm: tuple[Vec3, Vec3]
    source_to_print_transform: tuple[tuple[float, ...], ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": "voxelweave.modeled-selection-manifest.v1",
            "source": "canonical_manifold_scene",
            "source_hash": self.source_hash,
            "print_size_mm": list(self.print_size_mm),
            "source_bounds_mm": [list(self.source_bounds_mm[0]), list(self.source_bounds_mm[1])],
            "source_to_print_transform": [list(row) for row in self.source_to_print_transform],
            "physical_geometry_claim": "canonical_geometry_only_deposition_requires_validation",
            "physical_fidelity_claim": "not_established_by_software",
        }


@dataclass(slots=True)
class ModeledPrintSelection:
    canonical_scene: CanonicalScene
    layer_height_mm: float
    mode: str = "modeled"
    selected_source_indices: tuple[int, ...] = (0,)
    plate_layout: dict[str, Any] = field(default_factory=dict)
    structural_regions: tuple[dict[str, Any], ...] = ()
    print_size_mm: Vec3 = field(init=False)
    scene_origin_mm: Vec3 = field(init=False)
    volume: ModeledVolumeIdentity = field(init=False)
    manifest: ModeledSelectionManifest = field(init=False)

    def __post_init__(self) -> None:
        low_x, low_y, low_z, high_x, high_y, high_z = self.canonical_scene.bounds
        size: Vec3 = (high_x - low_x, high_y - low_y, high_z - low_z)
        if any(item <= 0 for item in size):
            raise GeometryValidationError("Canonical modeled scene has no positive printable volume.")
        self.print_size_mm = size
        self.scene_origin_mm = (low_x, low_y, low_z)
        self.volume = ModeledVolumeIdentity(self.canonical_scene.source_hash)
        matrix = (
            (1.0, 0.0, 0.0, -low_x),
            (0.0, 1.0, 0.0, -low_y),
            (0.0, 0.0, 1.0, -low_z),
            (0.0, 0.0, 0.0, 1.0),
        )
        self.manifest = ModeledSelectionManifest(self.canonical_scene.source_hash, size, ((low_x, low_y, low_z), (high_x, high_y, high_z)), matrix)

    @property
    def layer_count(self) -> int:
        return max(1, int(math.ceil(self.print_size_mm[2] / self.layer_height_mm - 1e-12)))

    def scene_position(self, x_mm: float, y_mm: float, z_mm: float) -> Vec3:
        return (x_mm + self.scene_origin_mm[0], y_mm + self.scene_origin_mm[1], z_mm + self.scene_origin_mm[2])

    def rail_sample_position(self, x_mm: float, y_mm: float, z_mm: float, *, tile_index: int | None = None) -> Vec3:
        del tile_index
        return self.scene_position(x_mm, y_mm, z_mm)

    def sample_hu(self, x_mm: float, y_mm: float, z_mm: float, *, tile_index: int | None = None, method: str = "linear") -> float:
        del tile_index, method
        position = self.scene_position(x_mm, y_mm, z_mm)
        region = self.canonical_scene.region_at(*position)
        return 0.0 if region is None else region.target_hu
