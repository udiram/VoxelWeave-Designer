import { syntheticProjectDocument } from "../data/fixtures";
import type { CalibrationProfile, CropBounds, DicomSource, ProjectAction, ProjectState, ProjectUiState } from "../types";

const requiredCalibrationFields: Array<keyof Pick<CalibrationProfile, "name" | "material" | "lot" | "printer" | "scanner" | "reconstruction">> = ["name", "material", "lot", "printer", "scanner", "reconstruction"];

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
    selectedSceneId: "scene-lung-volume",
    selectedPane: "axial",
    toast: recovered ? "Recovered the latest local project snapshot" : "Create or open a .voxelweave project to begin",
    autosaveState: recovered ? "recovered" : "saved",
    lastSavedAt: recovered ? new Date().toISOString() : syntheticProjectDocument.savedAt,
  };
  return { ...structuredClone(syntheticProjectDocument), ui };
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
        ui: {
          ...createInitialProjectState().ui,
          filePath: action.path,
          selectedSceneId: action.project.scene[0]?.id ?? "",
          toast: action.path ? `Opened ${action.path.split(/[\\/]/).pop()}` : "Opened project",
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
      const span = selection.kind === "single" ? 1 : Math.max(1, selection.end - selection.start);
      const boundedStart = Math.max(0, Math.min(selection.start, state.source.sliceCount - 1));
      const boundedEnd = Math.max(boundedStart, Math.min(selection.end, state.source.sliceCount - 1));
      return { ...state, selection: { ...selection, start: boundedStart, end: boundedEnd, stride: Math.max(1, selection.stride), thicknessMm: Number((span * spacing).toFixed(3)), outputDimensionsMm: { x: Math.abs(selection.crop.x[1] - selection.crop.x[0]) * selection.scale, y: Math.abs(selection.crop.y[1] - selection.crop.y[0]) * selection.scale, z: Number((span * spacing * selection.scale).toFixed(3)) } } };
    }
    case "SET_DICOM_SOURCE": {
      const source = action.source;
      const max = Math.max(1, source.sliceCount - 1);
      const end = Math.min(state.selection.end, max);
      const start = Math.min(state.selection.start, end);
      const spacing = state.selection.orientation === "axial" ? source.spacing.z : state.selection.orientation === "sagittal" ? source.spacing.x : source.spacing.y;
      const physicalBounds = sourcePhysicalBounds(source);
      const hasDicomObject = state.scene.some((object) => object.kind === "dicom" && object.sourcePath === source.path);
      const scene = hasDicomObject || !source.path ? state.scene : [...state.scene, {
        id: "scene-dicom-source",
        name: source.name,
        kind: "dicom" as const,
        region: "measurement" as const,
        tool: "T0" as const,
        sourcePath: source.path,
        dimensionsMm: { x: Math.max(0, source.dimensions.x - 1) * source.spacing.x, y: Math.max(0, source.dimensions.y - 1) * source.spacing.y, z: Math.max(0, source.dimensions.z - 1) * source.spacing.z },
        transform: { position: source.origin, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        visible: true,
      }];
      return {
        ...state,
        source,
        scene,
        selection: {
          ...state.selection,
          start,
          end,
          thicknessMm: Number((Math.max(1, end - start) * spacing).toFixed(3)),
          crop: physicalBounds,
          created: false,
          outputDimensionsMm: { x: Math.abs(physicalBounds.x[1] - physicalBounds.x[0]), y: Math.abs(physicalBounds.y[1] - physicalBounds.y[0]), z: Number((Math.max(1, end - start) * spacing).toFixed(3)) },
        },
        ui: { ...state.ui, selectedSceneId: scene.find((object) => object.kind === "dicom")?.id ?? scene[0]?.id ?? state.ui.selectedSceneId, toast: `Loaded ${source.name} · ${source.sliceCount} slices` },
      };
    }
    case "CREATE_PRINT_SELECTION":
      return {
        ...state,
        selection: { ...state.selection, created: true },
        ui: { ...state.ui, toast: "Print selection created from physical coordinates" },
      };
    case "SET_SELECTION_RESULT":
      return {
        ...state,
        selection: {
          ...state.selection,
          created: true,
          selectionId: action.result.selectionId,
          transformHash: action.result.transformHash,
          sourceToPrintTransform: action.result.sourceToPrintTransform ?? state.selection.sourceToPrintTransform,
          outputDimensionsMm: state.selection.outputDimensionsMm,
        },
        ui: { ...state.ui, toast: `Print selection created · ${action.result.selectionId}` },
      };
    case "UPSERT_CALIBRATION_PROFILE": {
      const profile = profileWithValidation(action.profile, false);
      const existing = state.calibrations.some((candidate) => candidate.id === profile.id);
      return {
        ...state,
        calibrations: existing ? state.calibrations.map((candidate) => candidate.id === profile.id ? profile : candidate) : [...state.calibrations, profile],
        selection: state.selection.calibrationId === profile.id ? { ...state.selection, calibrationId: profile.id } : state.selection,
        toolpath: existing ? { ...state.toolpath, generated: false, audited: false, runId: undefined } : state.toolpath,
        ui: { ...state.ui, toast: profile.mismatch ? `Calibration imported; edit required: ${profile.mismatch}` : `Calibration profile ${profile.name || profile.id} is ready for review` },
      };
    }
    case "UPDATE_CALIBRATION_PROFILE": {
      const current = state.calibrations.find((candidate) => candidate.id === action.id);
      if (!current) return { ...state, ui: { ...state.ui, toast: "Calibration profile not found" } };
      const profile = profileWithValidation({ ...current, ...action.patch, accepted: false }, false);
      return { ...state, calibrations: state.calibrations.map((candidate) => candidate.id === profile.id ? profile : candidate), toolpath: { ...state.toolpath, generated: false, audited: false, runId: undefined }, ui: { ...state.ui, toast: profile.mismatch ? `Calibration needs review: ${profile.mismatch}` : "Calibration edits saved; accept the profile to bind it to generation" } };
    }
    case "ACCEPT_CALIBRATION_PROFILE": {
      const current = state.calibrations.find((candidate) => candidate.id === action.id);
      if (!current) return { ...state, ui: { ...state.ui, toast: "Calibration profile not found" } };
      const errors = validateCalibrationProfile(current);
      if (errors.length) return { ...state, calibrations: state.calibrations.map((candidate) => candidate.id === action.id ? { ...candidate, accepted: false, mismatch: errors.join("; ") } : candidate), ui: { ...state.ui, toast: `Cannot accept calibration: ${errors.join(" · ")}` } };
      return { ...state, calibrations: state.calibrations.map((candidate) => candidate.id === action.id ? { ...candidate, accepted: true, mismatch: undefined } : candidate), selection: { ...state.selection, calibrationId: action.id }, ui: { ...state.ui, toast: `Accepted calibration ${current.name}` } };
    }
    case "REVOKE_CALIBRATION_PROFILE": {
      const current = state.calibrations.find((candidate) => candidate.id === action.id);
      if (!current) return { ...state, ui: { ...state.ui, toast: "Calibration profile not found" } };
      return { ...state, calibrations: state.calibrations.map((candidate) => candidate.id === action.id ? { ...candidate, accepted: false, mismatch: "Acceptance revoked; review before generation" } : candidate), selection: state.selection.calibrationId === action.id ? { ...state.selection, calibrationId: undefined } : state.selection, toolpath: { ...state.toolpath, generated: false, audited: false, runId: undefined }, ui: { ...state.ui, toast: `Revoked calibration ${current.name}; generation is blocked until re-accepted` } };
    }
    case "REVIEW_CALIBRATION":
      return {
        ...state,
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
        toolpath: { ...state.toolpath, generated: true, runId: action.runId, estimated: action.estimate, clippingPercent: action.clippingPercent ?? state.toolpath.clippingPercent },
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
          evidenceName: action.evidenceName ?? action.result?.evidenceName ?? state.verify.evidenceName,
          sourcePath: action.sourcePath,
          registrationMethod: action.result?.registrationMethod ?? "landmark rigid",
          confidence: action.result?.confidence ?? "high",
          comparison: action.result?.comparison ?? state.verify.comparison,
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
      return {
        ...state,
        scene: state.scene.map((object) => object.id === action.id ? { ...object, transform: { ...object.transform, ...action.transform } } : object),
      };
    case "SET_SCENE_DIMENSIONS":
      return {
        ...state,
        scene: state.scene.map((object) => object.id === action.id ? { ...object, dimensionsMm: action.dimensionsMm, transform: { ...object.transform, scale: action.dimensionsMm } } : object),
      };
    case "SET_SCENE_OWNERSHIP":
      return {
        ...state,
        scene: state.scene.map((object) => object.id === action.id ? { ...object, region: action.region ?? object.region, tool: action.tool ?? object.tool } : object),
      };
    case "TOGGLE_SCENE_VISIBILITY":
      return { ...state, scene: state.scene.map((object) => object.id === action.id ? { ...object, visible: !object.visible } : object) };
    case "ADD_PRIMITIVE": {
      const number = state.scene.filter((object) => object.kind === action.kind).length + 1;
      const id = `scene-${action.kind}-${number}`;
      return {
        ...state,
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
      const resultId = `scene-boolean-${state.scene.filter((object) => object.kind === "group").length + 1}`;
      return {
        ...state,
        scene: [...state.scene.map((object) => selectedIds.includes(object.id) ? { ...object, visible: false } : object), {
          id: resultId,
          name: `${action.operation[0].toUpperCase()}${action.operation.slice(1)} result`,
          kind: "group",
          region: "measurement",
          tool: "T0",
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
      return { ...state, scene: [...state.scene, { id, name: `${action.format.toUpperCase()} import ${number}`, kind: "fixture", region: "fixture", tool: "T1", sourcePath: action.path, transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, visible: true }], ui: { ...state.ui, selectedSceneId: id, toast: `Imported ${action.format.toUpperCase()} · validate before generation` } };
    }
    case "SET_IMPORTED_SOLID": {
      const number = state.scene.filter((object) => object.sourcePath).length + 1;
      const id = `scene-import-${number}`;
      return { ...state, scene: [...state.scene, { id, name: `${action.format.toUpperCase()} import ${number}`, kind: "fixture", region: "fixture", tool: "T1", sourcePath: action.path, sourceDimensionsMm: action.dimensionsMm, vertices: action.vertices, faces: action.faces, dimensionsMm: action.dimensionsMm, transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: action.dimensionsMm }, visible: true }], ui: { ...state.ui, selectedSceneId: id, toast: `Imported ${action.format.toUpperCase()} mesh · ${action.vertices.length} vertices · validate before generation` } };
    }
    case "SET_TOAST":
      return { ...state, ui: { ...state.ui, toast: action.message } };
    case "CLEAR_TOAST":
      return { ...state, ui: { ...state.ui, toast: "" } };
    default:
      return state;
  }
}
