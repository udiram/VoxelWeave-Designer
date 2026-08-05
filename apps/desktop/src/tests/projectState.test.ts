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

  it("centers a nonzero-origin DICOM source and rejects invalid scene transforms", () => {
    const initial = createInitialProjectState();
    const source = {
      ...structuredClone(initial.source),
      path: "/study/nonzero",
      origin: { x: 10, y: -20, z: 30 },
      dimensions: { x: 11, y: 21, z: 6 },
      spacing: { x: 2, y: 1, z: 4 },
      directionLps: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    };
    const imported = projectReducer(initial, { type: "SET_DICOM_SOURCE", source });
    expect(imported.scene.find((object) => object.kind === "dicom")?.transform.position).toEqual({ x: 20, y: -10, z: 40 });

    const target = imported.scene.find((object) => object.kind !== "dicom")!;
    const invalid = projectReducer(imported, { type: "SET_SCENE_TRANSFORM", id: target.id, transform: { scale: { x: 0, y: 10, z: 10 } } });
    expect(invalid.scene.find((object) => object.id === target.id)?.transform.scale).toEqual(target.transform.scale);
    expect(invalid.ui.toast).toMatch(/greater than zero/);
  });

  it("normalizes a legacy imported mesh around its recovered manipulation pivot", () => {
    const initial = createInitialProjectState();
    const legacy = {
      ...initial,
      scene: [...initial.scene, {
        id: "legacy-mesh",
        name: "Legacy mesh",
        kind: "fixture" as const,
        region: "fixture" as const,
        tool: "T1" as const,
        sourcePath: "/study/legacy.stl",
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 2, y: 4, z: 6 } },
        visible: true,
      }],
    };
    const hydrated = projectReducer(legacy, { type: "HYDRATE_IMPORTED_SOLID", id: "legacy-mesh", vertices: [[10, 20, 30], [12, 24, 36]], faces: [[0, 1, 1]], dimensionsMm: { x: 2, y: 4, z: 6 }, centerMm: { x: 11, y: 22, z: 33 } });
    const mesh = hydrated.scene.find((object) => object.id === "legacy-mesh");
    expect(mesh?.sourceCenterMm).toEqual({ x: 11, y: 22, z: 33 });
    expect(mesh?.vertices).toEqual([[-1, -2, -3], [1, 2, 3]]);
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

  it("deletes editable structures while preserving the DICOM source and locked objects", () => {
    const initial = createInitialProjectState();
    const lockedId = initial.scene[2].id;
    const locked = { ...initial.scene[2], locked: true };
    const state = projectReducer({ ...initial, scene: [initial.scene[0], initial.scene[1], locked], ui: { ...initial.ui, selectedSceneId: initial.scene[1].id, selectedSceneIds: [initial.scene[1].id] } }, { type: "DELETE_SCENE_OBJECTS", ids: [initial.scene[0].id, initial.scene[1].id, lockedId] });
    expect(state.scene.map((object) => object.id)).toEqual([initial.scene[0].id, lockedId]);
    expect(state.scene.find((object) => object.id === initial.scene[0].id)?.kind).toBe("dicom");
    expect(state.scene.find((object) => object.id === lockedId)?.locked).toBe(true);
    expect(state.ui.selectedSceneId).toBe(initial.scene[0].id);
    expect(state.ui.toast).toMatch(/protected kept/);
  });

  it("duplicates and inserts scene objects with deterministic unique ids, names, and offsets", () => {
    const initial = createInitialProjectState();
    const source = initial.scene[1];
    const duplicated = projectReducer(initial, { type: "DUPLICATE_SCENE_OBJECTS", ids: [source.id], offset: { x: 4, y: -2, z: 1 } });
    const copy = duplicated.scene.find((object) => object.id !== source.id && object.name.startsWith("Reference frame copy"));
    expect(copy).toBeDefined();
    expect(copy?.transform.position).toEqual({ x: 4, y: -2, z: -25 });
    expect(duplicated.ui.selectedSceneIds).toEqual([copy?.id]);
    const pasted = projectReducer(duplicated, { type: "INSERT_SCENE_OBJECTS", objects: [structuredClone(source)], offset: { x: 8, y: 8, z: 8 } });
    const pastedCopies = pasted.scene.filter((object) => object.name.startsWith("Reference frame copy"));
    expect(new Set(pastedCopies.map((object) => object.id)).size).toBe(2);
    expect(pastedCopies.at(-1)?.transform.position).toEqual({ x: 8, y: 8, z: -18 });
  });

  it("keeps generated primitive, Boolean, and import identities fresh after delete and re-add", () => {
    let primitiveState = createInitialProjectState();
    primitiveState = projectReducer(primitiveState, { type: "ADD_PRIMITIVE", kind: "box" });
    const firstPrimitive = primitiveState.scene.find((object) => object.id === primitiveState.ui.selectedSceneId)!;
    primitiveState = projectReducer(primitiveState, { type: "DELETE_SCENE_OBJECTS", ids: [firstPrimitive.id] });
    primitiveState = projectReducer(primitiveState, { type: "ADD_PRIMITIVE", kind: "box" });
    const secondPrimitive = primitiveState.scene.find((object) => object.id === primitiveState.ui.selectedSceneId)!;
    expect(secondPrimitive.id).not.toBe(firstPrimitive.id);
    expect(secondPrimitive.name).not.toBe(firstPrimitive.name);

    let booleanState = createInitialProjectState();
    const booleanOperandIds = [booleanState.scene[1].id, booleanState.scene[2].id];
    booleanState = { ...booleanState, scene: booleanState.scene.map((object) => booleanOperandIds.includes(object.id) ? { ...object, region: "fixture" as const } : object) };
    booleanState = projectReducer(booleanState, { type: "BOOLEAN_SCENE", operation: "union", operandIds: booleanOperandIds });
    const firstBoolean = booleanState.scene.find((object) => object.boolean)!;
    booleanState = projectReducer(booleanState, { type: "DELETE_SCENE_OBJECTS", ids: [firstBoolean.id] });
    booleanState = projectReducer(booleanState, { type: "BOOLEAN_SCENE", operation: "union", operandIds: booleanOperandIds });
    const secondBoolean = booleanState.scene.find((object) => object.boolean)!;
    expect(secondBoolean.id).not.toBe(firstBoolean.id);
    expect(secondBoolean.name).not.toBe(firstBoolean.name);

    let importState = createInitialProjectState();
    importState = projectReducer(importState, { type: "IMPORT_SOLID", path: "/tmp/fixture.stl", format: "stl" });
    const firstImport = importState.scene.find((object) => object.id === importState.ui.selectedSceneId)!;
    importState = projectReducer(importState, { type: "DELETE_SCENE_OBJECTS", ids: [firstImport.id] });
    importState = projectReducer(importState, { type: "SET_IMPORTED_SOLID", path: "/tmp/fixture.stl", format: "stl", vertices: [[0, 0, 0], [2, 2, 2]], faces: [[0, 1, 1]], dimensionsMm: { x: 2, y: 2, z: 2 }, centerMm: { x: 1, y: 1, z: 1 } });
    const secondImport = importState.scene.find((object) => object.id === importState.ui.selectedSceneId)!;
    expect(secondImport.id).not.toBe(firstImport.id);
    expect(secondImport.name).not.toBe(firstImport.name);
  });

  it("aligns min and max edges using rotated world-space AABB extents", () => {
    const initial = createInitialProjectState();
    const anchor = {
      ...initial.scene[1],
      id: "rotated-anchor",
      name: "Rotated anchor",
      transform: {
        ...initial.scene[1].transform,
        position: { x: 10, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 90 },
        scale: { x: 10, y: 20, z: 30 },
      },
    };
    const target = {
      ...initial.scene[2],
      id: "rotated-target",
      name: "Rotated target",
      transform: {
        ...initial.scene[2].transform,
        position: { x: 40, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 90 },
        scale: { x: 4, y: 6, z: 8 },
      },
    };
    const base = { ...initial, scene: [anchor, target], ui: { ...initial.ui, selectedSceneId: anchor.id, selectedSceneIds: [anchor.id, target.id] } };
    const minAligned = projectReducer(base, { type: "ALIGN_SCENE_OBJECTS", ids: [anchor.id, target.id], axis: "x", mode: "min", anchorId: anchor.id });
    // Anchor's 20 mm world-X extent starts at x=0; target's rotated 6 mm extent starts at x=0 when centered at x=3.
    expect(minAligned.scene.find((object) => object.id === target.id)?.transform.position.x).toBe(3);
    const maxAligned = projectReducer(base, { type: "ALIGN_SCENE_OBJECTS", ids: [anchor.id, target.id], axis: "x", mode: "max", anchorId: anchor.id });
    expect(maxAligned.scene.find((object) => object.id === target.id)?.transform.position.x).toBe(17);
  });

  it("groups, locks, renames, and atomically aligns editable objects", () => {
    let state = createInitialProjectState();
    state = projectReducer(state, { type: "ADD_PRIMITIVE", kind: "box" });
    const second = state.ui.selectedSceneId;
    state = projectReducer(state, { type: "ADD_PRIMITIVE", kind: "cylinder" });
    const first = state.ui.selectedSceneId;
    state = projectReducer(state, { type: "SET_SCENE_TRANSFORM", id: second, transform: { position: { x: 30, y: 4, z: 12 } } });
    state = projectReducer(state, { type: "GROUP_SCENE_OBJECTS", ids: [first, second] });
    const members = state.scene.filter((object) => object.id === first || object.id === second);
    expect(new Set(members.map((object) => object.groupId)).size).toBe(1);
    expect(members[0].groupId).toBeTruthy();
    state = projectReducer(state, { type: "ALIGN_SCENE_OBJECTS", ids: [first, second], axis: "x", mode: "center", anchorId: first });
    expect(state.scene.find((object) => object.id === first)?.transform.position.x).toBe(state.scene.find((object) => object.id === second)?.transform.position.x);
    state = projectReducer(state, { type: "SET_SCENE_LOCKED", ids: [first], locked: true });
    const lockedEdit = projectReducer(state, { type: "SET_SCENE_TRANSFORM", id: first, transform: { position: { x: 100, y: 0, z: 0 } } });
    expect(lockedEdit.scene.find((object) => object.id === first)?.transform.position.x).not.toBe(100);
    state = projectReducer(state, { type: "SET_SCENE_LOCKED", ids: [first], locked: false });
    state = projectReducer(state, { type: "RENAME_SCENE_OBJECT", id: first, name: "Aligned support" });
    expect(state.scene.find((object) => object.id === first)?.name).toBe("Aligned support");
    state = projectReducer(state, { type: "UNGROUP_SCENE_OBJECTS", ids: [first] });
    expect(state.scene.find((object) => object.id === first)?.groupId).toBeUndefined();
    expect(state.scene.find((object) => object.id === second)?.groupId).toBeUndefined();
  });

  it("protects Boolean operands from dangling references and restores them when deleting a result", () => {
    let state = createInitialProjectState();
    const operandIds = [state.scene[1].id, state.scene[2].id];
    state = { ...state, scene: state.scene.map((object) => operandIds.includes(object.id) ? { ...object, region: "fixture" as const } : object) };
    state = projectReducer(state, { type: "BOOLEAN_SCENE", operation: "union", operandIds });
    const result = state.scene.find((object) => object.boolean);
    expect(result).toBeDefined();
    const nested = projectReducer(state, { type: "BOOLEAN_SCENE", operation: "subtract", operandIds: [result!.id, operandIds[0]] });
    expect(nested.scene).toBe(state.scene);
    expect(nested.ui.toast).toMatch(/cannot be used as operands/);
    const blocked = projectReducer(state, { type: "DELETE_SCENE_OBJECTS", ids: [operandIds[0]] });
    expect(blocked.scene).toBe(state.scene);
    expect(blocked.ui.toast).toMatch(/Boolean operand/);
    const restored = projectReducer(state, { type: "DELETE_SCENE_OBJECTS", ids: [result!.id] });
    expect(restored.scene.some((object) => object.id === result!.id)).toBe(false);
    expect(restored.scene.filter((object) => operandIds.includes(object.id)).every((object) => object.visible)).toBe(true);
  });

  it("normalizes selection for legacy UI state and preserves it through batch transforms", () => {
    const initial = createInitialProjectState();
    const legacy = { ...initial, ui: { ...initial.ui, selectedSceneIds: undefined as unknown as string[] } };
    const selected = projectReducer(legacy, { type: "SET_SCENE_SELECTIONS", ids: [initial.scene[1].id, initial.scene[2].id], primaryId: initial.scene[2].id });
    expect(selected.ui.selectedSceneIds).toEqual([initial.scene[1].id, initial.scene[2].id]);
    expect(selected.ui.selectedSceneId).toBe(initial.scene[2].id);
    const moved = projectReducer(selected, { type: "SET_SCENE_TRANSFORMS", transforms: [
      { id: initial.scene[1].id, transform: { position: { x: 5, y: 5, z: 5 } } },
      { id: initial.scene[2].id, transform: { position: { x: 8, y: 8, z: 8 } } },
    ] });
    expect(moved.scene.find((object) => object.id === initial.scene[1].id)?.transform.position).toEqual({ x: 5, y: 5, z: 5 });
    expect(moved.scene.find((object) => object.id === initial.scene[2].id)?.transform.position).toEqual({ x: 8, y: 8, z: 8 });
    expect(moved.ui.selectedSceneIds).toEqual(selected.ui.selectedSceneIds);
  });
});
