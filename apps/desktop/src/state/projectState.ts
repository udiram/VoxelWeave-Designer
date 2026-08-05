import { syntheticProjectDocument } from "../data/fixtures";
import type { CalibrationProfile, CropBounds, DicomSource, ProjectAction, ProjectState, ProjectUiState, SceneAlignmentAxis, SceneObject, Vec3 } from "../types";

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

const sceneAxes = ["x", "y", "z"] as const;

function generatedSceneIdentity(
  state: Pick<ProjectState, "scene" | "ui">,
  idBase: string,
  nameBase: string,
  identityKey = idBase,
): { id: string; name: string; sceneIdentityCounters: Record<string, number> } {
  const usedIds = new Set(state.scene.map((object) => object.id));
  const usedNames = new Set(state.scene.map((object) => object.name));
  const sceneIdentityCounters = { ...state.ui.sceneIdentityCounters };
  let serial = Math.max(1, sceneIdentityCounters[identityKey] ?? 1);
  let id = `${idBase}-${serial}`;
  let name = `${nameBase} ${serial}`;
  while (usedIds.has(id) || usedNames.has(name)) {
    serial += 1;
    id = `${idBase}-${serial}`;
    name = `${nameBase} ${serial}`;
  }
  sceneIdentityCounters[identityKey] = serial + 1;
  return { id, name, sceneIdentityCounters };
}

function sceneObjectIsProtected(object: SceneObject): boolean {
  return object.kind === "dicom" || object.locked === true;
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
}

function normalizedSceneSelection(scene: SceneObject[], ids: readonly string[], primaryId?: string): Pick<ProjectUiState, "selectedSceneId" | "selectedSceneIds"> {
  const requested = new Set(uniqueIds(ids));
  const selectedSceneIds = scene.filter((object) => requested.has(object.id)).map((object) => object.id);
  if (!selectedSceneIds.length) return { selectedSceneId: "", selectedSceneIds: [] };
  const selectedSceneId = primaryId && selectedSceneIds.includes(primaryId) ? primaryId : selectedSceneIds[0];
  return { selectedSceneId, selectedSceneIds };
}

function sceneSelectionAfterMutation(scene: SceneObject[], ids: readonly string[], primaryId?: string): Pick<ProjectUiState, "selectedSceneId" | "selectedSceneIds"> {
  const survivingSelection = normalizedSceneSelection(scene, ids, primaryId);
  if (survivingSelection.selectedSceneIds.length) return survivingSelection;
  const fallback = scene.find((object) => !sceneObjectIsProtected(object) && object.visible)
    ?? scene.find((object) => object.visible)
    ?? scene[0];
  return fallback ? normalizedSceneSelection(scene, [fallback.id], fallback.id) : { selectedSceneId: "", selectedSceneIds: [] };
}

function sceneSelectionForState(state: ProjectState): string[] {
  return state.ui.selectedSceneIds?.length ? state.ui.selectedSceneIds : state.ui.selectedSceneId ? [state.ui.selectedSceneId] : [];
}

function validSceneOffset(offset?: Vec3): Vec3 {
  const fallback = { x: 8, y: 8, z: 8 };
  if (!offset || sceneAxes.some((axis) => !Number.isFinite(offset[axis]))) return fallback;
  return { x: offset.x, y: offset.y, z: offset.z };
}

function uniqueSceneId(used: Set<string>, sourceId: string): string {
  const base = `${sourceId}-copy`;
  let candidate = base;
  let count = 2;
  while (used.has(candidate)) candidate = `${base}-${count++}`;
  used.add(candidate);
  return candidate;
}

function uniqueSceneName(used: Set<string>, sourceName: string): string {
  const stem = sourceName.trim().replace(/\s+copy(?:\s+\d+)?$/i, "") || "Object";
  const base = `${stem} copy`;
  let candidate = base;
  let count = 2;
  while (used.has(candidate)) candidate = `${base} ${count++}`;
  used.add(candidate);
  return candidate;
}

function uniqueGroupId(used: Set<string>, sourceGroupId: string): string {
  const base = `${sourceGroupId}-copy`;
  let candidate = base;
  let count = 2;
  while (used.has(candidate)) candidate = `${base}-${count++}`;
  used.add(candidate);
  return candidate;
}

