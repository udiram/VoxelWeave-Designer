import { syntheticProjectDocument } from "../data/fixtures";
import type { CalibrationProfile, CropBounds, DicomSource, ProjectAction, ProjectState, ProjectUiState, Vec3 } from "../types";

const requiredCalibrationFields: Array<keyof Pick<CalibrationProfile, "name" | "material" | "lot" | "printer" | "scanner" | "reconstruction">> = ["name", "material", "lot", "printer", "scanner", "reconstruction"];

function sourcePlaneMaxIndex(source: DicomSource, orientation: ProjectState["selection"]["orientation"]): number {
  const dimension = orientation === "axial" ? source.dimensions.z : orientation === "sagittal" ? source.dimensions.x : source.dimensions.y;
  return Math.max(0, dimension - 1);
}

function sourceAxisSpacing(source: DicomSource, axis: number): number {
  return axis === 0 ? source.spacing.x : axis === 1 ? source.spacing.y : source.spacing.z;
}

function orientationAxes(orientation: ProjectState["selection"]["orientation"]): [number, number, number] {
  if (orientation === "axial") return [0, 1, 2];
  if (orientation === "sagittal") return [1, 2, 0];
  return [0, 2, 1];
}

export function selectionOutputDimensions(source: DicomSource, selection: ProjectState["selection"]): Vec3 {
  const direction = source.directionLps && source.directionLps.length === 3 && source.directionLps.every((row) => row.length === 3)
    ? source.directionLps
    : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const dimensions = [source.dimensions.x, source.dimensions.y, source.dimensions.z];
  if (dimensions.some((value) => value <= 0) || [source.spacing.x, source.spacing.y, source.spacing.z].some((value) => value <= 0)) return { x: 0, y: 0, z: 0 };
  const cropCorners = [0, 1].flatMap((x) => [0, 1].flatMap((y) => [0, 1].map((z) => [selection.crop.x[x], selection.crop.y[y], selection.crop.z[z]])));
  const voxelCorners = cropCorners.map((corner) => {
    const delta = [corner[0] - source.origin.x, corner[1] - source.origin.y, corner[2] - source.origin.z];
    return [0, 1, 2].map((axis) => {
      const localMm = direction[0][axis] * delta[0] + direction[1][axis] * delta[1] + direction[2][axis] * delta[2];
      return Math.max(0, Math.min(dimensions[axis] - 1, localMm / sourceAxisSpacing(source, axis)));
    });
  });
  const low = [0, 1, 2].map((axis) => Math.min(...voxelCorners.map((corner) => corner[axis])));
  const high = [0, 1, 2].map((axis) => Math.max(...voxelCorners.map((corner) => corner[axis])));
  const [printX, printY, normal] = orientationAxes(selection.orientation);
  const scale = Number.isFinite(selection.scale) && selection.scale > 0 ? selection.scale : 1;
  const inPlaneSize = (axis: number) => (high[axis] - low[axis] + 1) * sourceAxisSpacing(source, axis) * scale;
  const boundedStart = Math.max(0, Math.min(selection.start, dimensions[normal] - 1));
  const boundedEnd = Math.max(boundedStart, Math.min(selection.end, dimensions[normal] - 1));
  const inclusiveDepth = (boundedEnd - boundedStart + 1) * sourceAxisSpacing(source, normal);
  const configuredThickness = selection.kind === "single"
    ? selection.singleThicknessMm && selection.singleThicknessMm > 0 ? selection.singleThicknessMm : sourceAxisSpacing(source, normal)
    : selection.tileThicknessMm && selection.tileThicknessMm > 0 ? selection.tileThicknessMm : sourceAxisSpacing(source, normal);
  const outputDepth = selection.outputMode === "tiles" || selection.kind === "tiles" || selection.kind === "single" ? configuredThickness : inclusiveDepth * scale;
  return {
    x: Number(inPlaneSize(printX).toFixed(3)),
    y: Number(inPlaneSize(printY).toFixed(3)),
    z: Number(outputDepth.toFixed(3)),
  };
}

