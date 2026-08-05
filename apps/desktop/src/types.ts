export const PROJECT_SCHEMA_VERSION = 1 as const;

export type WorkspaceId = "design" | "dicom" | "calibrate" | "prepare" | "send" | "verify";
export type Orientation = "axial" | "sagittal" | "coronal";
export type SelectionKind = "single" | "range" | "tiles";
export type OutputMode = "continuous" | "tiles";
export type ComparisonMode = "overlay" | "difference" | "profile";
export type ToolId = "T0" | "T1";
export type SceneTransformMode = "translate" | "rotate" | "scale";
export type SceneAlignmentAxis = "x" | "y" | "z";
export type SceneAlignmentMode = "min" | "center" | "max";

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
  /** Explicit modeled-solid target used by the accepted tool calibration. */
  targetHu?: number;
  transform: {
    position: Vec3;
    rotation: Vec3;
    scale: Vec3;
  };
  dimensionsMm?: Vec3;
  polygonSides?: number;
  polygonPoints?: Array<{ x: number; y: number }>;
  /** Canonical imported mesh payload. Coordinates are millimetres in scene space. */
  vertices?: number[][];
  faces?: number[][];
  /** Source mesh dimensions are kept separately from transform scale. */
  sourceDimensionsMm?: Vec3;
  /** Center of the source mesh before it is normalized around the manipulation pivot. */
  sourceCenterMm?: Vec3;
  boolean?: { operation: "union" | "subtract" | "intersect"; operands: string[] };
  sourcePath?: string;
  /** User-level editing metadata. DICOM geometry is implicitly locked. */
  locked?: boolean;
  /** Non-Boolean visual grouping identifier. Group membership never changes canonical geometry. */
  groupId?: string;
  visible: boolean;
}

export interface DicomSource {
  seriesUid: string;
  name: string;
  modality: "CT";
  /** Absolute path selected by the user. Raw DICOM is never persisted in the document. */
  path?: string;
  /** One or more native inputs selected together (folder, archive, or file group). */
  inputPaths?: string[];
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
  singleThicknessMm?: number;
  tileThicknessMm?: number;
  outputDimensionsMm?: Vec3;
  sourceToPrintTransform?: number[];
  resamplingMethod?: "trilinear" | "nearest";
  calibrationId?: string;
  selectionId?: string;
  transformHash?: string;
  tileLabels?: string[];
  tilePlateColumns?: number;
  tilePlateRows?: number;
  tileOrientationMarkers?: boolean;
  tileTabs?: boolean;
  tileTabWidthMm?: number;
  tileBrimMm?: number;
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
  /** Rail pitch is independent from layer height and must be bound to evidence. */
  pitchMm?: number;
  layerHeightMm: number;
  flowMm3S?: number;
  huUncertainty?: number[];
  evidenceReference?: string;
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
    t0Grams: number | null;
    t1Grams: number | null;
    toolChanges: number;
    massStatus?: string;
  };
}

