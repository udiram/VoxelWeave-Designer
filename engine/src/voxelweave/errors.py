"""Typed, PHI-safe engine errors."""

from __future__ import annotations


class EngineError(RuntimeError):
    """Base class for expected, user-actionable engine failures."""


class DicomValidationError(EngineError):
    """Raised when a DICOM source cannot be interpreted as a supported CT volume."""


class GeometryValidationError(EngineError):
    """Raised when physical geometry or a print selection is invalid."""


class CalibrationMismatchError(EngineError):
    """Raised when a calibration is absent or not exactly compatible with a print."""


class ToolpathAuditError(EngineError):
    """Raised when generated or supplied G-code fails the reverse audit."""


class ProtocolError(EngineError):
    """Raised for malformed or unsupported JSON-lines control messages."""


class CancellationError(EngineError):
    """Raised when a cancellable operation is cancelled before completion."""