export function validateCalibrationProfile(profile: CalibrationProfile): string[] {
  const errors: string[] = [];
  requiredCalibrationFields.forEach((field) => {
    if (!profile[field].trim()) errors.push(`${field} is required`);
  });
  if (profile.tool !== "T0" && profile.tool !== "T1") errors.push("tool binding is invalid");
  if (!Number.isFinite(profile.nozzleMm) || profile.nozzleMm <= 0) errors.push("nozzle must be greater than 0 mm");
  if (!Number.isFinite(profile.pitchMm) || (profile.pitchMm ?? 0) <= 0) errors.push("pitch must be greater than 0 mm and independently bound");
  if (!Number.isFinite(profile.layerHeightMm) || profile.layerHeightMm <= 0) errors.push("layer height must be greater than 0 mm");
  if (!Number.isFinite(profile.flowMm3S) || (profile.flowMm3S ?? 0) <= 0) errors.push("flow must be greater than 0 mm³/s and evidence-bound");
  const [minimum, maximum] = profile.widthRange;
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum < 0 || maximum <= minimum) errors.push("width range must be finite and increasing");
  if (profile.huSamples.length < 2) errors.push("at least two HU samples are required");
  let previousWidth = Number.NEGATIVE_INFINITY;
  profile.huSamples.forEach((sample, index) => {
    if (!Number.isFinite(sample.widthMm) || sample.widthMm <= previousWidth) errors.push(`HU sample ${index + 1} widths must be strictly increasing`);
    if (sample.widthMm < minimum || sample.widthMm > maximum) errors.push(`HU sample ${index + 1} is outside the accepted width range`);
    if (!Number.isFinite(sample.measuredHu) || !Number.isFinite(sample.targetHu)) errors.push(`HU sample ${index + 1} must contain finite values`);
    previousWidth = sample.widthMm;
  });
  return [...new Set(errors)];
}

function profileWithValidation(profile: CalibrationProfile, accepted: boolean): CalibrationProfile {
  const errors = validateCalibrationProfile(profile);
  return { ...profile, accepted, mismatch: errors.length ? errors.join("; ") : undefined };
}

export function sourcePhysicalBounds(source: DicomSource): CropBounds {
  const extent = {
    x: Math.max(0, source.dimensions.x - 1) * source.spacing.x,
    y: Math.max(0, source.dimensions.y - 1) * source.spacing.y,
    z: Math.max(0, source.dimensions.z - 1) * source.spacing.z,
  };
  const direction = source.directionLps && source.directionLps.length === 3 && source.directionLps.every((row) => row.length === 3)
    ? source.directionLps
    : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const corners = [0, 1].flatMap((x) => [0, 1].flatMap((y) => [0, 1].map((z) => {
    const local = [x * extent.x, y * extent.y, z * extent.z];
    return [0, 1, 2].map((row) => source.origin[(["x", "y", "z"] as const)[row]] + direction[row][0] * local[0] + direction[row][1] * local[1] + direction[row][2] * local[2]);
  })));
  return {
    x: [Math.min(...corners.map((corner) => corner[0])), Math.max(...corners.map((corner) => corner[0]))],
    y: [Math.min(...corners.map((corner) => corner[1])), Math.max(...corners.map((corner) => corner[1]))],
    z: [Math.min(...corners.map((corner) => corner[2])), Math.max(...corners.map((corner) => corner[2]))],
  };
}

export function createInitialProjectState(recovered = false): ProjectState {
  const ui: ProjectUiState = {
    workspace: "design",
    selectedSceneId: "scene-reference-box",
    selectedPane: "axial",
    toast: recovered ? "Recovered the latest local project snapshot" : "Create or open a .voxelweave project to begin",
    autosaveState: recovered ? "recovered" : "saved",
    lastSavedAt: recovered ? new Date().toISOString() : syntheticProjectDocument.savedAt,
  };
  return { ...structuredClone(syntheticProjectDocument), ui };
}

