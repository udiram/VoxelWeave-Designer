"""VoxelWeave Designer's deterministic scientific engine.

The package deliberately keeps the scientific source in full-resolution signed HU
arrays. Preview products and protocol messages are derived views and are never
accepted as slicing input.
"""

from .binary import BinaryArtifact, read_binary_array, write_binary_array
from .calibration import (
    Calibration,
    CalibrationBinding,
    CalibrationSet,
    RailField,
    RailSample,
)
from .dicom import (
    DicomInspection,
    DicomSeriesSummary,
    Volume,
    inspect_dicom_source,
    load_dicom_series,
    select_dicom_series,
)
from .engine import EngineSession
from .errors import (
    CalibrationMismatchError,
    CancellationError,
    DicomValidationError,
    EngineError,
    GeometryValidationError,
    ProtocolError,
    ToolpathAuditError,
)
from .models import CancellationToken, ProgressEvent
from .mpr import (
    MPRPlane,
    build_volume_cache,
    calculate_histogram,
    request_mpr_plane,
    request_volume_preview,
    sample_voxel,
)
from .protocol import ControlEnvelope, Operation, encode_jsonl, parse_jsonl
from .scanback import ScanBackVerification, verify_scan_back
from .selection import PrintSelection, SelectionManifest, create_print_selection
from .synthetic import (
    create_synthetic_volume,
    synthetic_scan_back,
    write_synthetic_dicom_series,
)
from .toolpath import (
    GeneratedToolpath,
    PrinterProfile,
    ToolpathSegment,
    export_run_package,
    generate_toolpath,
    reverse_audit_gcode,
)

__all__ = [
    "BinaryArtifact",
    "Calibration",
    "CalibrationBinding",
    "CalibrationMismatchError",
    "CalibrationSet",
    "CancellationError",
    "CancellationToken",
    "ControlEnvelope",
    "DicomInspection",
    "DicomSeriesSummary",
    "DicomValidationError",
    "EngineError",
    "EngineSession",
    "GeneratedToolpath",
    "GeometryValidationError",
    "MPRPlane",
    "Operation",
    "PrintSelection",
    "PrinterProfile",
    "ProgressEvent",
    "ProtocolError",
    "RailField",
    "RailSample",
    "ScanBackVerification",
    "SelectionManifest",
    "ToolpathAuditError",
    "ToolpathSegment",
    "Volume",
    "calculate_histogram",
    "build_volume_cache",
    "create_print_selection",
    "create_synthetic_volume",
    "encode_jsonl",
    "export_run_package",
    "generate_toolpath",
    "inspect_dicom_source",
    "load_dicom_series",
    "parse_jsonl",
    "read_binary_array",
    "request_mpr_plane",
    "request_volume_preview",
    "reverse_audit_gcode",
    "sample_voxel",
    "select_dicom_series",
    "synthetic_scan_back",
    "verify_scan_back",
    "write_binary_array",
    "write_synthetic_dicom_series",
]
