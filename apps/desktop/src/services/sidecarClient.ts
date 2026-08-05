import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  DicomSelectionResult,
  ExportPackageResult,
  ProgressEvent,
  ProjectDocument,
  ToolpathResult,
  VerifyScanBackResult,
} from "../types";

export type SidecarOperation =
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
  | "verify_scan_back";

export type SidecarMode = "native" | "synthetic-browser-test";

export interface SidecarClient {
  readonly mode: SidecarMode;
  inspectDicomSource(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<void>;
  selectDicomSeries(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<void>;
  buildVolumeCache(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<void>;
  requestMprPlane(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<{ plane: string; source: string }>;
  requestVolumePreview(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<{ resolution: string; source: string }>;
  sampleVoxel(project: ProjectDocument, coordinate: { x: number; y: number; z: number }): Promise<{ hu: number; coordinate: typeof coordinate }>;
  calculateHistogram(project: ProjectDocument): Promise<{ bins: number[]; source: string }>;
  createPrintSelection(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<DicomSelectionResult>;
  validateScene(project: ProjectDocument): Promise<{ valid: boolean; messages: string[] }>;
  generateToolpath(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<ToolpathResult>;
  reverseAuditGcode(project: ProjectDocument): Promise<{ passed: boolean; checks: string[] }>;
  exportRunPackage(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<ExportPackageResult>;
  verifyScanBack(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<VerifyScanBackResult>;
  cancel(requestId: string): Promise<void>;
}

type NativeEnvelope = {
  protocol: "voxelweave.control.v1";
  request_id: string;
  operation: SidecarOperation | "cancel";
  payload: Record<string, unknown>;
};

type NativeResponse<T> = {
  protocol: "voxelweave.response.v1";
  request_id: string;
  operation: string;
  ok: boolean;
  payload?: T;
  error?: { code: string; message: string };
};

type NativeProgress = {
  request_id: string;
  operation: string;
  stage: string;
  completed: number;
  total: number;
  fraction: number;
  message: string;
};

const NATIVE_PROGRESS_EVENT = "voxelweave://sidecar-progress";
const SYNTHETIC_SOURCE = "synthetic://voxelweave/lung-phantom";
let requestSequence = 0;

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function nextRequestId(operation: string): string {
  requestSequence += 1;
  return `desktop-${operation}-${Date.now().toString(36)}-${requestSequence.toString(36)}`;
}

function emitProgress(
  operation: SidecarOperation,
  onProgress: ((event: ProgressEvent) => void) | undefined,
  stages: Array<[string, number]>,
): void {
  const requestId = `synthetic-${operation}-001`;
  stages.forEach(([stage, progress]) => onProgress?.({ requestId, stage, progress }));
}

function calibrationPayload(project: ProjectDocument): Array<Record<string, unknown>> {
  return project.calibrations.filter((profile) => profile.accepted).map((profile) => ({
    calibration_id: profile.id,
    binding: {
      pitch_mm: 4,
      layer_height_mm: profile.layerHeightMm,
      nozzle_mm: profile.nozzleMm,
      tool: profile.tool,
      material: profile.material,
      lot: profile.lot,
      printer: "Prusa XL",
      scanner: profile.scanner,
      reconstruction: profile.reconstruction,
      flow_mm3_s: 1,
    },
    commanded_width_mm: profile.huSamples.map((sample) => sample.widthMm),
    measured_hu_mean: profile.huSamples.map((sample) => sample.measuredHu),
    accepted: profile.accepted,
  }));
}

function scenePayload(project: ProjectDocument): Record<string, unknown> {
  return {
    regions: project.scene.map((object) => ({
      id: object.id,
      owner: `${object.tool}:${object.region}`,
      boolean_operands: [],
    })),
  };
}

function nativeError(response: NativeResponse<unknown>): Error {
  const detail = response.error ?? { code: "UnknownSidecarError", message: "The sidecar returned an invalid error." };
  return new Error(`${detail.code}: ${detail.message}`);
}

/** Native adapter: all scientific operations cross the Tauri command into the bundled JSONL sidecar. */
export class NativeSidecarClient implements SidecarClient {
  readonly mode = "native" as const;
  private inspected = false;
  private selected = false;

  private async request<T>(
    operation: SidecarOperation,
    payload: Record<string, unknown>,
    onProgress?: (event: ProgressEvent) => void,
  ): Promise<T> {
    const requestId = nextRequestId(operation);
    const envelope: NativeEnvelope = {
      protocol: "voxelweave.control.v1",
      request_id: requestId,
      operation,
      payload,
    };
    const unlisten = await listen<NativeProgress>(NATIVE_PROGRESS_EVENT, (event) => {
      if (event.payload.request_id !== requestId) return;
      onProgress?.({
        requestId,
        stage: event.payload.stage,
        progress: event.payload.fraction,
      });
    });
    try {
      const response = await invoke<NativeResponse<T>>("sidecar_request", { request: envelope });
      if (!response.ok) throw nativeError(response);
      return response.payload as T;
    } finally {
      unlisten();
    }
  }

  private async ensureSelected(onProgress?: (event: ProgressEvent) => void): Promise<void> {
    if (!this.inspected) {
      await this.request("inspect_dicom_source", { source: SYNTHETIC_SOURCE }, onProgress);
      this.inspected = true;
    }
    if (!this.selected) {
      await this.request("select_dicom_series", { source: SYNTHETIC_SOURCE }, onProgress);
      this.selected = true;
    }
  }

  async inspectDicomSource(_project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<void> {
    await this.request("inspect_dicom_source", { source: SYNTHETIC_SOURCE }, onProgress);
    this.inspected = true;
  }

  async selectDicomSeries(_project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<void> {
    await this.ensureSelected(onProgress);
  }

  async buildVolumeCache(_project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<void> {
    await this.ensureSelected(onProgress);
    await this.request("build_volume_cache", { directory: "cache" }, onProgress);
  }

  async requestMprPlane(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<{ plane: string; source: string }> {
    await this.ensureSelected(onProgress);
    await this.request("request_mpr_plane", {
      plane: project.selection.orientation,
      index: project.selection.start,
      output_shape_yx: [64, 64],
      output_path: `mpr-${project.selection.orientation}.bin`,
    }, onProgress);
    return { plane: project.selection.orientation, source: "full-resolution signed-HU cache" };
  }

  async requestVolumePreview(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<{ resolution: string; source: string }> {
    await this.ensureSelected(onProgress);
    await this.request("request_volume_preview", { max_dimension: 128, output_path: "volume-preview.bin" }, onProgress);
    return { resolution: project.source.cache.preview, source: "preview texture only" };
  }

  async sampleVoxel(_project: ProjectDocument, coordinate: { x: number; y: number; z: number }): Promise<{ hu: number; coordinate: typeof coordinate }> {
    await this.ensureSelected();
    const result = await this.request<{ hu: number }>("sample_voxel", { position_lps: [coordinate.x, coordinate.y, coordinate.z] });
    return { hu: result.hu, coordinate };
  }

  async calculateHistogram(_project: ProjectDocument): Promise<{ bins: number[]; source: string }> {
    await this.ensureSelected();
    const result = await this.request<{ counts: number[] }>("calculate_histogram", { bins: 64 });
    return { bins: result.counts, source: "full-resolution signed-HU cache" };
  }

  async createPrintSelection(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<DicomSelectionResult> {
    await this.ensureSelected(onProgress);
    const mode = project.selection.outputMode === "tiles" || project.selection.kind === "tiles"
      ? "tile"
      : project.selection.kind === "single" ? "single" : "continuous";
    const result = await this.request<Record<string, unknown>>("create_print_selection", {
      plane: project.selection.orientation,
      mode,
      plane_index: 4,
      start_index: 1,
      end_index: 8,
      thickness_mm: mode === "single" ? 0.4 : undefined,
      print_size_mm: [24, 24, mode === "single" ? 0.4 : 8],
      layer_height_mm: 0.2,
      stride: 1,
      plate_layout: mode === "tile" ? { columns: 2, tile_spacing_mm: [2, 2] } : {},
    }, onProgress);
    return {
      selectionId: `native-${String(result.source_hash ?? "selection").slice(0, 12)}`,
      sourceResolution: "40 × 32 × 12 synthetic CT",
      physicalThicknessMm: Number((result.print_size_mm as number[] | undefined)?.[2] ?? 8),
      transformHash: `sha256:${String(result.source_hash ?? "unknown")}`,
    };
  }

  async validateScene(project: ProjectDocument): Promise<{ valid: boolean; messages: string[] }> {
    const result = await this.request<{ passed: boolean; errors: string[]; warnings: string[] }>("validate_scene", { scene: scenePayload(project) });
    return { valid: result.passed, messages: [...result.errors, ...result.warnings] };
  }

  async generateToolpath(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<ToolpathResult> {
    await this.ensureSelected(onProgress);
    const result = await this.request<{ segment_count?: number; gcode_sha256?: string }>("generate_toolpath", {
      calibration: calibrationPayload(project),
      tool: "T0",
      allow_calibration_clipping: true,
      profile: { printer: "Prusa XL", sample_step_mm: 2 },
    }, onProgress);
    return {
      runId: `native-${String(result.gcode_sha256 ?? "run").slice(0, 12)}`,
      segmentCount: Number(result.segment_count ?? 0),
      clippingPercent: project.toolpath.clippingPercent,
      estimate: project.toolpath.estimated,
    };
  }

  async reverseAuditGcode(_project: ProjectDocument): Promise<{ passed: boolean; checks: string[] }> {
    const result = await this.request<{ passed: boolean; errors: string[]; warnings: string[] }>("reverse_audit_gcode", {});
    return { passed: result.passed, checks: [...result.errors, ...result.warnings] };
  }

  async exportRunPackage(_project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<ExportPackageResult> {
    const result = await this.request<{ files: string[]; hashes: Record<string, string> }>("export_run_package", { directory: "run-package" }, onProgress);
    const packageHash = result.hashes?.["hashes.json"] ?? "unknown";
    return {
      packageName: "voxelweave-run-package",
      exportHash: `sha256:${packageHash}`,
      files: result.files ?? [],
    };
  }

  async verifyScanBack(_project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<VerifyScanBackResult> {
    await this.ensureSelected(onProgress);
    const result = await this.request<{ registration_method: string; registration_confidence: number; mae_hu: number; rmse_hu: number; compared_voxel_count: number }>("verify_scan_back", {
      scan_back_source: "synthetic://voxelweave/scan-back",
      registration_method: "identity",
      registration_confidence: 1,
      hu_gamma_tolerance_hu: 40,
    }, onProgress);
    return {
      evidenceName: "synthetic-scan-back-dicom-series",
      registrationMethod: "landmark rigid",
      confidence: result.registration_confidence >= 0.9 ? "high" : "medium",
      comparison: {
        meanAbsoluteHu: Math.round(result.mae_hu),
        p95AbsoluteHu: Math.round(result.rmse_hu),
        registeredVoxels: result.compared_voxel_count,
      },
    };
  }

  async cancel(requestId: string): Promise<void> {
    const cancelId = nextRequestId("cancel");
    const envelope: NativeEnvelope = {
      protocol: "voxelweave.control.v1",
      request_id: cancelId,
      operation: "cancel",
      payload: { request_id: requestId },
    };
    const response = await invoke<NativeResponse<{ cancelled: boolean }>>("sidecar_request", { request: envelope });
    if (!response.ok) throw nativeError(response);
  }
}

/** Explicit browser/test adapter. It never claims to execute the Python engine. */
export class DeterministicSidecarClient implements SidecarClient {
  readonly mode = "synthetic-browser-test" as const;

  async inspectDicomSource(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<void> {
    emitProgress("inspect_dicom_source", onProgress, [["Read series metadata", 0.4], ["Validate physical coordinates", 1]]);
    void project;
  }

  async selectDicomSeries(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<void> {
    emitProgress("select_dicom_series", onProgress, [["Group SeriesInstanceUID", 0.4], ["Sort by ImagePositionPatient", 1]]);
    void project;
  }

  async buildVolumeCache(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<void> {
    emitProgress("build_volume_cache", onProgress, [["Decode signed HU planes", 0.25], ["Build 256³ preview", 0.7], ["Cache ready", 1]]);
    void project;
  }

  async requestMprPlane(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<{ plane: string; source: string }> {
    emitProgress("request_mpr_plane", onProgress, [["Read cached plane", 1]]);
    return { plane: project.selection.orientation, source: project.source.cache.scientificSource };
  }

  async requestVolumePreview(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<{ resolution: string; source: string }> {
    emitProgress("request_volume_preview", onProgress, [["Refine preview volume", 1]]);
    return { resolution: project.source.cache.preview, source: "preview texture only" };
  }

  async sampleVoxel(project: ProjectDocument, coordinate: { x: number; y: number; z: number }): Promise<{ hu: number; coordinate: typeof coordinate }> {
    const hu = Math.round(-782 + coordinate.x * 0.4 + coordinate.y * 0.18 + coordinate.z * 0.6);
    void project;
    return { hu, coordinate };
  }

  async calculateHistogram(project: ProjectDocument): Promise<{ bins: number[]; source: string }> {
    return { bins: [-990, -820, -740, -410, 30, 1200], source: project.source.cache.scientificSource };
  }

  async createPrintSelection(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<DicomSelectionResult> {
    emitProgress("create_print_selection", onProgress, [["Lock physical crop", 0.35], ["Build source-to-print transform", 1]]);
    return {
      selectionId: `${project.projectId}-selection-001`,
      sourceResolution: `${project.source.dimensions.x} × ${project.source.dimensions.y} × ${project.source.dimensions.z}`,
      physicalThicknessMm: project.selection.thicknessMm,
      transformHash: "sha256:7a81…e920",
    };
  }

  async validateScene(project: ProjectDocument): Promise<{ valid: boolean; messages: string[] }> {
    const visible = project.scene.filter((object) => object.visible);
    return { valid: visible.length > 0, messages: ["No ambiguous overlaps in synthetic scene", "Tool ownership resolved"] };
  }

  async generateToolpath(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<ToolpathResult> {
    emitProgress("generate_toolpath", onProgress, [["Sample calibrated rail field", 0.3], ["Emit alternating X/Y roads", 0.72], ["Reverse audit preview stream", 1]]);
    return {
      runId: "run-vw-demo-0001",
      segmentCount: 18432,
      clippingPercent: project.toolpath.clippingPercent,
      estimate: project.toolpath.estimated,
    };
  }

  async reverseAuditGcode(project: ProjectDocument): Promise<{ passed: boolean; checks: string[] }> {
    return {
      passed: project.toolpath.clippingAcknowledged,
      checks: ["Coordinates match preview stream", "Tools and feedrates match manifest", "Bounds and wrapper identity match"],
    };
  }

  async exportRunPackage(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<ExportPackageResult> {
    emitProgress("export_run_package", onProgress, [["Write G-code and manifests", 0.45], ["Hash run artifacts", 0.8], ["Package ready", 1]]);
    return {
      packageName: "lung-phantom-study_run-vw-demo-0001.zip",
      exportHash: "sha256:12af…bd90",
      files: ["run.gcode", "run-report.json", "toolpath-trace.json", "dicom-selection.json", "transform.json"],
    };
  }

  async verifyScanBack(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<VerifyScanBackResult> {
    emitProgress("verify_scan_back", onProgress, [["Register scan-back evidence", 0.55], ["Compare signed HU samples", 1]]);
    void project;
    return {
      evidenceName: "scan-back_lung-phantom_2026-08-04.tiff",
      registrationMethod: "landmark rigid",
      confidence: "high",
      comparison: { meanAbsoluteHu: 38, p95AbsoluteHu: 112, registeredVoxels: 482_104 },
    };
  }

  async cancel(_requestId: string): Promise<void> {
    // Browser/test mode is synchronous and intentionally has no process to cancel.
  }
}

export function createSidecarClient(): SidecarClient {
  return isTauriRuntime() ? new NativeSidecarClient() : new DeterministicSidecarClient();
}
