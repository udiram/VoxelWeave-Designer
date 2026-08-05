import { createInitialProjectState, projectReducer } from "../state/projectState";

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
});
