import { emptyProjectDocument, syntheticCalibrations } from "../data/fixtures";
import { createInitialProjectState, projectReducer, validateCalibrationProfile } from "../state/projectState";

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
});