function isValidSceneTransformPatch(transform: Partial<SceneObject["transform"]>): boolean {
  return (!transform.position || validVector(transform.position))
    && (!transform.rotation || validVector(transform.rotation))
    && (!transform.scale || validVector(transform.scale, true));
}

function mergeSceneTransform(object: SceneObject, transform: Partial<SceneObject["transform"]>): SceneObject {
  return { ...object, transform: { ...object.transform, ...transform } };
}

function sceneEditToast(state: ProjectState, message: string): ProjectState {
  return { ...state, ui: { ...state.ui, toast: message } };
}

type CloneSceneResult = { objects: SceneObject[]; skipped: number };

function cloneSceneObjects(existing: SceneObject[], input: SceneObject[], offset?: Vec3): CloneSceneResult {
  const safeOffset = validSceneOffset(offset);
  const usedIds = new Set(existing.map((object) => object.id));
  const usedNames = new Set(existing.map((object) => object.name));
  const usedGroupIds = new Set(existing.map((object) => object.groupId).filter((id): id is string => Boolean(id)));
  const sourceById = new Map(input.map((object) => [object.id, object]));
  const selectedIds = new Set(input.map((object) => object.id));
  const cloneable = input.filter((object) => {
    if (sceneObjectIsProtected(object)) return false;
    if (!object.boolean) return true;
    return object.boolean.operands.length >= 2 && object.boolean.operands.every((operandId) => {
      const operand = sourceById.get(operandId);
      return selectedIds.has(operandId) && Boolean(operand) && !sceneObjectIsProtected(operand!);
    });
  });
  const cloneableIds = new Set(cloneable.map((object) => object.id));
  const idMap = new Map<string, string>();
  cloneable.forEach((object) => idMap.set(object.id, uniqueSceneId(usedIds, object.id)));
  const groupMap = new Map<string, string>();
  cloneable.forEach((object) => {
    if (object.groupId && !groupMap.has(object.groupId)) groupMap.set(object.groupId, uniqueGroupId(usedGroupIds, object.groupId));
  });
  const objects = cloneable.map((object) => {
    const clone = structuredClone(object);
    clone.id = idMap.get(object.id)!;
    clone.name = uniqueSceneName(usedNames, object.name);
    clone.transform = {
      ...clone.transform,
      position: {
        x: Number((clone.transform.position.x + safeOffset.x).toFixed(4)),
        y: Number((clone.transform.position.y + safeOffset.y).toFixed(4)),
        z: Number((clone.transform.position.z + safeOffset.z).toFixed(4)),
      },
    };
    if (clone.groupId) clone.groupId = groupMap.get(clone.groupId);
    if (clone.boolean) clone.boolean = { ...clone.boolean, operands: clone.boolean.operands.map((operandId) => idMap.get(operandId)!).filter(Boolean) };
    return clone;
  });
  return { objects, skipped: input.length - cloneableIds.size };
}

function sceneObjectLocalDimensions(object: SceneObject): Vec3 {
  const fallback = object.dimensionsMm ?? { x: 1, y: 1, z: 1 };
  const dimension = (axis: keyof Vec3): number => {
    const scale = object.transform.scale[axis];
    if (Number.isFinite(scale) && scale > 0) return scale;
    const recovered = fallback[axis];
    return Number.isFinite(recovered) && recovered > 0 ? recovered : 1;
  };
  return {
    x: Math.max(0.001, dimension("x")),
    y: Math.max(0.001, dimension("y")),
    z: Math.max(0.001, dimension("z")),
  };
}

/**
 * Return the extent of the object's world-space AABB along one scene axis.
 * Three's scene rotation uses intrinsic XYZ Euler angles; the absolute matrix
 * coefficients give the exact AABB half-extent for box-like local geometry.
 */
