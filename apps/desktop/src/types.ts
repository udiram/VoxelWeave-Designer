export const PROJECT_SCHEMA_VERSION = 1 as const;

export type WorkspaceId = "design" | "dicom" | "calibrate" | "prepare" | "send" | "verify";
export type Orientation = "axial" | "sagittal" | "coronal";
export type SelectionKind = "single" | "range" | "tiles";
export type OutputMode = "continuous" | "tiles";
export type ComparisonMode = "overlay" | "difference" | "profile";
export type ToolId = "T0" | "T1";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Bounds3D {
  min: Vec3;
  max: Vec3;
}

export interface SceneObject {
  id: string;
  name: string;
  kind: "box" | "cylinder" | "wedge" | "polygon-prism" | "extrusion" | "dicom" | "fixture" | "group";
  region: "measurement" | "support" | "fixture";
  tool: ToolId;
  transform: {
    position: Vec3;
    rotation: Vec3;
    scale: Vec3;
  };
  dimensionsMm?: Vec3;
  polygonSides?: number;
  polygonPoints?: Array<{ x: number; y: number }>;
  boolean?: { operation: "union" | "subtract" | "intersect"; operands: string[] };
  sourcePath?: string;
  visible: boolean;
}

export interface DicomSource {
  seriesUid: string;
  name: string;
  modality: "CT";
  /** Absolute path selected by the user. Raw DICOM is never persisted in the document. */
  path?: string;
  /** Hash of the selected source metadata/files, supplied by the sidecar. */
  sourceHash?: string;
  seriesCandidates?: DicomSeriesCandidate[];
  sliceCount: number;
  dimensions: { x: number; y: number; z: number };
  spacing: Vec3;
  origin: Vec3;
  /** Direction cosine matrix (LPS rows, source x/y/z columns) from the sidecar volume header. */
  directionLps?: number[][];
  orientation: string;
  huRange: { min: number; max: number };
  status: "ready" | "needs-review";
  cache: {
    scientificSource: "full-resolution signed-HU cache";
    preview: "256³ refined";
    identity: string;
    directory?: string;
    volumePath?: string;
    previewPath?: string;
  };
}

export interface DicomSeriesCandidate {
  seriesUid: string;
  name: string;
  modality: string;
  sliceCount: number;
  dimensions?: { x: number; y: number; z: number };
  spacing?: Vec3;
  status: "eligible" | "needs-review" | "excluded";
  warnings: string[];
}

export interface CropBounds {
  x: [number, number];
  y: [number, number];
  z: [number, number];
}

export interface PrintSelection {
  orientation: Orientation;
  kind: SelectionKind;
  start: number;
  end: number;
  thicknessMm: number;
  outputMode: OutputMode;
  crop: CropBounds;
  scale: number;
  stride: number;
  tileThicknessMm?: number;
  outputDimensionsMm?: Vec3;
  sourceToPrintTransform?: number[];
  resamplingMethod?: "trilinear" | "nearest";
  calibrationId?: string;
  created: boolean;
}

export interface CalibrationProfile {
  id: string;
  name: string;
  tool: ToolId;
  material: string;
  lot: string;
  printer: string;
  scanner: string;
  reconstruction: string;
  nozzleMm: number;
  layerHeightMm: number;
  accepted: boolean;
  widthRange: [number, number];
  huSamples: Array<{ widthMm: number; measuredHu: number; targetHu: number }>;
  mismatch?: string;
}

export interface ToolpathState {
  generated: boolean;
  selectedLayer: number;
  totalLayers: number;
  clippingPercent: number;
  clippingAcknowledged: boolean;
  audited: boolean;
  runId?: string;
  estimated: {
    printTime: string;
    t0Grams: number;
    t1Grams: number;
    toolChanges: number;
  };
}

export interface SendState {
  packageExported: boolean;
  packageName?: string;
  exportHash?: string;
  connection: "local only" | "Prusa XL ready";
  printStarted: false;
}

export interface VerifyState {
  evidenceImported: boolean;
  evidenceName?: string;
  registrationMethod: "landmark rigid" | "fiducial rigid" | "not registered";
  confidence: "high" | "medium" | "low";
  comparisonMode: ComparisonMode;
  reportExported: boolean;
  comparison: {
    meanAbsoluteHu: number;
    p95AbsoluteHu?: number;
    rmseHu?: number;
    registeredVoxels: number;
  };
  sourcePath?: string;
  reportPath?: string;
}

