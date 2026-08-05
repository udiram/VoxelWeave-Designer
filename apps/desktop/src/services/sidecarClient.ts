import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  DicomSelectionResult,
  DicomSource,
  ExportPackageResult,
  ProgressEvent,
  ProjectDocument,
  ToolpathResult,
  Vec3,
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
  | "verify_scan_back"
  | "cancel";

export type SidecarMode = "native" | "synthetic-browser-test";

export interface DicomInspectionResult {
  source: DicomSource;
  candidates: DicomSource["seriesCandidates"];
  warnings: string[];
}

export interface MprPlaneResult {
  plane: string;
  source: string;
  artifactPath?: string;
  sourceHash?: string;
  shapeYx?: [number, number];
  coordinateMm?: number;
  spacingMm?: [number, number];
}

export interface VolumePreviewResult {
  resolution: string;
  source: string;
  artifactPath?: string;
  sourceHash?: string;
  shapeZyx?: [number, number, number];
}

export interface SidecarClient {
  readonly mode: SidecarMode;
  inspectDicomSource(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<DicomInspectionResult>;
  selectDicomSeries(project: ProjectDocument, seriesUid?: string, onProgress?: (event: ProgressEvent) => void): Promise<DicomInspectionResult>;
  buildVolumeCache(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<{ directory?: string; volumePath?: string; previewPath?: string; sourceHash?: string; dimensions?: { x: number; y: number; z: number }; spacing?: Vec3; origin?: Vec3; directionLps?: number[][] }>;
  requestMprPlane(project: ProjectDocument, orientation?: string, onProgress?: (event: ProgressEvent) => void): Promise<MprPlaneResult>;
  requestVolumePreview(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<VolumePreviewResult>;
  sampleVoxel(project: ProjectDocument, coordinate: { x: number; y: number; z: number }): Promise<{ hu: number; coordinate: typeof coordinate }>;
  calculateHistogram(project: ProjectDocument): Promise<{ bins: number[]; source: string }>;
  createPrintSelection(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<DicomSelectionResult>;
  validateScene(project: ProjectDocument): Promise<{ valid: boolean; messages: string[] }>;
  generateToolpath(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<ToolpathResult>;
  reverseAuditGcode(project: ProjectDocument): Promise<{ passed: boolean; checks: string[] }>;
  exportRunPackage(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<ExportPackageResult>;
  verifyScanBack(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<VerifyScanBackResult>;
  exportVerificationReport(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<{ reportPath?: string; packageName: string; exportHash: string; files: string[] }>;
  cancel(requestId: string): Promise<void>;
}

type NativeEnvelope = {
  protocol: "voxelweave.control.v1";
  request_id: string;
  operation: SidecarOperation;
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
let requestSequence = 0;

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function nextRequestId(operation: string): string {
  requestSequence += 1;
  return `desktop-${operation}-${Date.now().toString(36)}-${requestSequence.toString(36)}`;
}

function emitProgress(operation: SidecarOperation, onProgress: ((event: ProgressEvent) => void) | undefined, stages: Array<[string, number]>): void {
  const requestId = `test-${operation}-${Date.now().toString(36)}`;
  stages.forEach(([stage, progress]) => onProgress?.({ requestId, stage, progress }));
}

function requireSource(project: ProjectDocument): string {
  const source = project.source.path;
  if (!source || source.startsWith("synthetic://")) {
    throw new Error("Choose a local DICOM folder before using the native sidecar.");
  }
  return source;
}

function sourcePayload(project: ProjectDocument): Record<string, unknown> {
  return { source: requireSource(project), series_uid: project.source.seriesUid || undefined };
}

function nativeCacheDirectory(project: ProjectDocument): string {
  const source = requireSource(project).replace(/[\\/]+$/, "");
  const configured = project.source.cache.directory;
  if (configured && (/^\//.test(configured) || /^[A-Za-z]:[\\/]/.test(configured))) return configured.replace(/[\\/]+$/, "");
  return `${source}/.voxelweave-cache`;
}

function nativeArtifactPath(path: unknown, directory: string): string | undefined {
  if (typeof path !== "string" || !path) return undefined;
  if (/^\//.test(path) || /^[A-Za-z]:[\\/]/.test(path)) return path;
  return `${directory}/${path.replace(/^[/\\]+/, "")}`;
}

function calibrationPayload(project: ProjectDocument): Array<Record<string, unknown>> {
  return project.calibrations.filter((profile) => profile.accepted).map((profile) => ({
    calibration_id: profile.id,
    binding: {
      pitch_mm: profile.layerHeightMm,
      layer_height_mm: profile.layerHeightMm,
      nozzle_mm: profile.nozzleMm,
      tool: profile.tool,
      material: profile.material,
      lot: profile.lot,
      printer: profile.printer,
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
      kind: object.kind,
      owner: `${object.tool}:${object.region}`,
      transform: object.transform,
      visible: object.visible,
      dimensions_mm: object.dimensionsMm,
      source_path: object.kind === "dicom" && (!object.sourcePath || object.sourcePath.startsWith("synthetic://")) ? project.source.path : object.sourcePath,
      boolean_operands: object.boolean?.operands ?? [],
      boolean_operation: object.boolean?.operation,
    })),
  };
}

function nativeError(response: NativeResponse<unknown>): Error {
  const detail = response.error ?? { code: "UnknownSidecarError", message: "The sidecar returned an invalid error." };
  return new Error(`${detail.code}: ${detail.message}`);
}

function sourceFromInspection(project: ProjectDocument, inspection: Record<string, unknown>): DicomInspectionResult {
  const series = Array.isArray(inspection.series) ? inspection.series as Array<Record<string, unknown>> : [];
  const eligible = series.find((candidate) => candidate.eligible !== false);
  const spacing = (eligible?.spacing as Record<string, unknown> | undefined) ?? {};
  const dimensions = (eligible?.dimensions as Record<string, unknown> | undefined) ?? {};
  const source: DicomSource = {
    ...project.source,
    path: project.source.path,
    name: String(inspection.source_label ?? project.source.name),
    seriesUid: String(eligible?.series_uid ?? project.source.seriesUid),
    modality: "CT",
    sliceCount: Number(eligible?.instance_count ?? project.source.sliceCount),
    dimensions: {
      x: Number(dimensions.x ?? project.source.dimensions.x),
      y: Number(dimensions.y ?? project.source.dimensions.y),
      z: Number(dimensions.z ?? eligible?.instance_count ?? project.source.dimensions.z),
    },
    spacing: {
      x: Number(spacing.x ?? project.source.spacing.x),
      y: Number(spacing.y ?? project.source.spacing.y),
      z: Number(spacing.z ?? project.source.spacing.z),
    },
    status: eligible?.eligible === false ? "needs-review" : "ready",
    seriesCandidates: series.map((candidate) => ({
      seriesUid: String(candidate.series_uid ?? ""),
      name: String(candidate.modality ?? "CT"),
      modality: String(candidate.modality ?? ""),
      sliceCount: Number(candidate.instance_count ?? 0),
      status: candidate.eligible === false ? "excluded" : "eligible",
      warnings: candidate.exclusion_reason ? [String(candidate.exclusion_reason)] : [],
    })),
  };
  return { source, candidates: source.seriesCandidates, warnings: Array.isArray(inspection.warnings) ? inspection.warnings.map(String) : [] };
}

/** Native adapter. Every production operation crosses the Tauri JSONL boundary. */
export class NativeSidecarClient implements SidecarClient {
  readonly mode = "native" as const;
  private inspectedPath?: string;
  private selectedPath?: string;

  private async request<T>(operation: SidecarOperation, payload: Record<string, unknown>, onProgress?: (event: ProgressEvent) => void): Promise<T> {
    const requestId = nextRequestId(operation);
    const envelope: NativeEnvelope = { protocol: "voxelweave.control.v1", request_id: requestId, operation, payload };
    const unlisten = await listen<NativeProgress>(NATIVE_PROGRESS_EVENT, (event) => {
      if (event.payload.request_id !== requestId) return;
      onProgress?.({ requestId, stage: event.payload.stage, progress: event.payload.fraction });
    });
    try {
      const response = await invoke<NativeResponse<T>>("sidecar_request", { request: envelope });
      if (!response.ok) throw nativeError(response);
      return response.payload as T;
    } finally {
      unlisten();
    }
  }

  private async ensureSelected(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<void> {
    const source = requireSource(project);
    if (this.inspectedPath !== source) {
      await this.inspectDicomSource(project, onProgress);
    }
    if (this.selectedPath !== source) {
      await this.selectDicomSeries(project, project.source.seriesUid || undefined, onProgress);
    }
  }

  async inspectDicomSource(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<DicomInspectionResult> {
    const source = requireSource(project);
    const inspection = await this.request<Record<string, unknown>>("inspect_dicom_source", { source }, onProgress);
    this.inspectedPath = source;
    return sourceFromInspection(project, inspection);
  }

  async selectDicomSeries(project: ProjectDocument, seriesUid?: string, onProgress?: (event: ProgressEvent) => void): Promise<DicomInspectionResult> {
    const source = requireSource(project);
    const selected = await this.request<Record<string, unknown>>("select_dicom_series", { source, series_uid: (seriesUid ?? project.source.seriesUid) || undefined }, onProgress);
    this.selectedPath = source;
    return sourceFromInspection(project, { source_label: project.source.name, series: [selected] });
  }

  async buildVolumeCache(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<{ directory?: string; volumePath?: string; previewPath?: string; sourceHash?: string; dimensions?: { x: number; y: number; z: number }; spacing?: Vec3; origin?: Vec3; directionLps?: number[][] }> {
    await this.ensureSelected(project, onProgress);
    const directory = nativeCacheDirectory(project);
    const result = await this.request<Record<string, unknown>>("build_volume_cache", { directory }, onProgress);
    const scientific = result.scientific_source as Record<string, unknown> | undefined;
    const header = scientific?.header as Record<string, unknown> | undefined;
    const shape = Array.isArray(header?.shape) ? header.shape.map(Number) : [];
    const spacingDyz = Array.isArray(header?.spacing_mm_dyx) ? header.spacing_mm_dyx.map(Number) : [];
    const originLps = Array.isArray(header?.origin_lps) ? header.origin_lps.map(Number) : [];
    const previews = Array.isArray(result.previews) ? result.previews as Array<Record<string, unknown>> : [];
    return {
      directory,
      volumePath: nativeArtifactPath(scientific?.path, directory),
      previewPath: nativeArtifactPath(previews[0]?.path, directory),
      sourceHash: typeof header?.source_hash === "string" ? header.source_hash : undefined,
      dimensions: shape.length === 3 ? { x: shape[2], y: shape[1], z: shape[0] } : undefined,
      spacing: spacingDyz.length === 3 ? { x: spacingDyz[2], y: spacingDyz[1], z: spacingDyz[0] } : undefined,
      origin: originLps.length === 3 ? { x: originLps[0], y: originLps[1], z: originLps[2] } : undefined,
      directionLps: Array.isArray(header?.direction_lps) ? (header.direction_lps as unknown[]).map((row) => Array.isArray(row) ? row.map(Number) : []) : undefined,
    };
  }

  async requestMprPlane(project: ProjectDocument, orientation = project.selection.orientation, onProgress?: (event: ProgressEvent) => void): Promise<MprPlaneResult> {
    await this.ensureSelected(project, onProgress);
    const outputShape: [number, number] = orientation === "axial"
      ? [project.source.dimensions.y, project.source.dimensions.x]
      : orientation === "sagittal" ? [project.source.dimensions.z, project.source.dimensions.y] : [project.source.dimensions.z, project.source.dimensions.x];
    const result = await this.request<Record<string, unknown>>("request_mpr_plane", {
      ...sourcePayload(project),
      plane: orientation,
      index: orientation === project.selection.orientation ? project.selection.start : undefined,
      coordinate_mm: orientation === project.selection.orientation
        ? project.selection.start * (orientation === "axial" ? project.source.spacing.z : orientation === "sagittal" ? project.source.spacing.x : project.source.spacing.y)
        : undefined,
      output_shape_yx: outputShape,
      method: project.selection.resamplingMethod === "nearest" ? "nearest" : "linear",
      output_path: `${nativeCacheDirectory(project)}/mpr-${orientation}.bin`,
    }, onProgress);
    const plane = (result.plane as Record<string, unknown> | undefined) ?? result;
    const artifact = result.artifact as Record<string, unknown> | undefined;
    const directory = nativeCacheDirectory(project);
    return { plane: String(plane.plane ?? orientation), source: "full-resolution signed-HU cache", sourceHash: String(plane.source_hash ?? ""), artifactPath: nativeArtifactPath(artifact?.path, directory), shapeYx: Array.isArray(plane.shape_yx) ? [Number(plane.shape_yx[0]), Number(plane.shape_yx[1])] : outputShape, coordinateMm: Number(plane.coordinate_mm ?? 0), spacingMm: Array.isArray(plane.spacing_mm) ? [Number(plane.spacing_mm[0]), Number(plane.spacing_mm[1])] : undefined };
  }

  async requestVolumePreview(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<VolumePreviewResult> {
    await this.ensureSelected(project, onProgress);
    const directory = nativeCacheDirectory(project);
    const result = await this.request<Record<string, unknown>>("request_volume_preview", { ...sourcePayload(project), max_dimension: 128, output_path: `${directory}/volume-preview.bin` }, onProgress);
    const preview = (result.preview as Record<string, unknown> | undefined) ?? result;
    const artifact = result.artifact as Record<string, unknown> | undefined;
    return { resolution: Array.isArray(preview.shape_zyx) ? preview.shape_zyx.map(Number).join(" × ") : project.source.cache.preview, source: "preview texture only", sourceHash: String(preview.source_hash ?? ""), artifactPath: nativeArtifactPath(artifact?.path, directory), shapeZyx: Array.isArray(preview.shape_zyx) ? [Number(preview.shape_zyx[0]), Number(preview.shape_zyx[1]), Number(preview.shape_zyx[2])] : undefined };
  }

  async sampleVoxel(project: ProjectDocument, coordinate: { x: number; y: number; z: number }): Promise<{ hu: number; coordinate: typeof coordinate }> {
    await this.ensureSelected(project);
    const result = await this.request<{ hu: number }>("sample_voxel", { position_lps: [coordinate.x, coordinate.y, coordinate.z], method: project.selection.resamplingMethod === "nearest" ? "nearest" : "linear" });
    return { hu: result.hu, coordinate };
  }

  async calculateHistogram(project: ProjectDocument): Promise<{ bins: number[]; source: string }> {
    await this.ensureSelected(project);
    const result = await this.request<{ counts: number[] }>("calculate_histogram", { bins: 256 });
    return { bins: result.counts, source: "full-resolution signed-HU cache" };
  }

  async createPrintSelection(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<DicomSelectionResult> {
    await this.ensureSelected(project, onProgress);
    const mode = project.selection.kind === "single" ? "single" : project.selection.outputMode === "tiles" || project.selection.kind === "tiles" ? "tile" : "continuous";
    const calibration = project.calibrations.find((profile) => profile.id === project.selection.calibrationId) ?? project.calibrations.find((profile) => profile.accepted);
    const result = await this.request<Record<string, unknown>>("create_print_selection", {
      ...sourcePayload(project),
      plane: project.selection.orientation,
      mode,
      plane_index: mode === "single" ? project.selection.start : undefined,
      start_index: project.selection.start,
      end_index: project.selection.end,
      crop_min_lps: [project.selection.crop.x[0], project.selection.crop.y[0], project.selection.crop.z[0]],
      crop_max_lps: [project.selection.crop.x[1], project.selection.crop.y[1], project.selection.crop.z[1]],
      thickness_mm: mode === "single" ? (project.selection.tileThicknessMm ?? project.selection.thicknessMm) : project.selection.thicknessMm,
      print_size_mm: project.selection.outputDimensionsMm ? [project.selection.outputDimensionsMm.x, project.selection.outputDimensionsMm.y, project.selection.outputDimensionsMm.z] : undefined,
      layer_height_mm: calibration?.layerHeightMm ?? 0.2,
      stride: project.selection.stride,
      resampling: project.selection.resamplingMethod ?? "trilinear",
      plate_layout: mode === "tile" ? { tile_spacing_mm: [2, 2] } : {},
      structural_regions: scenePayload(project).regions,
    }, onProgress);
    const printSize = Array.isArray(result.print_size_mm) ? result.print_size_mm.map(Number) : [];
    return { selectionId: `native-${String(result.source_hash ?? "selection").slice(0, 12)}`, sourceResolution: `${project.source.dimensions.x} × ${project.source.dimensions.y} × ${project.source.dimensions.z}`, physicalThicknessMm: Number(printSize[2] ?? project.selection.thicknessMm), transformHash: `sha256:${String(result.source_hash ?? "unknown")}` };
  }

  async validateScene(project: ProjectDocument): Promise<{ valid: boolean; messages: string[] }> {
    const result = await this.request<{ passed: boolean; errors: string[]; warnings: string[] }>("validate_scene", { scene: scenePayload(project) });
    return { valid: result.passed, messages: [...result.errors, ...result.warnings] };
  }

  async generateToolpath(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<ToolpathResult> {
    await this.ensureSelected(project, onProgress);
    const result = await this.request<{ segment_count?: number; gcode_sha256?: string; clipping_percent?: number; estimated?: ToolpathResult["estimate"] }>("generate_toolpath", {
      calibration: calibrationPayload(project),
      selection: project.selection,
      scene: scenePayload(project),
      tool: undefined,
      allow_calibration_clipping: project.toolpath.clippingAcknowledged,
      acknowledge_calibration_clipping: project.toolpath.clippingAcknowledged,
      profile: { printer: project.calibrations.find((profile) => profile.accepted)?.printer ?? "Prusa XL", sample_step_mm: project.source.spacing.x },
    }, onProgress);
    return { runId: `native-${String(result.gcode_sha256 ?? "run").slice(0, 12)}`, segmentCount: Number(result.segment_count ?? 0), clippingPercent: Number(result.clipping_percent ?? project.toolpath.clippingPercent), estimate: result.estimated ?? project.toolpath.estimated };
  }

  async reverseAuditGcode(project: ProjectDocument): Promise<{ passed: boolean; checks: string[] }> {
    const result = await this.request<{ passed: boolean; errors: string[]; warnings: string[] }>("reverse_audit_gcode", { run_id: project.toolpath.runId });
    return { passed: result.passed, checks: [...result.errors, ...result.warnings] };
  }

  async exportRunPackage(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<ExportPackageResult> {
    const result = await this.request<{ files: string[]; hashes: Record<string, string>; package_name?: string }>("export_run_package", { directory: `${nativeCacheDirectory(project)}/run-package`, run_id: project.toolpath.runId }, onProgress);
    return { packageName: result.package_name ?? "voxelweave-run-package.zip", exportHash: `sha256:${result.hashes?.["hashes.json"] ?? "unknown"}`, files: result.files ?? [] };
  }

  async verifyScanBack(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<VerifyScanBackResult> {
    await this.ensureSelected(project, onProgress);
    const source = project.verify.sourcePath;
    if (!source || source.startsWith("synthetic://")) throw new Error("Choose a local scan-back folder before verification.");
    const result = await this.request<{ registration_method: string; registration_confidence: number; mae_hu: number; rmse_hu: number; p95_abs_hu?: number; p95_absolute_error_hu?: number; compared_voxel_count: number }>("verify_scan_back", { scan_back_source: source, registration_method: project.verify.registrationMethod === "fiducial rigid" ? "geometry_only" : project.verify.registrationMethod === "landmark rigid" ? "manual_translation" : "identity", registration_confidence: project.verify.confidence === "high" ? 1 : project.verify.confidence === "medium" ? 0.7 : 0.3, hu_gamma_tolerance_hu: 40, expected_source_hash: project.source.sourceHash }, onProgress);
    return { evidenceName: source.split(/[\\/]/).pop() ?? "scan-back", registrationMethod: project.verify.registrationMethod, confidence: result.registration_confidence >= 0.9 ? "high" : result.registration_confidence >= 0.5 ? "medium" : "low", comparison: { meanAbsoluteHu: result.mae_hu, rmseHu: result.rmse_hu, p95AbsoluteHu: result.p95_abs_hu ?? result.p95_absolute_error_hu, registeredVoxels: result.compared_voxel_count } };
  }

  async exportVerificationReport(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<{ reportPath?: string; packageName: string; exportHash: string; files: string[] }> {
    const directory = `${nativeCacheDirectory(project)}/verification-report`;
    const result = await this.request<{ files: string[]; hashes: Record<string, string>; report_path?: string; package_name?: string }>("export_run_package", { directory, run_id: project.toolpath.runId, include_verification_report: true, verification: project.verify }, onProgress);
    return { reportPath: nativeArtifactPath(result.report_path, directory), packageName: result.package_name ?? "voxelweave-verification-report.zip", exportHash: `sha256:${result.hashes?.["hashes.json"] ?? "unknown"}`, files: result.files ?? [] };
  }

  async cancel(requestId: string): Promise<void> {
    const response = await invoke<NativeResponse<{ cancelled: boolean }>>("sidecar_request", { request: { protocol: "voxelweave.control.v1", request_id: nextRequestId("cancel"), operation: "cancel", payload: { request_id: requestId } } });
    if (!response.ok) throw nativeError(response);
  }
}

/** Browser/test adapter. It is explicit, deterministic, and never used by native mode. */
export class DeterministicSidecarClient implements SidecarClient {
  readonly mode = "synthetic-browser-test" as const;

  async inspectDicomSource(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<DicomInspectionResult> {
    emitProgress("inspect_dicom_source", onProgress, [["Read series metadata", 0.4], ["Validate physical coordinates", 1]]);
    return { source: project.source, candidates: project.source.seriesCandidates, warnings: [] };
  }
  async selectDicomSeries(project: ProjectDocument, _seriesUid?: string, onProgress?: (event: ProgressEvent) => void): Promise<DicomInspectionResult> {
    emitProgress("select_dicom_series", onProgress, [["Group SeriesInstanceUID", 0.4], ["Sort by ImagePositionPatient", 1]]);
    return { source: project.source, candidates: project.source.seriesCandidates, warnings: [] };
  }
  async buildVolumeCache(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<{ directory?: string; volumePath?: string; previewPath?: string }> { emitProgress("build_volume_cache", onProgress, [["Decode signed HU planes", 0.25], ["Build preview pyramid", 0.7], ["Cache ready", 1]]); return { directory: project.source.cache.directory }; }
  async requestMprPlane(project: ProjectDocument, orientation = project.selection.orientation, onProgress?: (event: ProgressEvent) => void): Promise<MprPlaneResult> { emitProgress("request_mpr_plane", onProgress, [["Read cached plane", 1]]); return { plane: orientation, source: project.source.cache.scientificSource, shapeYx: [orientation === "axial" ? project.source.dimensions.y : project.source.dimensions.z, orientation === "coronal" ? project.source.dimensions.x : project.source.dimensions.y] }; }
  async requestVolumePreview(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<VolumePreviewResult> { emitProgress("request_volume_preview", onProgress, [["Refine preview volume", 1]]); return { resolution: project.source.cache.preview, source: "preview texture only", shapeZyx: [64, 64, 64] }; }
  async sampleVoxel(_project: ProjectDocument, coordinate: { x: number; y: number; z: number }): Promise<{ hu: number; coordinate: typeof coordinate }> { return { hu: Math.round(-782 + coordinate.x * 0.4 + coordinate.y * 0.18 + coordinate.z * 0.6), coordinate }; }
  async calculateHistogram(project: ProjectDocument): Promise<{ bins: number[]; source: string }> { return { bins: [-990, -820, -740, -410, 30, 1200], source: project.source.cache.scientificSource }; }
  async createPrintSelection(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<DicomSelectionResult> { emitProgress("create_print_selection", onProgress, [["Lock physical crop", 0.35], ["Build source-to-print transform", 1]]); return { selectionId: `${project.projectId}-selection-001`, sourceResolution: `${project.source.dimensions.x} × ${project.source.dimensions.y} × ${project.source.dimensions.z}`, physicalThicknessMm: project.selection.thicknessMm, transformHash: "sha256:test-selection" }; }
  async validateScene(project: ProjectDocument): Promise<{ valid: boolean; messages: string[] }> { return { valid: project.scene.some((object) => object.visible), messages: ["Controlled test adapter scene validation", "Tool ownership resolved"] }; }
  async generateToolpath(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<ToolpathResult> { emitProgress("generate_toolpath", onProgress, [["Sample calibrated rail field", 0.3], ["Emit alternating roads", 0.72], ["Preview ready", 1]]); return { runId: "run-test-adapter", segmentCount: 18432, clippingPercent: project.toolpath.clippingPercent, estimate: project.toolpath.estimated }; }
  async reverseAuditGcode(project: ProjectDocument): Promise<{ passed: boolean; checks: string[] }> { return { passed: project.toolpath.clippingAcknowledged, checks: ["Controlled adapter coordinates match", "Tools and feedrates match", "Bounds match"] }; }
  async exportRunPackage(_project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<ExportPackageResult> { emitProgress("export_run_package", onProgress, [["Write G-code and manifests", 0.45], ["Hash run artifacts", 0.8], ["Package ready", 1]]); return { packageName: "lung-phantom-study_run-vw-demo-0001.zip", exportHash: "sha256:test-package", files: ["run.gcode", "run-report.json", "toolpath-trace.json", "dicom-selection.json", "transform.json"] }; }
  async verifyScanBack(project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<VerifyScanBackResult> { emitProgress("verify_scan_back", onProgress, [["Register scan-back evidence", 0.55], ["Compare signed HU samples", 1]]); return { evidenceName: project.verify.sourcePath?.split(/[\\/]/).pop() ?? "scan-back_lung-phantom_2026-08-04.tiff", registrationMethod: "landmark rigid", confidence: "high", comparison: { meanAbsoluteHu: 38, rmseHu: 64, p95AbsoluteHu: 112, registeredVoxels: 482_104 } }; }
  async exportVerificationReport(_project: ProjectDocument, onProgress?: (event: ProgressEvent) => void): Promise<{ reportPath?: string; packageName: string; exportHash: string; files: string[] }> { emitProgress("export_run_package", onProgress, [["Write verification report", 0.5], ["Hash report artifacts", 1]]); return { packageName: "test-adapter-verification-report.zip", exportHash: "sha256:test-report", files: ["verification-report.json", "provenance.json"] }; }
  async cancel(_requestId: string): Promise<void> { /* synchronous adapter */ }
}

export function createSidecarClient(): SidecarClient { return isTauriRuntime() ? new NativeSidecarClient() : new DeterministicSidecarClient(); }