function sceneObjectDimension(object: SceneObject, axis: SceneAlignmentAxis): number {
  const dimensions = sceneObjectLocalDimensions(object);
  const half = { x: dimensions.x / 2, y: dimensions.y / 2, z: dimensions.z / 2 };
  const rotation = object.transform.rotation;
  const x = Number.isFinite(rotation.x) ? rotation.x * Math.PI / 180 : 0;
  const y = Number.isFinite(rotation.y) ? rotation.y * Math.PI / 180 : 0;
  const z = Number.isFinite(rotation.z) ? rotation.z * Math.PI / 180 : 0;
  const cx = Math.cos(x); const sx = Math.sin(x);
  const cy = Math.cos(y); const sy = Math.sin(y);
  const cz = Math.cos(z); const sz = Math.sin(z);
  // Matrix layout matches THREE.Euler(..., "XYZ") used by the viewport.
  const matrix = [
    [cy * cz, -cy * sz, sy],
    [cx * sz + sx * sy * cz, cx * cz - sx * sy * sz, -cy * sx],
    [sx * sz - cx * sy * cz, sx * cz + cx * sy * sz, cx * cy],
  ];
  const row = matrix[sceneAxes.indexOf(axis)];
  return Math.max(0.001, 2 * (Math.abs(row[0]) * half.x + Math.abs(row[1]) * half.y + Math.abs(row[2]) * half.z));
}

function deleteSceneObjects(state: ProjectState, ids: readonly string[]): ProjectState {
  const requestedIds = new Set(uniqueIds(ids));
  const requested = state.scene.filter((object) => requestedIds.has(object.id));
  if (!requested.length) return sceneEditToast(state, "Nothing selected to delete");
  const protectedObjects = requested.filter(sceneObjectIsProtected);
  const requestedRootIds = new Set(requested.filter((object) => Boolean(object.boolean) && !sceneObjectIsProtected(object)).map((object) => object.id));
  const remainingRoots = state.scene.filter((object) => object.boolean && !requestedRootIds.has(object.id));
  const referencedByRemainingRoot = new Map<string, string>();
  remainingRoots.forEach((root) => root.boolean?.operands.forEach((operandId) => referencedByRemainingRoot.set(operandId, root.name)));
  const dependencyBlocked = requested.filter((object) => !sceneObjectIsProtected(object) && referencedByRemainingRoot.has(object.id));
  const deletableIds = new Set(requested.filter((object) => !sceneObjectIsProtected(object) && !referencedByRemainingRoot.has(object.id)).map((object) => object.id));
  if (!deletableIds.size) {
    const protectedLabel = protectedObjects.length ? `${protectedObjects.length} protected object${protectedObjects.length === 1 ? "" : "s"}` : "the selected objects";
    const dependencyLabel = dependencyBlocked.length ? `; ${dependencyBlocked.length} Boolean operand${dependencyBlocked.length === 1 ? "" : "s"} remain protected` : "";
    return sceneEditToast(state, `Nothing deleted · ${protectedLabel} cannot be deleted${dependencyLabel}`);
  }
  const scene = state.scene.filter((object) => !deletableIds.has(object.id)).map((object) => {
      const wasOperandOfDeletedRoot = [...requestedRootIds].some((rootId) => state.scene.find((candidate) => candidate.id === rootId)?.boolean?.operands.includes(object.id));
      return wasOperandOfDeletedRoot && !referencedByRemainingRoot.has(object.id) && !deletableIds.has(object.id) ? { ...object, visible: true } : object;
    });
  const selectedIds = sceneSelectionForState(state).filter((id) => !deletableIds.has(id));
  const selection = sceneSelectionAfterMutation(scene, selectedIds, deletableIds.has(state.ui.selectedSceneId) ? undefined : state.ui.selectedSceneId);
  const deletedCount = deletableIds.size;
  const protectedLabel = protectedObjects.length ? ` · ${protectedObjects.length} protected kept` : "";
  const dependencyLabel = dependencyBlocked.length ? ` · ${dependencyBlocked.length} Boolean operand${dependencyBlocked.length === 1 ? "" : "s"} kept` : "";
  return {
    ...state,
    ...invalidateDerivedRun(state),
    scene,
    ui: { ...state.ui, ...selection, toast: `Deleted ${deletedCount} object${deletedCount === 1 ? "" : "s"}${protectedLabel}${dependencyLabel}` },
  };
}

