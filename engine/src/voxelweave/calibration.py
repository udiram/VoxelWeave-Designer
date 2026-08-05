"""Calibration identity binding and monotonic HU-to-rail mapping."""

from __future__ import annotations

import json
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

import numpy as np

from .dicom import Volume
from .errors import CalibrationMismatchError
from .models import Vec3, canonicalize


@dataclass(frozen=True, slots=True)
class CalibrationBinding:
    pitch_mm: float
    layer_height_mm: float
    nozzle_mm: float
    tool: str
    material: str
    lot: str
    printer: str
    scanner: str
    reconstruction: str
    flow_mm3_s: float = 1.0
    flow_mm3_per_min: float | None = None
    material_density_g_cm3: float | None = None

    @property
    def effective_flow_mm3_s(self) -> float:
        return self.flow_mm3_s if self.flow_mm3_per_min is None else self.flow_mm3_per_min / 60.0

    def to_dict(self) -> dict[str, Any]:
        return cast(dict[str, Any], canonicalize(
            {
                "pitch_mm": self.pitch_mm,
                "layer_height_mm": self.layer_height_mm,
                "nozzle_mm": self.nozzle_mm,
                "tool": self.tool,
                "material": self.material,
                "lot": self.lot,
                "printer": self.printer,
                "scanner": self.scanner,
                "reconstruction": self.reconstruction,
                "flow_mm3_s": self.flow_mm3_s,
                "flow_mm3_per_min": self.flow_mm3_per_min,
                "material_density_g_cm3": self.material_density_g_cm3,
            }
        ))

    def matches(self, other: CalibrationBinding, *, tolerance_mm: float = 1e-6) -> bool:
        float_fields = ("pitch_mm", "layer_height_mm", "nozzle_mm")
        string_fields = ("tool", "material", "lot", "printer", "scanner", "reconstruction")
        return all(abs(getattr(self, key) - getattr(other, key)) <= tolerance_mm for key in float_fields) and abs(self.effective_flow_mm3_s - other.effective_flow_mm3_s) <= tolerance_mm and all(
            getattr(self, key) == getattr(other, key) for key in string_fields
        )


@dataclass(frozen=True, slots=True)
class Calibration:
    calibration_id: str
    binding: CalibrationBinding
    commanded_width_mm: tuple[float, ...]
    measured_hu_mean: tuple[float, ...]
    measured_hu_sd: tuple[float, ...] = ()
    accepted: bool = True
    evidence_reference: str = "synthetic-or-user-supplied"

    def __post_init__(self) -> None:
        widths = np.asarray(self.commanded_width_mm, dtype=float)
        hu = np.asarray(self.measured_hu_mean, dtype=float)
        if len(widths) < 2 or len(widths) != len(hu):
            raise CalibrationMismatchError("Calibration requires at least two width/HU points of equal length.")
        if self.binding.effective_flow_mm3_s <= 0:
            raise CalibrationMismatchError("Calibration flow must be positive.")
        if self.binding.material_density_g_cm3 is not None and (
            not np.isfinite(self.binding.material_density_g_cm3) or self.binding.material_density_g_cm3 <= 0
        ):
            raise CalibrationMismatchError("Calibration material density must be finite and positive when supplied.")
        if not np.all(np.isfinite(widths)) or not np.all(np.isfinite(hu)):
            raise CalibrationMismatchError("Calibration contains non-finite width or HU values.")
        if np.any(widths <= 0) or np.any(np.diff(widths) <= 0):
            raise CalibrationMismatchError("Calibration commanded widths must be strictly increasing and positive.")
        if np.any(np.diff(hu) <= 0):
            raise CalibrationMismatchError("Calibration measured HU must increase monotonically with commanded width.")
        if len(self.measured_hu_sd) > 0 and len(self.measured_hu_sd) != len(widths):
            raise CalibrationMismatchError("Calibration HU uncertainty must match the calibration point count.")
        if not self.accepted:
            raise CalibrationMismatchError("Calibration is not accepted for generation.")

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> Calibration:
        binding_data = dict(value.get("binding", {}))
        density_value = binding_data.get(
            "material_density_g_cm3",
            binding_data.get("material_density_g_per_cm3", binding_data.get("density_g_cm3")),
        )
        binding = CalibrationBinding(
            pitch_mm=float(binding_data["pitch_mm"]),
            layer_height_mm=float(binding_data["layer_height_mm"]),
            nozzle_mm=float(binding_data["nozzle_mm"]),
            tool=str(binding_data["tool"]),
            material=str(binding_data["material"]),
            lot=str(binding_data["lot"]),
            printer=str(binding_data["printer"]),
            scanner=str(binding_data["scanner"]),
            reconstruction=str(binding_data["reconstruction"]),
            flow_mm3_s=float(binding_data.get("flow_mm3_s", 1.0)),
            flow_mm3_per_min=(float(binding_data["flow_mm3_per_min"]) if "flow_mm3_per_min" in binding_data and "flow_mm3_s" not in binding_data else None),
            material_density_g_cm3=(float(density_value) if density_value is not None else None),
        )
        return cls(
            calibration_id=str(value["calibration_id"]),
            binding=binding,
            commanded_width_mm=tuple(float(item) for item in value["commanded_width_mm"]),
            measured_hu_mean=tuple(float(item) for item in value["measured_hu_mean"]),
            measured_hu_sd=tuple(float(item) for item in value.get("measured_hu_sd", ())),
            accepted=bool(value.get("accepted", True)),
            evidence_reference=str(value.get("evidence_reference", "synthetic-or-user-supplied")),
        )

    @classmethod
    def from_json(cls, path: str | Path) -> Calibration:
        return cls.from_dict(json.loads(Path(path).read_text(encoding="utf-8")))

    @property
    def hu_range(self) -> tuple[float, float]:
        return self.measured_hu_mean[0], self.measured_hu_mean[-1]

    @property
    def width_range(self) -> tuple[float, float]:
        return self.commanded_width_mm[0], self.commanded_width_mm[-1]

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": "voxelweave.calibration.v1",
            "calibration_id": self.calibration_id,
            "binding": self.binding.to_dict(),
            "commanded_width_mm": list(self.commanded_width_mm),
            "measured_hu_mean": list(self.measured_hu_mean),
            "measured_hu_sd": list(self.measured_hu_sd),
            "accepted": self.accepted,
            "evidence_reference": self.evidence_reference,
        }

    def map_hu(self, hu: float | np.ndarray, *, allow_clipping: bool = False) -> tuple[np.ndarray, np.ndarray, str]:
        values = np.atleast_1d(np.asarray(hu, dtype=float))
        lo, hi = self.hu_range
        outside = (values < lo) | (values > hi)
        if np.any(outside) and not allow_clipping:
            raise CalibrationMismatchError(
                f"HU values fall outside calibration range [{lo:g}, {hi:g}]; supply accepted calibration coverage or acknowledge clipping."
            )
        clipped = np.clip(values, lo, hi)
        widths = np.interp(clipped, np.asarray(self.measured_hu_mean), np.asarray(self.commanded_width_mm))
        status = "clipped" if np.any(outside) else "in_range"
        return clipped.astype(np.float64), widths.astype(np.float64), status

    def rail_sample(
        self,
        *,
        source_position_lps: Vec3,
        source_hu: float,
        target_hu: float | None = None,
        region: str = "measurement_roi",
        allow_clipping: bool = False,
    ) -> RailSample:
        target = float(source_hu if target_hu is None else target_hu)
        clipped, width, status = self.map_hu(np.asarray([target]), allow_clipping=allow_clipping)
        command_width = float(width[0])
        return RailSample(
            occupied=bool(region != "empty"),
            source_position_lps=source_position_lps,
            source_hu=float(source_hu),
            clipped_hu=float(clipped[0]),
            region=region,
            tool=self.binding.tool,
            material=self.binding.material,
            calibration_id=self.calibration_id,
            target_hu=target,
            effective_fill=command_width / self.binding.pitch_mm,
            commanded_width_mm=command_width,
            range_status=status,
        )


