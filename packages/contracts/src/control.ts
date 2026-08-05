/** Versioned bounded control messages shared by Tauri/TypeScript and Python. */

export const CONTROL_PROTOCOL = "voxelweave.control.v1" as const;

export type Operation =
  | "inspect_dicom_source"
  | "select_dicom_series"
  | "build_volume_cache"
  | "request_mpr_plane"
  | "request_volume_preview"
  | "sample_voxel"
  | "calculate_histogram"
  | "create_print_selection"
  | "validate_scene"
  | "generate_toolpath"
  | "reverse_audit_gcode"
  | "export_run_package"
  | "verify_scan_back"
  | "cancel";

export interface ControlEnvelope<P extends Record<string, unknown> = Record<string, unknown>> {
  protocol: typeof CONTROL_PROTOCOL;
  request_id: string;
  operation: Operation;
  payload: P;
}

export interface ProgressEvent {
  request_id: string;
  operation: Operation;
  stage: string;
  completed: number;
  total: number;
  fraction: number;
  message: string;
}

export interface BinaryArtifactHeader {
  format: "voxelweave.binary.v1";
  artifact_type: string;
  dtype: string;
  shape: number[];
  payload_bytes: number;
  payload_sha256: string;
  spacing_mm_dyx?: number[];
  origin_lps?: number[];
  direction_lps?: number[][];
  source_hash?: string;
}

export interface ArtifactReference {
  path: string;
  sha256: string;
  header: BinaryArtifactHeader;
}

export interface CancelPayload {
  request_id: string;
}

export interface OperationResponse<T extends Record<string, unknown> = Record<string, unknown>> {
  protocol: "voxelweave.response.v1";
  request_id: string;
  operation: Operation;
  ok: boolean;
  payload?: T;
  error?: {
    code: string;
    message: string;
  };
}