export function createInitialProjectState(recovered = false): ProjectState {
  const ui: ProjectUiState = {
    workspace: "design",
    selectedSceneId: "scene-reference-box",
    selectedSceneIds: ["scene-reference-box"],
    sceneIdentityCounters: {},
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
          selectedSceneIds: action.project.scene.length ? [action.project.scene.find((object) => object.kind !== "dicom" && object.visible)?.id ?? action.project.scene[0]?.id ?? ""] : [],
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
        ui: {
          ...state.ui,
          ...sceneSelectionAfterMutation(scene, [scene.find((object) => object.kind === "dicom")?.id ?? scene[0]?.id ?? state.ui.selectedSceneId], scene.find((object) => object.kind === "dicom")?.id ?? scene[0]?.id ?? state.ui.selectedSceneId),
          toast: `Loaded ${source.name} · ${source.sliceCount} slices`,
        },
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
    case "SET_SCENE_SELECTION": {
      if (!state.scene.some((object) => object.id === action.id)) return state;
      return { ...state, ui: { ...state.ui, selectedSceneId: action.id, selectedSceneIds: [action.id] } };
    }
    case "SET_SCENE_SELECTIONS": {
      const selection = normalizedSceneSelection(state.scene, action.ids, action.primaryId);
      return { ...state, ui: { ...state.ui, ...selection } };
    }
    case "SET_SCENE_TRANSFORM": {
      const object = state.scene.find((candidate) => candidate.id === action.id);
      if (!object) return state;
      if (sceneObjectIsProtected(object)) return sceneEditToast(state, object.kind === "dicom" ? "DICOM source geometry is locked" : `${object.name} is locked`);
      if (action.transform.position && !validVector(action.transform.position)) return rejectedTransform(state, "Position must contain three finite millimetre values");
      if (action.transform.rotation && !validVector(action.transform.rotation)) return rejectedTransform(state, "Rotation must contain three finite degree values");
      if (action.transform.scale && !validVector(action.transform.scale, true)) return rejectedTransform(state, "Object size must be greater than zero on every axis");
      return {
        ...state,
        ...invalidateDerivedRun(state),
        scene: state.scene.map((candidate) => candidate.id === action.id ? mergeSceneTransform(candidate, action.transform) : candidate),
      };
    }
    case "SET_SCENE_TRANSFORMS": {
      const patches = uniqueIds(action.transforms.map((entry) => entry.id)).map((id) => action.transforms.find((entry) => entry.id === id)!);
      const targets = patches.map((entry) => state.scene.find((object) => object.id === entry.id)).filter((object): object is SceneObject => Boolean(object));
      if (!patches.length || targets.length !== patches.length) return state;
      const protectedTarget = targets.find(sceneObjectIsProtected);
      if (protectedTarget) return sceneEditToast(state, protectedTarget.kind === "dicom" ? "DICOM source geometry is locked" : `${protectedTarget.name} is locked`);
      const invalid = patches.find((entry) => !isValidSceneTransformPatch(entry.transform));
      if (invalid?.transform.position) return rejectedTransform(state, "Position must contain three finite millimetre values");
      if (invalid?.transform.rotation) return rejectedTransform(state, "Rotation must contain three finite degree values");
      if (invalid?.transform.scale) return rejectedTransform(state, "Object size must be greater than zero on every axis");
      const byId = new Map(patches.map((entry) => [entry.id, entry.transform]));
      return {
        ...state,
        ...invalidateDerivedRun(state),
        scene: state.scene.map((object) => byId.has(object.id) ? mergeSceneTransform(object, byId.get(object.id)!) : object),
      };
    }
    case "SET_SCENE_DIMENSIONS": {
      const object = state.scene.find((candidate) => candidate.id === action.id);
      if (!object) return state;
      if (sceneObjectIsProtected(object)) return sceneEditToast(state, object.kind === "dicom" ? "DICOM source geometry is locked" : `${object.name} is locked`);
      if (!validVector(action.dimensionsMm, true)) return rejectedTransform(state, "Geometry dimensions must be greater than zero on every axis");
      return {
        ...state,
        ...invalidateDerivedRun(state),
        scene: state.scene.map((candidate) => candidate.id === action.id ? { ...candidate, dimensionsMm: action.dimensionsMm, transform: { ...candidate.transform, scale: action.dimensionsMm } } : candidate),
      };
    }
    case "SET_SCENE_OWNERSHIP": {
      const object = state.scene.find((candidate) => candidate.id === action.id);
      if (!object) return state;
      if (sceneObjectIsProtected(object)) return sceneEditToast(state, `${object.name} is locked`);
      return {
        ...state,
        ...invalidateDerivedRun(state),
        scene: state.scene.map((candidate) => candidate.id === action.id ? { ...candidate, region: action.region ?? candidate.region, tool: action.tool ?? candidate.tool } : candidate),
      };
    }
    case "SET_SCENE_TARGET_HU": {
      const object = state.scene.find((candidate) => candidate.id === action.id);
      if (!object) return state;
      if (sceneObjectIsProtected(object)) return sceneEditToast(state, `${object.name} is locked`);
      if (!Number.isFinite(action.targetHu)) return sceneEditToast(state, "Target HU must be finite");
      return {
        ...state,
        ...invalidateDerivedRun(state),
        scene: state.scene.map((candidate) => candidate.id === action.id ? { ...candidate, targetHu: action.targetHu } : candidate),
      };
    }
    case "TOGGLE_SCENE_VISIBILITY": {
      const object = state.scene.find((candidate) => candidate.id === action.id);
      if (!object) return state;
      return { ...state, ...invalidateDerivedRun(state), scene: state.scene.map((candidate) => candidate.id === action.id ? { ...candidate, visible: !candidate.visible } : candidate) };
    }
    case "DELETE_SCENE_OBJECTS":
      return deleteSceneObjects(state, action.ids);
    case "DUPLICATE_SCENE_OBJECTS": {
      const requested = uniqueIds(action.ids).map((id) => state.scene.find((object) => object.id === id)).filter((object): object is SceneObject => Boolean(object));
      if (!requested.length) return sceneEditToast(state, "Nothing selected to duplicate");
      const cloned = cloneSceneObjects(state.scene, requested, action.offset);
      if (!cloned.objects.length) return sceneEditToast(state, "Protected or incomplete Boolean objects cannot be duplicated");
      const scene = [...state.scene, ...cloned.objects];
      const selection = normalizedSceneSelection(scene, cloned.objects.map((object) => object.id), cloned.objects[0]?.id);
      return { ...state, ...invalidateDerivedRun(state), scene, ui: { ...state.ui, ...selection, toast: `Duplicated ${cloned.objects.length} object${cloned.objects.length === 1 ? "" : "s"}${cloned.skipped ? ` · ${cloned.skipped} skipped` : ""}` } };
    }
    case "INSERT_SCENE_OBJECTS": {
      const input = action.objects.filter((object) => object && typeof object.id === "string");
      if (!input.length) return sceneEditToast(state, "Clipboard is empty");
      const cloned = cloneSceneObjects(state.scene, input, action.offset);
      if (!cloned.objects.length) return sceneEditToast(state, "Clipboard contains no editable objects");
      const scene = [...state.scene, ...cloned.objects];
      const selection = normalizedSceneSelection(scene, cloned.objects.map((object) => object.id), cloned.objects[0]?.id);
      return { ...state, ...invalidateDerivedRun(state), scene, ui: { ...state.ui, ...selection, toast: `Pasted ${cloned.objects.length} object${cloned.objects.length === 1 ? "" : "s"}${cloned.skipped ? ` · ${cloned.skipped} skipped` : ""}` } };
    }
    case "GROUP_SCENE_OBJECTS": {
      const requested = uniqueIds(action.ids).map((id) => state.scene.find((object) => object.id === id)).filter((object): object is SceneObject => Boolean(object));
      const editable = requested.filter((object) => !sceneObjectIsProtected(object) && !object.boolean);
      if (editable.length < 2) return sceneEditToast(state, "Select at least two editable objects to group");
      const used = new Set(state.scene.map((object) => object.groupId).filter((id): id is string => Boolean(id)));
      const groupId = uniqueGroupId(used, "scene-group");
      const ids = new Set(editable.map((object) => object.id));
      return { ...state, ...invalidateDerivedRun(state), scene: state.scene.map((object) => ids.has(object.id) ? { ...object, groupId } : object), ui: { ...state.ui, toast: `Grouped ${editable.length} objects` } };
    }
    case "UNGROUP_SCENE_OBJECTS": {
      const requested = uniqueIds(action.ids ?? []).map((id) => state.scene.find((object) => object.id === id)).filter((object): object is SceneObject => Boolean(object));
      const groupIds = new Set<string>(action.groupId ? [action.groupId] : requested.map((object) => object.groupId).filter((id): id is string => Boolean(id)));
      if (!groupIds.size) return sceneEditToast(state, "Select a grouped object to ungroup");
      const changed = state.scene.some((object) => object.groupId && groupIds.has(object.groupId));
      if (!changed) return sceneEditToast(state, "No grouped objects to ungroup");
      return { ...state, ...invalidateDerivedRun(state), scene: state.scene.map((object) => object.groupId && groupIds.has(object.groupId) ? { ...object, groupId: undefined } : object), ui: { ...state.ui, toast: "Ungrouped selection" } };
    }
    case "SET_SCENE_LOCKED": {
      const requested = uniqueIds(action.ids).map((id) => state.scene.find((object) => object.id === id)).filter((object): object is SceneObject => Boolean(object));
      const editable = requested.filter((object) => object.kind !== "dicom");
      if (!editable.length) return sceneEditToast(state, "The DICOM source is always locked");
      const ids = new Set(editable.map((object) => object.id));
      const changed = editable.some((object) => object.locked !== action.locked);
      if (!changed) return sceneEditToast(state, action.locked ? "Selection is already locked" : "Selection is already unlocked");
      return { ...state, ...invalidateDerivedRun(state), scene: state.scene.map((object) => ids.has(object.id) ? { ...object, locked: action.locked } : object), ui: { ...state.ui, toast: `${action.locked ? "Locked" : "Unlocked"} ${editable.length} object${editable.length === 1 ? "" : "s"}` } };
    }
    case "RENAME_SCENE_OBJECT": {
      const object = state.scene.find((candidate) => candidate.id === action.id);
      const name = action.name.trim();
      if (!object) return state;
      if (object.kind === "dicom") return sceneEditToast(state, "The DICOM source name is tied to its source metadata");
      if (object.locked) return sceneEditToast(state, `${object.name} is locked`);
      if (!name) return sceneEditToast(state, "Object name cannot be empty");
      if (name === object.name) return state;
      return { ...state, ...invalidateDerivedRun(state), scene: state.scene.map((candidate) => candidate.id === object.id ? { ...candidate, name } : candidate), ui: { ...state.ui, toast: `Renamed object to ${name}` } };
    }
    case "ALIGN_SCENE_OBJECTS": {
      const requested = uniqueIds(action.ids).map((id) => state.scene.find((object) => object.id === id)).filter((object): object is SceneObject => Boolean(object));
      const editable = requested.filter((object) => !sceneObjectIsProtected(object));
      if (editable.length < 2) return sceneEditToast(state, "Select at least two editable objects to align");
      const anchor = editable.find((object) => object.id === action.anchorId) ?? editable[0];
      if (!anchor) return state;
      const targetDimension = sceneObjectDimension(anchor, action.axis);
      const targetPosition = anchor.transform.position[action.axis];
      const targetEdge = action.mode === "min" ? targetPosition - targetDimension / 2 : action.mode === "max" ? targetPosition + targetDimension / 2 : targetPosition;
      const transforms = editable.filter((object) => object.id !== anchor.id).map((object) => {
        const dimension = sceneObjectDimension(object, action.axis);
        const position = action.mode === "min" ? targetEdge + dimension / 2 : action.mode === "max" ? targetEdge - dimension / 2 : targetPosition;
        return { id: object.id, transform: { position: { ...object.transform.position, [action.axis]: Number(position.toFixed(4)) } } };
      });
      if (!transforms.length) return state;
      const byId = new Map(transforms.map((entry) => [entry.id, entry.transform]));
      return { ...state, ...invalidateDerivedRun(state), scene: state.scene.map((object) => byId.has(object.id) ? mergeSceneTransform(object, byId.get(object.id)!) : object), ui: { ...state.ui, toast: `Aligned ${editable.length} objects on ${action.axis.toUpperCase()}` } };
    }
    case "RESTORE_SCENE_SNAPSHOT": {
      const selection = normalizedSceneSelection(action.scene, action.selectedSceneIds ?? [action.selectedSceneId], action.selectedSceneId);
      return {
        ...state,
        ...invalidateDerivedRun(state),
        scene: action.scene,
        ui: { ...state.ui, ...selection, toast: action.message },
      };
    }
    case "ADD_PRIMITIVE": {
      const kindLabel = action.kind.split("-").map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");
      const identity = generatedSceneIdentity(state, `scene-${action.kind}`, kindLabel, `primitive:${action.kind}`);
      return {
        ...state,
        ...invalidateDerivedRun(state),
        scene: [...state.scene, {
          id: identity.id,
          name: identity.name,
          kind: action.kind,
          region: "measurement",
          tool: "T0",
          transform: { position: { x: 0, y: 0, z: 12 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 32, y: 32, z: 12 } },
          dimensionsMm: { x: 32, y: 32, z: 12 },
          polygonSides: action.kind === "polygon-prism" ? 6 : undefined,
          visible: true,
        }],
        ui: { ...state.ui, selectedSceneId: identity.id, selectedSceneIds: [identity.id], sceneIdentityCounters: identity.sceneIdentityCounters, toast: `Added ${action.kind} to the scene` },
      };
    }
    case "BOOLEAN_SCENE": {
      const selectedIds = action.operandIds.filter((id) => state.scene.some((object) => object.id === id));
      if (selectedIds.length < 2) return { ...state, ui: { ...state.ui, toast: "Select at least two scene operands before applying a Boolean" } };
      const operands = selectedIds.map((id) => state.scene.find((object) => object.id === id)).filter((object): object is NonNullable<typeof object> => Boolean(object));
      if (operands.some((object) => object.boolean)) return { ...state, ui: { ...state.ui, toast: "Boolean results cannot be used as operands; select the underlying editable structures" } };
      const ownership = new Set(operands.map((object) => `${object.tool}:${object.region}:${object.targetHu ?? "calibrated-default"}`));
      if (ownership.size !== 1) return { ...state, ui: { ...state.ui, toast: "Boolean operands must share one tool, region, and target HU; split mixed-material geometry into explicit regions" } };
      const inherited = operands[0];
      const operationLabel = `${action.operation[0].toUpperCase()}${action.operation.slice(1)} result`;
      const identity = generatedSceneIdentity(state, "scene-boolean", operationLabel, "boolean");
      return {
        ...state,
        ...invalidateDerivedRun(state),
        scene: [...state.scene.map((object) => selectedIds.includes(object.id) ? { ...object, visible: false } : object), {
          id: identity.id,
          name: identity.name,
          kind: "group",
          region: inherited.region,
          tool: inherited.tool,
          targetHu: inherited.targetHu,
          transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
          boolean: { operation: action.operation, operands: selectedIds },
          visible: true,
        }],
        ui: { ...state.ui, selectedSceneId: identity.id, selectedSceneIds: [identity.id], sceneIdentityCounters: identity.sceneIdentityCounters, toast: `${action.operation} staged for canonical sidecar validation` },
      };
    }
    case "IMPORT_SOLID": {
      const identity = generatedSceneIdentity(state, "scene-import", `${action.format.toUpperCase()} import`, "import");
      return { ...state, ...invalidateDerivedRun(state), scene: [...state.scene, { id: identity.id, name: identity.name, kind: "fixture", region: "fixture", tool: "T1", sourcePath: action.path, transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, visible: true }], ui: { ...state.ui, selectedSceneId: identity.id, selectedSceneIds: [identity.id], sceneIdentityCounters: identity.sceneIdentityCounters, toast: `Imported ${action.format.toUpperCase()} · validate before generation` } };
    }
    case "SET_IMPORTED_SOLID": {
      const identity = generatedSceneIdentity(state, "scene-import", `${action.format.toUpperCase()} import`, "import");
      const centeredVertices = action.vertices.map((vertex) => [vertex[0] - action.centerMm.x, vertex[1] - action.centerMm.y, vertex[2] - action.centerMm.z]);
      return { ...state, ...invalidateDerivedRun(state), scene: [...state.scene, { id: identity.id, name: identity.name, kind: "fixture", region: "fixture", tool: "T1", sourcePath: action.path, sourceDimensionsMm: action.dimensionsMm, sourceCenterMm: action.centerMm, vertices: centeredVertices, faces: action.faces, dimensionsMm: action.dimensionsMm, transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: action.dimensionsMm }, visible: true }], ui: { ...state.ui, selectedSceneId: identity.id, selectedSceneIds: [identity.id], sceneIdentityCounters: identity.sceneIdentityCounters, toast: `Imported ${action.format.toUpperCase()} mesh · ${action.vertices.length} vertices · validate before generation` } };
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