function invalidateDerivedRun(state: ProjectState): Pick<ProjectState, "toolpath" | "send" | "verify"> {
  return {
    toolpath: {
      ...state.toolpath,
      generated: false,
      audited: false,
      runId: undefined,
      totalLayers: 0,
      selectedLayer: 0,
      clippingPercent: 0,
      clippingAcknowledged: false,
      estimated: { printTime: "Unavailable", t0Grams: null, t1Grams: null, toolChanges: 0 },
    },
    send: { packageExported: false, connection: "local only", printStarted: false },
    verify: {
      evidenceImported: false,
      registrationMethod: "not registered",
      confidence: "low",
      comparisonMode: state.verify.comparisonMode,
      reportExported: false,
      comparison: { meanAbsoluteHu: 0, p95AbsoluteHu: 0, registeredVoxels: 0 },
    },
  };
}

function validVector(value: Vec3, positive = false): boolean {
  return [value.x, value.y, value.z].every((item) => Number.isFinite(item) && (!positive || item > 0));
}

function rejectedTransform(state: ProjectState, message: string): ProjectState {
  return { ...state, ui: { ...state.ui, toast: message } };
}

export function projectReducer(state: ProjectState, action: ProjectAction): ProjectState {
  switch (action.type) {
    case "OPEN_SYNTHETIC_PROJECT":
      return {
        ...createInitialProjectState(),
        ui: { ...createInitialProjectState().ui, toast: "Opened deterministic browser test fixture" },
      };
    case "OPEN_PROJECT":
      return {
        ...structuredClone(action.project),
        toolpath: {
          ...action.project.toolpath,
          generated: false,
          audited: false,
          runId: undefined,
          clippingPercent: 0,
          clippingAcknowledged: false,
          estimated: { printTime: "Not generated", t0Grams: null, t1Grams: null, toolChanges: 0 },
        },
        send: { packageExported: false, connection: "local only", printStarted: false },
        verify: {
          evidenceImported: false,
          registrationMethod: "not registered",
          confidence: "low",
          comparisonMode: action.project.verify.comparisonMode,
          reportExported: false,
          comparison: { meanAbsoluteHu: 0, p95AbsoluteHu: 0, registeredVoxels: 0 },
        },
        ui: {
          ...createInitialProjectState().ui,
          filePath: action.path,
          selectedSceneId: action.project.scene.find((object) => object.kind !== "dicom" && object.visible)?.id ?? action.project.scene[0]?.id ?? "",
          toast: action.path ? `Opened ${action.path.split(/[\\/]/).pop()} · regenerate to restore runtime evidence` : "Opened project · regenerate to restore runtime evidence",
          autosaveState: "saved",
          lastSavedAt: action.project.savedAt,
        },
      };
    case "SET_PROJECT_PATH":
      return { ...state, ui: { ...state.ui, filePath: action.path, toast: action.path ? `Project path set to ${action.path}` : "Project path cleared" } };
    case "SET_WORKSPACE":
      return { ...state, ui: { ...state.ui, workspace: action.workspace, toast: "" } };
    case "SET_SELECTED_PANE":
      return { ...state, ui: { ...state.ui, selectedPane: action.pane } };
    case "SET_SELECTION": {
      const selection = { ...state.selection, ...action.patch };
      const spacing = selection.orientation === "axial" ? state.source.spacing.z : selection.orientation === "sagittal" ? state.source.spacing.x : state.source.spacing.y;
      const maxIndex = sourcePlaneMaxIndex(state.source, selection.orientation);
      const boundedStart = Math.max(0, Math.min(selection.start, maxIndex));
      const boundedEnd = Math.max(boundedStart, Math.min(selection.end, maxIndex));
      const normalized = { ...selection, start: boundedStart, end: boundedEnd, stride: Math.max(1, selection.stride), thicknessMm: Number(((boundedEnd - boundedStart + 1) * spacing).toFixed(3)) };
      return { ...state, ...invalidateDerivedRun(state), selection: { ...normalized, created: false, outputDimensionsMm: selectionOutputDimensions(state.source, normalized) } };
    }
    case "SET_DICOM_SOURCE": {
      const source = action.source;
      const max = sourcePlaneMaxIndex(source, state.selection.orientation);
      const end = Math.min(state.selection.end, max);
      const start = Math.min(state.selection.start, end);
      const spacing = state.selection.orientation === "axial" ? source.spacing.z : state.selection.orientation === "sagittal" ? source.spacing.x : source.spacing.y;
      const physicalBounds = sourcePhysicalBounds(source);
      const existingDicom = state.scene.find((object) => object.kind === "dicom" && object.sourcePath === source.path);
      const nonDicomScene = state.scene.filter((object) => object.kind !== "dicom");
      const sourceCenter = {
        x: (physicalBounds.x[0] + physicalBounds.x[1]) / 2,
        y: (physicalBounds.y[0] + physicalBounds.y[1]) / 2,
        z: (physicalBounds.z[0] + physicalBounds.z[1]) / 2,
      };
      const scene = !source.path ? nonDicomScene : [...nonDicomScene, {
        ...existingDicom,
        id: "scene-dicom-source",
        name: source.name,
        kind: "dicom" as const,
        region: "measurement" as const,
        tool: existingDicom?.tool ?? "T0" as const,
        sourcePath: source.path,
        dimensionsMm: { x: Math.max(0, source.dimensions.x - 1) * source.spacing.x, y: Math.max(0, source.dimensions.y - 1) * source.spacing.y, z: Math.max(0, source.dimensions.z - 1) * source.spacing.z },
        transform: { position: sourceCenter, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        visible: existingDicom?.visible ?? true,
      }];
      const selection = {
        ...state.selection,
        start,
        end,
        thicknessMm: Number(((end - start + 1) * spacing).toFixed(3)),
        crop: physicalBounds,
        created: false,
      };
      return {
        ...state,
        ...invalidateDerivedRun(state),
        source,
        scene,
        selection: { ...selection, outputDimensionsMm: selectionOutputDimensions(source, selection) },
        ui: { ...state.ui, selectedSceneId: scene.find((object) => object.kind === "dicom")?.id ?? scene[0]?.id ?? state.ui.selectedSceneId, toast: `Loaded ${source.name} · ${source.sliceCount} slices` },
      };
    }
    case "CREATE_PRINT_SELECTION":
      return {
        ...state,
        ...invalidateDerivedRun(state),
        selection: { ...state.selection, created: true },
        ui: { ...state.ui, toast: "Print selection created from physical coordinates" },
      };
    case "SET_SELECTION_RESULT":
      return {
        ...state,
        ...invalidateDerivedRun(state),
        selection: {
          ...state.selection,
          created: true,
          selectionId: action.result.selectionId,
          transformHash: action.result.transformHash,
          sourceToPrintTransform: action.result.sourceToPrintTransform ?? state.selection.sourceToPrintTransform,
          outputDimensionsMm: action.result.outputDimensionsMm ?? state.selection.outputDimensionsMm,
        },
        ui: { ...state.ui, toast: `Print selection created · ${action.result.selectionId}` },
      };
    case "UPSERT_CALIBRATION_PROFILE": {
      const profile = profileWithValidation(action.profile, false);
      const existing = state.calibrations.some((candidate) => candidate.id === profile.id);
      return {
        ...state,
        ...invalidateDerivedRun(state),
        calibrations: existing ? state.calibrations.map((candidate) => candidate.id === profile.id ? profile : candidate) : [...state.calibrations, profile],
        selection: state.selection.calibrationId === profile.id ? { ...state.selection, calibrationId: profile.id } : state.selection,
        ui: { ...state.ui, toast: profile.mismatch ? `Calibration imported; edit required: ${profile.mismatch}` : `Calibration profile ${profile.name || profile.id} is ready for review` },
      };
    }
    case "UPDATE_CALIBRATION_PROFILE": {
      const current = state.calibrations.find((candidate) => candidate.id === action.id);
      if (!current) return { ...state, ui: { ...state.ui, toast: "Calibration profile not found" } };
      const profile = profileWithValidation({ ...current, ...action.patch, accepted: false }, false);
      return { ...state, ...invalidateDerivedRun(state), calibrations: state.calibrations.map((candidate) => candidate.id === profile.id ? profile : candidate), ui: { ...state.ui, toast: profile.mismatch ? `Calibration needs review: ${profile.mismatch}` : "Calibration edits saved; accept the profile to bind it to generation" } };
    }
    case "ACCEPT_CALIBRATION_PROFILE": {
      const current = state.calibrations.find((candidate) => candidate.id === action.id);
      if (!current) return { ...state, ui: { ...state.ui, toast: "Calibration profile not found" } };
      const errors = validateCalibrationProfile(current);
      if (errors.length) return { ...state, calibrations: state.calibrations.map((candidate) => candidate.id === action.id ? { ...candidate, accepted: false, mismatch: errors.join("; ") } : candidate), ui: { ...state.ui, toast: `Cannot accept calibration: ${errors.join(" · ")}` } };
      return { ...state, ...invalidateDerivedRun(state), calibrations: state.calibrations.map((candidate) => candidate.id === action.id ? { ...candidate, accepted: true, mismatch: undefined } : candidate), selection: { ...state.selection, calibrationId: action.id }, ui: { ...state.ui, toast: `Accepted calibration ${current.name}` } };
    }
    case "REVOKE_CALIBRATION_PROFILE": {
      const current = state.calibrations.find((candidate) => candidate.id === action.id);
      if (!current) return { ...state, ui: { ...state.ui, toast: "Calibration profile not found" } };
      return { ...state, ...invalidateDerivedRun(state), calibrations: state.calibrations.map((candidate) => candidate.id === action.id ? { ...candidate, accepted: false, mismatch: "Acceptance revoked; review before generation" } : candidate), selection: state.selection.calibrationId === action.id ? { ...state.selection, calibrationId: undefined } : state.selection, ui: { ...state.ui, toast: `Revoked calibration ${current.name}; generation is blocked until re-accepted` } };
    }
    case "REVIEW_CALIBRATION":
      return {
        ...state,
        ...invalidateDerivedRun(state),
        selection: { ...state.selection, calibrationId: action.profileId },
        ui: { ...state.ui, toast: `Reviewed ${state.calibrations.find((profile) => profile.id === action.profileId)?.name ?? "calibration profile"}` },
      };
    case "ACKNOWLEDGE_CLIPPING":
      return {
        ...state,
        toolpath: { ...state.toolpath, clippingAcknowledged: true },
        ui: { ...state.ui, toast: "Width clipping acknowledged for this run" },
      };
    case "SET_TOOLPATH_GENERATED":
      if (!state.calibrations.some((profile) => profile.accepted)) {
        return { ...state, ui: { ...state.ui, toast: "Generation blocked: explicitly accept a calibration profile first" } };
      }
      return {
        ...state,
        ...invalidateDerivedRun(state),
        toolpath: { ...state.toolpath, generated: true, audited: false, clippingAcknowledged: false, runId: action.runId, estimated: action.estimate, clippingPercent: action.clippingPercent ?? state.toolpath.clippingPercent },
        ui: { ...state.ui, toast: "Generated-segment preview ready; clipping review is required before audited output" },
      };
    case "SET_LAYER":
      return { ...state, toolpath: { ...state.toolpath, selectedLayer: action.layer } };
    case "GENERATE_AUDITED_GCODE":
      if (!state.toolpath.generated || !state.toolpath.clippingAcknowledged) return state;
      return {
        ...state,
        toolpath: { ...state.toolpath, audited: true },
        ui: { ...state.ui, toast: "Preview stream reverse-audited; audited G-code is available" },
      };
    case "EXPORT_RUN_PACKAGE":
      if (!state.toolpath.audited) return state;
      return {
        ...state,
        send: { ...state.send, packageExported: true, packageName: action.packageName ?? "run-package", packageDirectory: action.packageDirectory, files: action.files, exportHash: action.exportHash ?? "sha256:unknown" },
        ui: { ...state.ui, workspace: "send", toast: "Run package exported locally; automatic print start remains unavailable" },
      };
    case "IMPORT_SCAN_BACK":
      return {
        ...state,
        verify: {
          ...state.verify,
          evidenceImported: true,
          reportExported: false,
          reportPath: undefined,
          evidenceName: action.evidenceName ?? action.result?.evidenceName ?? state.verify.evidenceName,
          sourcePath: action.sourcePath,
          registrationMethod: action.result?.registrationMethod ?? "landmark rigid",
          confidence: action.result?.confidence ?? "high",
          comparison: action.result?.comparison ?? state.verify.comparison,
          provenance: action.result?.provenance ?? state.verify.provenance,
        },
        ui: { ...state.ui, workspace: "verify", toast: `Imported ${action.evidenceName ?? action.result?.evidenceName ?? "scan-back evidence"}` },
      };
    case "SET_COMPARISON_MODE":
      return { ...state, verify: { ...state.verify, comparisonMode: action.mode } };
    case "SET_REGISTRATION":
      return { ...state, verify: { ...state.verify, registrationMethod: action.method, confidence: action.confidence } };
    case "EXPORT_REPORT":
      if (!state.verify.evidenceImported) return state;
      return { ...state, verify: { ...state.verify, reportExported: true, reportPath: action.reportPath }, ui: { ...state.ui, toast: "Verification report exported with provenance and comparison metrics" } };
    case "SET_SCENE_SELECTION":
      return { ...state, ui: { ...state.ui, selectedSceneId: action.id } };
    case "SET_SCENE_TRANSFORM":
      if (action.transform.position && !validVector(action.transform.position)) return rejectedTransform(state, "Position must contain three finite millimetre values");
      if (action.transform.rotation && !validVector(action.transform.rotation)) return rejectedTransform(state, "Rotation must contain three finite degree values");
      if (action.transform.scale && !validVector(action.transform.scale, true)) return rejectedTransform(state, "Object size must be greater than zero on every axis");
      return {
        ...state,
        ...invalidateDerivedRun(state),
        scene: state.scene.map((object) => object.id === action.id ? { ...object, transform: { ...object.transform, ...action.transform } } : object),
      };
    case "SET_SCENE_DIMENSIONS":
      if (!validVector(action.dimensionsMm, true)) return rejectedTransform(state, "Geometry dimensions must be greater than zero on every axis");
      return {
        ...state,
        ...invalidateDerivedRun(state),
        scene: state.scene.map((object) => object.id === action.id ? { ...object, dimensionsMm: action.dimensionsMm, transform: { ...object.transform, scale: action.dimensionsMm } } : object),
      };
    case "SET_SCENE_OWNERSHIP":
      return {
        ...state,
        ...invalidateDerivedRun(state),
        scene: state.scene.map((object) => object.id === action.id ? { ...object, region: action.region ?? object.region, tool: action.tool ?? object.tool } : object),
      };
    case "SET_SCENE_TARGET_HU":
      return {
        ...state,
        ...invalidateDerivedRun(state),
        scene: state.scene.map((object) => object.id === action.id ? { ...object, targetHu: action.targetHu } : object),
      };
    case "TOGGLE_SCENE_VISIBILITY":
      return { ...state, ...invalidateDerivedRun(state), scene: state.scene.map((object) => object.id === action.id ? { ...object, visible: !object.visible } : object) };
    case "RESTORE_SCENE_SNAPSHOT":
      return {
        ...state,
        ...invalidateDerivedRun(state),
        scene: action.scene,
        ui: { ...state.ui, selectedSceneId: action.selectedSceneId, toast: action.message },
      };
    case "ADD_PRIMITIVE": {
      const number = state.scene.filter((object) => object.kind === action.kind).length + 1;
      const id = `scene-${action.kind}-${number}`;
      return {
        ...state,
        ...invalidateDerivedRun(state),
        scene: [...state.scene, {
          id,
          name: `${action.kind[0].toUpperCase()}${action.kind.slice(1)} ${number}`,
          kind: action.kind,
          region: "measurement",
          tool: "T0",
          transform: { position: { x: 0, y: 0, z: 12 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 32, y: 32, z: 12 } },
          dimensionsMm: { x: 32, y: 32, z: 12 },
          polygonSides: action.kind === "polygon-prism" ? 6 : undefined,
          visible: true,
        }],
        ui: { ...state.ui, selectedSceneId: id, toast: `Added ${action.kind} to the scene` },
      };
    }
    case "BOOLEAN_SCENE": {
      const selectedIds = action.operandIds.filter((id) => state.scene.some((object) => object.id === id));
      if (selectedIds.length < 2) return { ...state, ui: { ...state.ui, toast: "Select at least two scene operands before applying a Boolean" } };
      const operands = selectedIds.map((id) => state.scene.find((object) => object.id === id)).filter((object): object is NonNullable<typeof object> => Boolean(object));
      const ownership = new Set(operands.map((object) => `${object.tool}:${object.region}:${object.targetHu ?? "calibrated-default"}`));
      if (ownership.size !== 1) return { ...state, ui: { ...state.ui, toast: "Boolean operands must share one tool, region, and target HU; split mixed-material geometry into explicit regions" } };
      const inherited = operands[0];
      const resultId = `scene-boolean-${state.scene.filter((object) => object.kind === "group").length + 1}`;
      return {
        ...state,
        ...invalidateDerivedRun(state),
        scene: [...state.scene.map((object) => selectedIds.includes(object.id) ? { ...object, visible: false } : object), {
          id: resultId,
          name: `${action.operation[0].toUpperCase()}${action.operation.slice(1)} result`,
          kind: "group",
          region: inherited.region,
          tool: inherited.tool,
          targetHu: inherited.targetHu,
          transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
          boolean: { operation: action.operation, operands: selectedIds },
          visible: true,
        }],
        ui: { ...state.ui, selectedSceneId: resultId, toast: `${action.operation} staged for canonical sidecar validation` },
      };
    }
    case "IMPORT_SOLID": {
      const number = state.scene.filter((object) => object.sourcePath).length + 1;
      const id = `scene-import-${number}`;
      return { ...state, ...invalidateDerivedRun(state), scene: [...state.scene, { id, name: `${action.format.toUpperCase()} import ${number}`, kind: "fixture", region: "fixture", tool: "T1", sourcePath: action.path, transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, visible: true }], ui: { ...state.ui, selectedSceneId: id, toast: `Imported ${action.format.toUpperCase()} · validate before generation` } };
    }
    case "SET_IMPORTED_SOLID": {
      const number = state.scene.filter((object) => object.sourcePath).length + 1;
      const id = `scene-import-${number}`;
      const centeredVertices = action.vertices.map((vertex) => [vertex[0] - action.centerMm.x, vertex[1] - action.centerMm.y, vertex[2] - action.centerMm.z]);
      return { ...state, ...invalidateDerivedRun(state), scene: [...state.scene, { id, name: `${action.format.toUpperCase()} import ${number}`, kind: "fixture", region: "fixture", tool: "T1", sourcePath: action.path, sourceDimensionsMm: action.dimensionsMm, sourceCenterMm: action.centerMm, vertices: centeredVertices, faces: action.faces, dimensionsMm: action.dimensionsMm, transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: action.dimensionsMm }, visible: true }], ui: { ...state.ui, selectedSceneId: id, toast: `Imported ${action.format.toUpperCase()} mesh · ${action.vertices.length} vertices · validate before generation` } };
    }
    case "HYDRATE_IMPORTED_SOLID":
      return { ...state, scene: state.scene.map((object) => {
        if (object.id !== action.id) return object;
        const sourceCenterMm = object.sourceCenterMm ?? action.centerMm;
        const vertices = action.vertices.map((vertex) => [vertex[0] - sourceCenterMm.x, vertex[1] - sourceCenterMm.y, vertex[2] - sourceCenterMm.z]);
        return { ...object, vertices, faces: action.faces, sourceDimensionsMm: action.dimensionsMm, sourceCenterMm };
      }) };
    case "SET_TOAST":
      return { ...state, ui: { ...state.ui, toast: action.message } };
    case "CLEAR_TOAST":
      return { ...state, ui: { ...state.ui, toast: "" } };
    default:
      return state;
  }
}
