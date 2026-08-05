import { emptyProjectDocument, syntheticCalibrations } from "../data/fixtures";
import { createInitialProjectState, projectReducer, selectionOutputDimensions, validateCalibrationProfile } from "../state/projectState";

describe("synthetic workflow state", () => {
  it("creates a physical selection and gates audited G-code on clipping acknowledgement", () => {
    let state = createInitialProjectState();
    state = projectReducer(state, { type: "CREATE_PRINT_SELECTION" });
    state = projectReducer(state, { type: "SET_TOOLPATH_GENERATED", runId: "run-1", estimate: state.toolpath.estimated });
    state = projectReducer(state, { type: "GENERATE_AUDITED_GCODE" });
    expect(state.toolpath.audited).toBe(false);
    state = projectReducer(state, { type: "ACKNOWLEDGE_CLIPPING" });
    state = projectReducer(state, { type: "GENERATE_AUDITED_GCODE" });
    expect(state.toolpath.audited).toBe(true);
  });

  it("moves the package into Verify only after export", () => {
    let state = createInitialProjectState();
    state = projectReducer(state, { type: "CREATE_PRINT_SELECTION" });
    state = projectReducer(state, { type: "SET_TOOLPATH_GENERATED", runId: "run-1", estimate: state.toolpath.estimated });
    state = projectReducer(state, { type: "ACKNOWLEDGE_CLIPPING" });
    state = projectReducer(state, { type: "GENERATE_AUDITED_GCODE" });
    state = projectReducer(state, { type: "EXPORT_RUN_PACKAGE" });
    expect(state.send.packageExported).toBe(true);
    state = projectReducer(state, { type: "IMPORT_SCAN_BACK" });
    expect(state.verify.evidenceImported).toBe(true);
    state = projectReducer(state, { type: "EXPORT_REPORT" });
    expect(state.verify.reportExported).toBe(true);
  });

  it("keeps native projects blocked until a calibration is explicitly accepted", () => {
    const nativeState = { ...structuredClone(emptyProjectDocument), ui: createInitialProjectState().ui };
    expect(nativeState.calibrations).toHaveLength(0);
    const attempted = projectReducer(nativeState, { type: "SET_TOOLPATH_GENERATED", runId: "blocked", estimate: nativeState.toolpath.estimated });
    expect(attempted.toolpath.generated).toBe(false);

    const profile = { ...structuredClone(syntheticCalibrations[0]), id: "cal-native", accepted: false };
    let state = projectReducer(nativeState, { type: "UPSERT_CALIBRATION_PROFILE", profile });
    expect(state.calibrations[0].accepted).toBe(false);
    state = projectReducer(state, { type: "ACCEPT_CALIBRATION_PROFILE", id: profile.id });
    expect(state.calibrations[0].accepted).toBe(true);
    expect(state.selection.calibrationId).toBe(profile.id);
    state = projectReducer(state, { type: "SET_TOOLPATH_GENERATED", runId: "native-run", estimate: state.toolpath.estimated });
    expect(state.toolpath.generated).toBe(true);
    state = projectReducer(state, { type: "UPDATE_CALIBRATION_PROFILE", id: profile.id, patch: { lot: "edited-lot" } });
    expect(state.toolpath.generated).toBe(false);
    state = projectReducer(state, { type: "REVOKE_CALIBRATION_PROFILE", id: profile.id });
    expect(state.calibrations[0].accepted).toBe(false);
    expect(state.selection.calibrationId).toBeUndefined();
  });

  it("rejects incomplete calibration bindings and out-of-range samples", () => {
    const profile = { ...structuredClone(syntheticCalibrations[0]), id: "cal-invalid", accepted: false, name: "", widthRange: [0.8, 0.7] as [number, number] };
    const errors = validateCalibrationProfile(profile);
    expect(errors).toEqual(expect.arrayContaining(["name is required", "width range must be finite and increasing"]));
    let state = projectReducer({ ...structuredClone(emptyProjectDocument), ui: createInitialProjectState().ui }, { type: "UPSERT_CALIBRATION_PROFILE", profile });
    state = projectReducer(state, { type: "ACCEPT_CALIBRATION_PROFILE", id: profile.id });
    expect(state.calibrations[0].accepted).toBe(false);
    expect(state.ui.toast).toMatch(/Cannot accept calibration/);
  });

  it("maps inclusive anisotropic selections into each orthogonal print plane", () => {
    const source = {
      ...structuredClone(createInitialProjectState().source),
      dimensions: { x: 10, y: 20, z: 30 },
      spacing: { x: 0.5, y: 1.5, z: 2 },
      origin: { x: 0, y: 0, z: 0 },
      directionLps: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    };
    const base = { ...structuredClone(createInitialProjectState().selection), start: 2, end: 4, crop: { x: [0, 4.5] as [number, number], y: [0, 28.5] as [number, number], z: [0, 58] as [number, number] }, scale: 1, kind: "range" as const, outputMode: "continuous" as const };
    expect(selectionOutputDimensions(source, { ...base, orientation: "axial" })).toEqual({ x: 5, y: 30, z: 6 });
    expect(selectionOutputDimensions(source, { ...base, orientation: "sagittal" })).toEqual({ x: 30, y: 60, z: 1.5 });
    expect(selectionOutputDimensions(source, { ...base, orientation: "coronal" })).toEqual({ x: 5, y: 60, z: 4.5 });
    expect(selectionOutputDimensions(source, { ...base, orientation: "sagittal", kind: "tiles", outputMode: "tiles", scale: 2, tileThicknessMm: 0.7 })).toEqual({ x: 60, y: 120, z: 0.7 });
  });

  it("invalidates every derived run, package, and verification artifact after a scene edit", () => {
    const initial = createInitialProjectState();
    const ready = {
      ...initial,
      toolpath: { ...initial.toolpath, generated: true, audited: true, runId: "stale-run" },
      send: { ...initial.send, packageExported: true, packageName: "stale.zip" },
      verify: { ...initial.verify, evidenceImported: true, reportExported: true, reportPath: "/stale/report.json" },
    };
    const object = ready.scene[1];
    const state = projectReducer(ready, { type: "SET_SCENE_TRANSFORM", id: object.id, transform: { position: { x: 4, y: 5, z: 6 } } });
    expect(state.toolpath).toMatchObject({ generated: false, audited: false, runId: undefined });
    expect(state.send.packageExported).toBe(false);
    expect(state.verify).toMatchObject({ evidenceImported: false, reportExported: false });
  });

  it("replaces stale DICOM scene nodes when a different source is imported", () => {
    let state = createInitialProjectState();
    state = projectReducer(state, { type: "SET_DICOM_SOURCE", source: { ...state.source, path: "/study/first", name: "first" } });
    state = projectReducer(state, { type: "SET_DICOM_SOURCE", source: { ...state.source, path: "/study/second", name: "second" } });
    const dicomObjects = state.scene.filter((object) => object.kind === "dicom");
    expect(dicomObjects).toHaveLength(1);
    expect(dicomObjects[0]).toMatchObject({ sourcePath: "/study/second", name: "second" });
  });

  it("clears non-hydrated run evidence when reopening a saved project", () => {
    const project = structuredClone(createInitialProjectState());
    const { ui: _ui, ...document } = project;
    document.toolpath = { ...document.toolpath, generated: true, audited: true, runId: "old-run" };
    document.send = { ...document.send, packageExported: true, packageName: "old.zip" };
    document.verify = { ...document.verify, evidenceImported: true, reportExported: true };
    const state = projectReducer(createInitialProjectState(), { type: "OPEN_PROJECT", project: document, path: "/study/open.voxelweave" });
    expect(state.toolpath).toMatchObject({ generated: false, audited: false, runId: undefined });
    expect(state.send.packageExported).toBe(false);
    expect(state.verify).toMatchObject({ evidenceImported: false, reportExported: false });
    expect(state.selection).toEqual(document.selection);
  });
});