export interface SendState {
  packageExported: boolean;
  packageName?: string;
  exportHash?: string;
  packageDirectory?: string;
  files?: string[];
  connection: "local only";
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
  provenance?: {
    sourceHash: string;
    scanBackHash: string;
    translationVoxelZyx: [number, number, number];
    correlation?: number;
    huGammaPassPercent: number;
    huGammaToleranceHu: number;
    physicalFidelityStatus: string;
    warnings: string[];
    doseGamma: "not_used_hu_gamma_is_not_dose_gamma";
  };
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
  /** All selected scene ids; selectedSceneId remains the transform/inspector primary. */
  selectedSceneIds: string[];
  /** Session-local monotonic counters for generated scene identities. */
  sceneIdentityCounters?: Record<string, number>;
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
  | { type: "SET_SELECTION_RESULT"; result: DicomSelectionResult }
  | { type: "UPSERT_CALIBRATION_PROFILE"; profile: CalibrationProfile }
  | { type: "UPDATE_CALIBRATION_PROFILE"; id: string; patch: Partial<CalibrationProfile> }
  | { type: "ACCEPT_CALIBRATION_PROFILE"; id: string }
  | { type: "REVOKE_CALIBRATION_PROFILE"; id: string }
  | { type: "REVIEW_CALIBRATION"; profileId: string }
  | { type: "ACKNOWLEDGE_CLIPPING" }
  | { type: "SET_TOOLPATH_GENERATED"; runId: string; estimate: ToolpathState["estimated"]; clippingPercent?: number }
  | { type: "SET_LAYER"; layer: number }
  | { type: "GENERATE_AUDITED_GCODE" }
  | { type: "EXPORT_RUN_PACKAGE"; packageName?: string; exportHash?: string; packageDirectory?: string; files?: string[] }
  | { type: "IMPORT_SCAN_BACK"; sourcePath?: string; evidenceName?: string; result?: VerifyScanBackResult }
  | { type: "SET_COMPARISON_MODE"; mode: ComparisonMode }
  | { type: "SET_REGISTRATION"; method: VerifyState["registrationMethod"]; confidence: VerifyState["confidence"] }
  | { type: "EXPORT_REPORT"; reportPath?: string }
  | { type: "SET_SCENE_SELECTION"; id: string }
  | { type: "SET_SCENE_SELECTIONS"; ids: string[]; primaryId?: string }
  | { type: "SET_SCENE_TRANSFORM"; id: string; transform: Partial<SceneObject["transform"]> }
  | { type: "SET_SCENE_TRANSFORMS"; transforms: Array<{ id: string; transform: Partial<SceneObject["transform"]> }> }
  | { type: "SET_SCENE_DIMENSIONS"; id: string; dimensionsMm: Vec3 }
  | { type: "SET_SCENE_OWNERSHIP"; id: string; region?: SceneObject["region"]; tool?: ToolId }
  | { type: "SET_SCENE_TARGET_HU"; id: string; targetHu: number }
  | { type: "TOGGLE_SCENE_VISIBILITY"; id: string }
  | { type: "DELETE_SCENE_OBJECTS"; ids: string[] }
  | { type: "DUPLICATE_SCENE_OBJECTS"; ids: string[]; offset?: Vec3 }
  | { type: "INSERT_SCENE_OBJECTS"; objects: SceneObject[]; offset?: Vec3 }
  | { type: "GROUP_SCENE_OBJECTS"; ids: string[] }
  | { type: "UNGROUP_SCENE_OBJECTS"; ids?: string[]; groupId?: string }
  | { type: "SET_SCENE_LOCKED"; ids: string[]; locked: boolean }
  | { type: "RENAME_SCENE_OBJECT"; id: string; name: string }
  | { type: "ALIGN_SCENE_OBJECTS"; ids: string[]; axis: SceneAlignmentAxis; mode: SceneAlignmentMode; anchorId?: string }
  | { type: "RESTORE_SCENE_SNAPSHOT"; scene: SceneObject[]; selectedSceneId: string; selectedSceneIds?: string[]; message: string }
  | { type: "ADD_PRIMITIVE"; kind: SceneObject["kind"] }
  | { type: "BOOLEAN_SCENE"; operation: "union" | "subtract" | "intersect"; operandIds: string[] }
  | { type: "IMPORT_SOLID"; path: string; format: "stl" | "3mf" }
  | { type: "SET_IMPORTED_SOLID"; path: string; format: "stl" | "3mf"; vertices: number[][]; faces: number[][]; dimensionsMm: Vec3; centerMm: Vec3 }
  | { type: "HYDRATE_IMPORTED_SOLID"; id: string; vertices: number[][]; faces: number[][]; dimensionsMm: Vec3; centerMm: Vec3 }
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
  sourceToPrintTransform?: number[];
  outputDimensionsMm?: Vec3;
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
  packageDirectory?: string;
}

export interface VerifyScanBackResult {
  evidenceName: string;
  registrationMethod: VerifyState["registrationMethod"];
  confidence: VerifyState["confidence"];
  comparison: VerifyState["comparison"];
  provenance: NonNullable<VerifyState["provenance"]>;
}
