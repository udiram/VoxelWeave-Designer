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

export interface SidecarClient {
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
}

function emitProgress(
  operation: SidecarOperation,
  onProgress: ((event: ProgressEvent) => void) | undefined,
  stages: Array<[string, number]>,
): void {
  const requestId = `synthetic-${operation}-001`;
  stages.forEach(([stage, progress]) => onProgress?.({ requestId, stage, progress }));
}

/**
 * Deterministic browser adapter. The Python sidecar can replace this object without changing UI contracts.
 */
export class DeterministicSidecarClient implements SidecarClient {
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
}