export interface ProjectDocument {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  projectId: string;
  name: string;
  savedAt: string;
  source: DicomSource;
  scene: SceneObject[];
  selection: PrintSelection;
  calibrations: CalibrationProfile[];
  toolpath: ToolpathState;
  send: SendState;
  verify: VerifyState;
}

export interface ProjectUiState {
  workspace: WorkspaceId;
  selectedSceneId: string;
  selectedPane: Orientation | "3d";
  toast: string;
  autosaveState: "saved" | "saving" | "recovered";
  lastSavedAt: string | null;
  filePath?: string;
}

export interface ProjectState extends ProjectDocument {
  ui: ProjectUiState;
}

export type ProjectAction =
  | { type: "OPEN_SYNTHETIC_PROJECT" }
  | { type: "OPEN_PROJECT"; project: ProjectDocument; path?: string }
  | { type: "SET_PROJECT_PATH"; path?: string }
  | { type: "SET_WORKSPACE"; workspace: WorkspaceId }
  | { type: "SET_SELECTED_PANE"; pane: ProjectUiState["selectedPane"] }
  | { type: "SET_SELECTION"; patch: Partial<PrintSelection> }
  | { type: "SET_DICOM_SOURCE"; source: DicomSource }
  | { type: "CREATE_PRINT_SELECTION" }
  | { type: "UPSERT_CALIBRATION_PROFILE"; profile: CalibrationProfile }
  | { type: "UPDATE_CALIBRATION_PROFILE"; id: string; patch: Partial<CalibrationProfile> }
  | { type: "ACCEPT_CALIBRATION_PROFILE"; id: string }
  | { type: "REVOKE_CALIBRATION_PROFILE"; id: string }
  | { type: "REVIEW_CALIBRATION"; profileId: string }
  | { type: "ACKNOWLEDGE_CLIPPING" }
  | { type: "SET_TOOLPATH_GENERATED"; runId: string; estimate: ToolpathState["estimated"]; clippingPercent?: number }
  | { type: "SET_LAYER"; layer: number }
  | { type: "GENERATE_AUDITED_GCODE" }
  | { type: "EXPORT_RUN_PACKAGE"; packageName?: string; exportHash?: string }
  | { type: "IMPORT_SCAN_BACK"; sourcePath?: string; evidenceName?: string; result?: VerifyScanBackResult }
  | { type: "SET_COMPARISON_MODE"; mode: ComparisonMode }
  | { type: "SET_REGISTRATION"; method: VerifyState["registrationMethod"]; confidence: VerifyState["confidence"] }
  | { type: "EXPORT_REPORT"; reportPath?: string }
  | { type: "SET_SCENE_SELECTION"; id: string }
  | { type: "SET_SCENE_TRANSFORM"; id: string; transform: Partial<SceneObject["transform"]> }
  | { type: "SET_SCENE_DIMENSIONS"; id: string; dimensionsMm: Vec3 }
  | { type: "SET_SCENE_OWNERSHIP"; id: string; region?: SceneObject["region"]; tool?: ToolId }
  | { type: "TOGGLE_SCENE_VISIBILITY"; id: string }
  | { type: "ADD_PRIMITIVE"; kind: SceneObject["kind"] }
  | { type: "BOOLEAN_SCENE"; operation: "union" | "subtract" | "intersect"; operandIds: string[] }
  | { type: "IMPORT_SOLID"; path: string; format: "stl" | "3mf" }
  | { type: "SET_TOAST"; message: string }
  | { type: "CLEAR_TOAST" };

export interface ProgressEvent {
  requestId: string;
  stage: string;
  progress: number;
}

export interface DicomSelectionResult {
  selectionId: string;
  sourceResolution: string;
  physicalThicknessMm: number;
  transformHash: string;
}

export interface ToolpathResult {
  runId: string;
  segmentCount: number;
  clippingPercent: number;
  estimate: ToolpathState["estimated"];
}

export interface ExportPackageResult {
  packageName: string;
  exportHash: string;
  files: string[];
}

export interface VerifyScanBackResult {
  evidenceName: string;
  registrationMethod: VerifyState["registrationMethod"];
  confidence: VerifyState["confidence"];
  comparison: VerifyState["comparison"];
}
