"""Fail-closed checks used by the native release packaging path."""

from __future__ import annotations

import importlib
import platform
from typing import Any

from .errors import EngineError


def require_release_dependencies(*, require_arm64: bool = True) -> dict[str, str]:
    """Require the native quantitative preview and manifold geometry stack."""

    machine = platform.machine().lower()
    if require_arm64 and machine not in {"arm64", "aarch64"}:
        raise EngineError(f"Native release packaging requires an arm64 runtime; detected {machine or 'unknown'}.")
    loaded: dict[str, str] = {}
    for module_name in ("scipy", "manifold3d"):
        try:
            module = importlib.import_module(module_name)
        except Exception as exc:  # pragma: no cover - exercised by packaging environments
            raise EngineError(f"Native release dependency {module_name} is unavailable; refusing to package a fallback sidecar.") from exc
        location = str(getattr(module, "__file__", ""))
        if not location:
            raise EngineError(f"Native release dependency {module_name} has no importable package location.")
        loaded[module_name] = location
    return loaded


def release_dependency_status() -> dict[str, Any]:
    try:
        return {"passed": True, "dependencies": require_release_dependencies(require_arm64=False)}
    except EngineError as exc:
        return {"passed": False, "error": str(exc)}
