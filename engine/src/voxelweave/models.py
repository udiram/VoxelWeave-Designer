"""Small shared value types used by the engine modules."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from threading import Event
from typing import Any

import numpy as np

from .errors import CancellationError

Vec3 = tuple[float, float, float]


def as_vec3(value: Any, *, name: str) -> Vec3:
    try:
        result = tuple(float(item) for item in value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must contain three finite numbers.") from exc
    if len(result) != 3 or not all(np.isfinite(result)):
        raise ValueError(f"{name} must contain three finite numbers.")
    return result


def canonicalize(value: Any) -> Any:
    """Convert dataclasses/arrays into deterministic JSON-compatible values."""

    if hasattr(value, "to_dict"):
        return canonicalize(value.to_dict())
    if isinstance(value, Mapping):
        return {str(key): canonicalize(value[key]) for key in sorted(value)}
    if isinstance(value, (tuple, list)):
        return [canonicalize(item) for item in value]
    if isinstance(value, np.ndarray):
        return canonicalize(value.tolist())
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, float):
        if not np.isfinite(value):
            return None
        return float(f"{value:.12g}")
    return value


@dataclass(slots=True)
class CancellationToken:
    """Cooperative cancellation state shared by long operations."""

    _event: Event = field(default_factory=Event)

    def cancel(self) -> None:
        self._event.set()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def checkpoint(self) -> None:
        if self.cancelled:
            raise CancellationError("Operation cancelled before completion.")


@dataclass(frozen=True, slots=True)
class ProgressEvent:
    request_id: str
    operation: str
    stage: str
    completed: int
    total: int
    message: str

    @property
    def fraction(self) -> float:
        return 0.0 if self.total <= 0 else min(1.0, max(0.0, self.completed / self.total))

    def to_dict(self) -> dict[str, Any]:
        return {
            "request_id": self.request_id,
            "operation": self.operation,
            "stage": self.stage,
            "completed": self.completed,
            "total": self.total,
            "fraction": self.fraction,
            "message": self.message,
        }


ProgressCallback = Callable[[ProgressEvent], None]