@dataclass(frozen=True, slots=True)
class CalibrationSet:
    calibrations: tuple[Calibration, ...]

    @classmethod
    def from_iterable(cls, calibrations: Iterable[Calibration]) -> CalibrationSet:
        values = tuple(calibrations)
        if not values:
            raise CalibrationMismatchError("At least one accepted calibration is required.")
        return cls(values)

    def resolve(self, binding: CalibrationBinding) -> Calibration:
        matches = [item for item in self.calibrations if item.binding.matches(binding)]
        if len(matches) != 1:
            if not matches:
                raise CalibrationMismatchError("No accepted calibration matches pitch, layer, tool, material, lot, printer, scanner, and reconstruction.")
            raise CalibrationMismatchError("Calibration identity is ambiguous; exactly one accepted calibration must match.")
        return matches[0]


@dataclass(frozen=True, slots=True)
class RailSample:
    occupied: bool
    source_position_lps: Vec3
    source_hu: float
    clipped_hu: float
    region: str
    tool: str
    material: str
    calibration_id: str
    target_hu: float
    effective_fill: float
    commanded_width_mm: float
    range_status: str

    def to_dict(self) -> dict[str, Any]:
        return cast(dict[str, Any], canonicalize(
            {
                "occupied": self.occupied,
                "source_position_lps": self.source_position_lps,
                "source_hu": self.source_hu,
                "clipped_hu": self.clipped_hu,
                "region": self.region,
                "tool": self.tool,
                "material": self.material,
                "calibration_id": self.calibration_id,
                "target_hu": self.target_hu,
                "effective_fill": self.effective_fill,
                "commanded_width_mm": self.commanded_width_mm,
                "range_status": self.range_status,
            }
        ))


@dataclass(slots=True)
class RailField:
    """Canonical field query over a full-resolution volume and accepted calibration."""

    volume: Volume
    calibration: Calibration
    binding: CalibrationBinding
    region: str = "measurement_roi"

    def __post_init__(self) -> None:
        if not self.calibration.binding.matches(self.binding):
            raise CalibrationMismatchError("Rail field binding does not exactly match its calibration identity.")

    def query(self, position_lps: Vec3, *, target_hu: float | None = None, allow_clipping: bool = False) -> RailSample:
        source_hu = self.volume.sample(position_lps)
        return self.calibration.rail_sample(
            source_position_lps=position_lps,
            source_hu=source_hu,
            target_hu=target_hu,
            region=self.region,
            allow_clipping=allow_clipping,
        )

    def query_many(self, positions_lps: Sequence[Vec3], *, allow_clipping: bool = False) -> tuple[RailSample, ...]:
        return tuple(self.query(position, allow_clipping=allow_clipping) for position in positions_lps)
