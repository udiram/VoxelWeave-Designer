import { syntheticProjectDocument } from "../data/fixtures";
import type { ProjectAction, ProjectState, ProjectUiState } from "../types";

export function createInitialProjectState(recovered = false): ProjectState {
  const ui: ProjectUiState = {
    workspace: "design",
    selectedSceneId: "scene-lung-volume",
    selectedPane: "axial",
    toast: recovered ? "Recovered the latest local project snapshot" : "Synthetic project ready",
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
        ui: { ...createInitialProjectState().ui, toast: "Opened deterministic synthetic lung phantom project" },
      };
    case "SET_WORKSPACE":
      return { ...state, ui: { ...state.ui, workspace: action.workspace, toast: "" } };
    case "SET_SELECTED_PANE":
      return { ...state, ui: { ...state.ui, selectedPane: action.pane } };
    case "SET_SELECTION": {
      const selection = { ...state.selection, ...action.patch };
      const span = Math.max(1, selection.end - selection.start);
      return { ...state, selection: { ...selection, thicknessMm: Number((span * state.source.spacing.z).toFixed(1)) } };
    }
    case "CREATE_PRINT_SELECTION":
      return {
        ...state,
        selection: { ...state.selection, created: true },
        ui: { ...state.ui, toast: "Print selection created from physical coordinates" },
      };
    case "REVIEW_CALIBRATION":
      return {
        ...state,
        ui: { ...state.ui, toast: `Reviewed ${state.calibrations.find((profile) => profile.id === action.profileId)?.name ?? "calibration profile"}` },
      };
    case "ACKNOWLEDGE_CLIPPING":
      return {
        ...state,
        toolpath: { ...state.toolpath, clippingAcknowledged: true },
        ui: { ...state.ui, toast: "Width clipping acknowledged for this synthetic run" },
      };
    case "SET_TOOLPATH_GENERATED":
      return {
        ...state,
        toolpath: { ...state.toolpath, generated: true, runId: action.runId, estimated: action.estimate },
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
        send: { ...state.send, packageExported: true, packageName: "lung-phantom-study_run-vw-demo-0001.zip", exportHash: "sha256:12af…bd90" },
        ui: { ...state.ui, workspace: "send", toast: "Run package exported locally; automatic print start remains unavailable" },
      };
    case "IMPORT_SCAN_BACK":
      return {
        ...state,
        verify: {
          ...state.verify,
          evidenceImported: true,
          evidenceName: "scan-back_lung-phantom_2026-08-04.tiff",
          registrationMethod: "landmark rigid",
          confidence: "high",
          comparison: { meanAbsoluteHu: 38, p95AbsoluteHu: 112, registeredVoxels: 482104 },
        },
        ui: { ...state.ui, workspace: "verify", toast: "Imported deterministic scan-back evidence" },
      };
    case "SET_COMPARISON_MODE":
      return { ...state, verify: { ...state.verify, comparisonMode: action.mode } };
    case "SET_REGISTRATION":
      return { ...state, verify: { ...state.verify, registrationMethod: action.method, confidence: action.confidence } };
    case "EXPORT_REPORT":
      if (!state.verify.evidenceImported) return state;
      return { ...state, verify: { ...state.verify, reportExported: true }, ui: { ...state.ui, toast: "Verification report exported with provenance and comparison metrics" } };
    case "SET_SCENE_SELECTION":
      return { ...state, ui: { ...state.ui, selectedSceneId: action.id } };
    case "SET_SCENE_TRANSFORM":
      return {
        ...state,
        scene: state.scene.map((object) => object.id === action.id ? { ...object, transform: { ...object.transform, ...action.transform } } : object),
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
          visible: true,
        }],
        ui: { ...state.ui, selectedSceneId: id, toast: `Added ${action.kind} to the scene` },
      };
    }
    case "SET_TOAST":
      return { ...state, ui: { ...state.ui, toast: action.message } };
    case "CLEAR_TOAST":
      return { ...state, ui: { ...state.ui, toast: "" } };
    default:
      return state;
  }
}
