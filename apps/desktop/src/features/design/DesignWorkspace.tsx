import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { unzipSync } from "fflate";
import { useProject } from "../../state/ProjectContext";
import { Button, Disclosure, FieldRow, IconButton, NumberField, SelectField, SectionHeading, StatusBadge } from "../../components/ui";
import { Icon } from "../../components/icons";
import { DesignViewport } from "../../components/visuals";
import { AppStatusBar, RailHeader } from "../shell/Shell";
import type { SceneObject, SceneTransformMode, Vec3 } from "../../types";
import { authorizeNativePath, isNativeRuntime } from "../../services/projectDocument";

const axes = ["x", "y", "z"] as const;

type SolidMesh = { vertices: number[][]; faces: number[][]; dimensionsMm: Vec3; centerMm: Vec3 };

function meshBounds(vertices: number[][]) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  vertices.forEach((vertex) => vertex.forEach((value, axis) => { min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value); }));
  return {
    dimensionsMm: { x: Math.max(0.001, max[0] - min[0]), y: Math.max(0.001, max[1] - min[1]), z: Math.max(0.001, max[2] - min[2]) },
    centerMm: { x: (min[0] + max[0]) / 2, y: (min[1] + max[1]) / 2, z: (min[2] + max[2]) / 2 },
  };
}

function parseStl(bytes: Uint8Array): SolidMesh {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const binaryCount = bytes.byteLength >= 84 ? view.getUint32(80, true) : 0;
  const isBinary = bytes.byteLength >= 84 && 84 + binaryCount * 50 <= bytes.byteLength;
  const vertices: number[][] = [];
  const faces: number[][] = [];
  const indexFor = new Map<string, number>();
  const add = (vertex: number[]) => { const key = vertex.map((value) => value.toPrecision(12)).join(","); const existing = indexFor.get(key); if (existing !== undefined) return existing; const index = vertices.length; vertices.push(vertex); indexFor.set(key, index); return index; };
  if (isBinary) {
    for (let triangle = 0; triangle < binaryCount; triangle += 1) {
      const offset = 84 + triangle * 50 + 12;
      const face = [0, 1, 2].map((index) => add([view.getFloat32(offset + index * 12, true), view.getFloat32(offset + index * 12 + 4, true), view.getFloat32(offset + index * 12 + 8, true)]));
      faces.push(face);
    }
  } else {
    const text = new TextDecoder().decode(bytes);
    const matches = [...text.matchAll(/vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g)];
    for (let index = 0; index + 2 < matches.length; index += 3) faces.push([0, 1, 2].map((vertex) => add(matches[index + vertex].slice(1, 4).map(Number))));
  }
  if (!vertices.length || !faces.length) throw new Error("STL did not contain a triangular mesh");
  return { vertices, faces, ...meshBounds(vertices) };
}

const identity3mfTransform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

function parse3mfTransform(value: string | null): number[] {
  if (!value) return identity3mfTransform;
  const transform = value.trim().split(/\s+/).map(Number);
  if (transform.length !== 12 || transform.some((item) => !Number.isFinite(item))) throw new Error("3MF transform must contain 12 finite values");
  return transform;
}

function apply3mfTransform(vertex: number[], transform: number[]): number[] {
  const [x, y, z] = vertex;
  return [
    x * transform[0] + y * transform[3] + z * transform[6] + transform[9],
    x * transform[1] + y * transform[4] + z * transform[7] + transform[10],
    x * transform[2] + y * transform[5] + z * transform[8] + transform[11],
  ];
}

export function parse3mf(bytes: Uint8Array): SolidMesh {
  const files = unzipSync(bytes);
  const modelName = Object.keys(files).find((name) => /(^|\/)3dmodel\.model$/i.test(name));
  if (!modelName) throw new Error("3MF archive does not contain 3D/3dmodel.model");
  const xml = new DOMParser().parseFromString(new TextDecoder().decode(files[modelName]), "application/xml");
  if (xml.querySelector("parsererror")) throw new Error("3MF model XML is invalid");
  const unitScale = ({ micron: 0.001, millimeter: 1, centimeter: 10, meter: 1000, inch: 25.4, foot: 304.8 } as Record<string, number>)[xml.documentElement.getAttribute("unit") ?? "millimeter"];
  if (!unitScale) throw new Error(`Unsupported 3MF unit: ${xml.documentElement.getAttribute("unit")}`);
  const objects = new Map([...xml.querySelectorAll("resources > object")].map((node) => [node.getAttribute("id") ?? "", node]));
  const vertices: number[][] = [];
  const faces: number[][] = [];
  const appendObject = (id: string, transforms: number[][], resolving = new Set<string>()) => {
    if (resolving.has(id)) throw new Error(`3MF component graph is cyclic at object ${id}`);
    const object = objects.get(id);
    if (!object) throw new Error(`3MF build references missing object ${id}`);
    const nextResolving = new Set(resolving).add(id);
    const mesh = object.querySelector(":scope > mesh");
    if (mesh) {
      const offset = vertices.length;
      for (const node of mesh.querySelectorAll("vertices > vertex")) {
        const raw = [Number(node.getAttribute("x")), Number(node.getAttribute("y")), Number(node.getAttribute("z"))];
        if (raw.some((item) => !Number.isFinite(item))) throw new Error(`3MF object ${id} contains a non-finite vertex`);
        vertices.push(transforms.reduce((value, transform) => apply3mfTransform(value, transform), raw).map((value) => value * unitScale));
      }
      for (const node of mesh.querySelectorAll("triangles > triangle")) {
        const face = [Number(node.getAttribute("v1")), Number(node.getAttribute("v2")), Number(node.getAttribute("v3"))];
        if (face.some((item) => !Number.isInteger(item) || item < 0 || item >= vertices.length - offset)) throw new Error(`3MF object ${id} contains an invalid triangle index`);
        faces.push(face.map((item) => item + offset));
      }
      return;
    }
    const components = [...object.querySelectorAll(":scope > components > component")];
    if (!components.length) throw new Error(`3MF object ${id} contains neither a mesh nor components`);
    components.forEach((component) => appendObject(component.getAttribute("objectid") ?? "", [parse3mfTransform(component.getAttribute("transform")), ...transforms], nextResolving));
  };
  const buildItems = [...xml.querySelectorAll("build > item")];
  if (buildItems.length) buildItems.forEach((item) => appendObject(item.getAttribute("objectid") ?? "", [parse3mfTransform(item.getAttribute("transform"))]));
  else objects.forEach((_object, id) => appendObject(id, [identity3mfTransform]));
  if (!vertices.length || !faces.length || vertices.some((vertex) => vertex.some((value) => !Number.isFinite(value)))) throw new Error("3MF model did not contain finite vertices and triangles");
  return { vertices, faces, ...meshBounds(vertices) };
}

export async function readSolid(path: string, format: "stl" | "3mf"): Promise<SolidMesh> {
  const raw = await invoke<number[] | Uint8Array>("read_authorized_binary_file", { path });
  const bytes = raw instanceof Uint8Array ? raw : Uint8Array.from(raw);
  return format === "3mf" ? parse3mf(bytes) : parseStl(bytes);
}

export function DesignWorkspace() {
  const { state, dispatch, sidecar, undoSceneEdit, redoSceneEdit, canUndoSceneEdit, canRedoSceneEdit } = useProject();
  const [transformOpen, setTransformOpen] = useState(true);
  const [ownershipOpen, setOwnershipOpen] = useState(true);
  const [booleanOpen, setBooleanOpen] = useState(true);
  const [transformMode, setTransformMode] = useState<SceneTransformMode>("translate");
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [gridVisible, setGridVisible] = useState(true);
  const [fitVersion, setFitVersion] = useState(0);
  const [fitTargetId, setFitTargetId] = useState<string>();
  const [renameId, setRenameId] = useState<string>();
  const [renameDraft, setRenameDraft] = useState("");
  const renameCancelled = useRef(false);
  const clipboard = useRef<SceneObject[]>([]);
  const rangeAnchorId = useRef<string | undefined>(undefined);
  const previousSceneCount = useRef(state.scene.length);
  const selectedIds = useMemo(() => (state.ui.selectedSceneIds ?? [state.ui.selectedSceneId]).filter((id, index, ids) => Boolean(id) && ids.indexOf(id) === index && state.scene.some((object) => object.id === id)), [state.scene, state.ui.selectedSceneId, state.ui.selectedSceneIds]);
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedObjects = useMemo(() => selectedIds.map((id) => state.scene.find((object) => object.id === id)).filter((object): object is SceneObject => Boolean(object)), [selectedIds, state.scene]);
  const selected = useMemo(() => state.scene.find((object) => object.id === state.ui.selectedSceneId && selectedIdSet.has(object.id)) ?? selectedObjects[0], [selectedIdSet, selectedObjects, state.scene, state.ui.selectedSceneId]);
  const editableSelected = useMemo(() => selectedObjects.filter((object) => object.kind !== "dicom" && !object.locked), [selectedObjects]);
  const groupedSelection = useMemo(() => [...new Set(selectedObjects.map((object) => object.groupId).filter((id): id is string => Boolean(id)))], [selectedObjects]);
  const selectedCalibration = state.calibrations.find((profile) => profile.accepted && profile.tool === selected?.tool);
  const selectedTargetHu = selected?.targetHu ?? selectedCalibration?.huSamples[Math.floor((selectedCalibration?.huSamples.length ?? 1) / 2)]?.targetHu ?? 0;
  const hydrationAttempts = useRef(new Set<string>());
  useEffect(() => {
    if (!isNativeRuntime()) return;
    const pending = state.scene.find((object) => object.sourcePath && !object.sourcePath.startsWith("synthetic://") && (!object.vertices?.length || !object.faces?.length) && !hydrationAttempts.current.has(object.id));
    if (!pending?.sourcePath) return;
    hydrationAttempts.current.add(pending.id);
    const format = pending.sourcePath.toLowerCase().endsWith(".3mf") ? "3mf" : "stl";
    void readSolid(pending.sourcePath, format)
      .then((mesh) => dispatch({ type: "HYDRATE_IMPORTED_SOLID", id: pending.id, ...mesh }))
      .catch((error) => dispatch({ type: "SET_TOAST", message: error instanceof Error ? `Mesh preview unavailable: ${error.message}` : "Mesh preview unavailable" }));
  }, [dispatch, state.scene]);
  const expandGroupSelection = (ids: readonly string[]) => {
    const expanded = new Set(ids.filter((id) => state.scene.some((object) => object.id === id)));
    let changed = true;
    while (changed) {
      changed = false;
      const groupIds = new Set(state.scene.filter((object) => expanded.has(object.id) && object.groupId).map((object) => object.groupId));
      state.scene.forEach((object) => {
        if (object.groupId && groupIds.has(object.groupId) && !expanded.has(object.id)) {
          expanded.add(object.id);
          changed = true;
        }
      });
    }
    return state.scene.filter((object) => expanded.has(object.id)).map((object) => object.id);
  };
  const setSelections = (ids: string[], primaryId?: string) => {
    const expandedIds = expandGroupSelection(ids);
    dispatch({ type: "SET_SCENE_SELECTIONS", ids: expandedIds, primaryId: primaryId && expandedIds.includes(primaryId) ? primaryId : expandedIds[0] });
  };
  const choose = (id: string, additive = false, range = false) => {
    if (range && rangeAnchorId.current) {
      const start = state.scene.findIndex((object) => object.id === rangeAnchorId.current);
      const end = state.scene.findIndex((object) => object.id === id);
      if (start >= 0 && end >= 0) {
        const ids = state.scene.slice(Math.min(start, end), Math.max(start, end) + 1).map((object) => object.id);
        setSelections(ids, id);
        return;
      }
    }
    rangeAnchorId.current = id;
    const clicked = state.scene.find((object) => object.id === id);
    const targetIds = clicked?.groupId ? state.scene.filter((object) => object.groupId === clicked.groupId).map((object) => object.id) : [id];
    if (!additive) { setSelections(targetIds, id); return; }
    const allSelected = targetIds.every((targetId) => selectedIdSet.has(targetId));
    const ids = allSelected ? selectedIds.filter((selectedId) => !targetIds.includes(selectedId)) : [...new Set([...selectedIds, ...targetIds])];
    setSelections(ids, ids.includes(id) ? id : ids[0]);
  };
  const clearSelection = () => setSelections([]);
  const transformLocked = !selected || selectedObjects.some((object) => object.kind === "dicom" || object.locked);
  const setMode = (mode: SceneTransformMode) => {
    setTransformMode(mode);
    dispatch({ type: "SET_TOAST", message: mode === "translate" ? "Move tool · 0.5 mm snapping" : mode === "rotate" ? "Rotate tool · 15° snapping" : "Scale tool · 5% snapping" });
  };
  const fitView = (targetId?: string) => {
    const target = targetId ? state.scene.find((object) => object.id === targetId && object.visible) : undefined;
    setFitTargetId(target?.id);
    setFitVersion((value) => value + 1);
  };
  useEffect(() => {
    if (previousSceneCount.current === state.scene.length) return;
    previousSceneCount.current = state.scene.length;
    setFitTargetId(undefined);
    setFitVersion((value) => value + 1);
  }, [state.scene.length]);
  const commitTransform = (id: string, transform: SceneObject["transform"]) => {
    const source = state.scene.find((object) => object.id === id);
    if (!source || source.kind === "dicom" || source.locked) return;
    if (editableSelected.length <= 1 || !selectedIdSet.has(id)) { dispatch({ type: "SET_SCENE_TRANSFORM", id, transform }); return; }
    const ratio = { x: transform.scale.x / source.transform.scale.x, y: transform.scale.y / source.transform.scale.y, z: transform.scale.z / source.transform.scale.z };
    const positionDelta = { x: transform.position.x - source.transform.position.x, y: transform.position.y - source.transform.position.y, z: transform.position.z - source.transform.position.z };
    const rotationDelta = { x: transform.rotation.x - source.transform.rotation.x, y: transform.rotation.y - source.transform.rotation.y, z: transform.rotation.z - source.transform.rotation.z };
    const pivot = selectionPivot(editableSelected);
    dispatch({ type: "SET_SCENE_TRANSFORMS", transforms: editableSelected.map((object) => ({ id: object.id, transform: {
      position: rigidGroupPosition(object.transform.position, pivot, ratio, rotationDelta, positionDelta),
      rotation: { x: object.transform.rotation.x + rotationDelta.x, y: object.transform.rotation.y + rotationDelta.y, z: object.transform.rotation.z + rotationDelta.z },
      scale: { x: object.transform.scale.x * ratio.x, y: object.transform.scale.y * ratio.y, z: object.transform.scale.z * ratio.z },
    } })) });
  };
  const centerSelection = () => {
    if (!editableSelected.length) return;
    const pivot = selectionPivot(editableSelected);
    const delta = { x: -pivot.x, y: -pivot.y, z: 0 };
    dispatch({ type: "SET_SCENE_TRANSFORMS", transforms: editableSelected.map((object) => ({ id: object.id, transform: { position: rigidGroupPosition(object.transform.position, pivot, { x: 1, y: 1, z: 1 }, { x: 0, y: 0, z: 0 }, delta) } })) });
  };
  const nudgeSelection = (axis: keyof Vec3, amount: number) => {
    if (!editableSelected.length) return;
    dispatch({ type: "SET_SCENE_TRANSFORMS", transforms: editableSelected.map((object) => ({ id: object.id, transform: { position: { ...object.transform.position, [axis]: Number((object.transform.position[axis] + amount).toFixed(3)) } } })) });
  };
  const handleViewportKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey) return;
    const key = event.key.toLowerCase();
    if (key === "w" || key === "m") { event.preventDefault(); setMode("translate"); return; }
    if (key === "e") { event.preventDefault(); setMode("rotate"); return; }
    if (key === "r" || key === "s") { event.preventDefault(); setMode("scale"); return; }
    if (key === "f") { event.preventDefault(); fitView(event.shiftKey ? undefined : selected?.id); return; }
    if (key === "g") { event.preventDefault(); setGridVisible((value) => !value); return; }
    const amount = event.shiftKey ? 5 : 0.5;
    const command = event.key === "ArrowLeft" ? ["x", -amount] : event.key === "ArrowRight" ? ["x", amount] : event.key === "ArrowDown" ? ["y", -amount] : event.key === "ArrowUp" ? ["y", amount] : event.key === "PageDown" ? ["z", -amount] : event.key === "PageUp" ? ["z", amount] : undefined;
    if (command) { event.preventDefault(); nudgeSelection(command[0] as keyof Vec3, command[1] as number); }
  };
  const duplicateSelection = () => dispatch({ type: "DUPLICATE_SCENE_OBJECTS", ids: selectedIds, offset: { x: 10, y: 10, z: 0 } });
  const copySelection = () => {
    clipboard.current = editableSelected.map((object) => structuredClone(object));
    dispatch({ type: "SET_TOAST", message: clipboard.current.length ? `Copied ${clipboard.current.length} structure${clipboard.current.length === 1 ? "" : "s"}` : "Nothing editable to copy" });
  };
  const pasteSelection = () => dispatch({ type: "INSERT_SCENE_OBJECTS", objects: clipboard.current, offset: { x: 10, y: 10, z: 0 } });
  const deleteSelection = () => dispatch({ type: "DELETE_SCENE_OBJECTS", ids: selectedIds });
  const groupSelection = () => dispatch({ type: "GROUP_SCENE_OBJECTS", ids: editableSelected.map((object) => object.id) });
  const ungroupSelection = () => dispatch({ type: "UNGROUP_SCENE_OBJECTS", ids: selectedIds });
  const toggleSelectionLock = () => {
    const modeled = selectedObjects.filter((object) => object.kind !== "dicom");
    const shouldUnlock = modeled.length > 0 && modeled.every((object) => object.locked);
    dispatch({ type: "SET_SCENE_LOCKED", ids: modeled.map((object) => object.id), locked: !shouldUnlock });
  };
  const alignSelection = (value: string) => {
    const [axis, mode] = value.split(":") as ["x" | "y" | "z", "min" | "center" | "max"];
    if (axis && mode) dispatch({ type: "ALIGN_SCENE_OBJECTS", ids: editableSelected.map((object) => object.id), axis, mode, anchorId: selected?.id });
  };
  const beginRename = (object: SceneObject) => { if (object.kind === "dicom" || object.locked) return; renameCancelled.current = false; setRenameId(object.id); setRenameDraft(object.name); };
  const commitRename = (id = renameId, name = renameDraft) => { if (!renameCancelled.current && id) dispatch({ type: "RENAME_SCENE_OBJECT", id, name }); renameCancelled.current = false; setRenameId(undefined); };
  const cancelRename = () => { renameCancelled.current = true; setRenameId(undefined); };
  useEffect(() => {
    const handleEditorShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      const command = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (command && key === "a") { event.preventDefault(); const ids = state.scene.filter((object) => object.kind !== "dicom" && object.visible).map((object) => object.id); setSelections(ids, ids[0]); return; }
      if (command && key === "c") { event.preventDefault(); copySelection(); return; }
      if (command && key === "v") { event.preventDefault(); pasteSelection(); return; }
      if (command && key === "d") { event.preventDefault(); duplicateSelection(); return; }
      if (command && key === "g") { event.preventDefault(); event.shiftKey ? ungroupSelection() : groupSelection(); return; }
      if (command && key === "z") { event.preventDefault(); event.shiftKey ? redoSceneEdit() : undoSceneEdit(); return; }
      if (key === "delete" || key === "backspace") { event.preventDefault(); deleteSelection(); return; }
      if (key === "escape") { event.preventDefault(); clearSelection(); return; }
      if (!command && key === "l") { event.preventDefault(); toggleSelectionLock(); }
    };
    window.addEventListener("keydown", handleEditorShortcut);
    return () => window.removeEventListener("keydown", handleEditorShortcut);
  });
  const toggleVisibility = (object: SceneObject) => {
    if (object.visible && selectedIdSet.has(object.id)) {
      const hiddenSelection = new Set(expandGroupSelection([object.id]));
      const remaining = selectedIds.filter((id) => !hiddenSelection.has(id));
      const replacement = state.scene.find((candidate) => !hiddenSelection.has(candidate.id) && candidate.visible && !remaining.includes(candidate.id));
      setSelections(remaining.length ? remaining : replacement ? [replacement.id] : [], remaining[0] ?? replacement?.id);
    }
    dispatch({ type: "TOGGLE_SCENE_VISIBILITY", id: object.id });
  };
  const handleSceneRowKey = (event: ReactKeyboardEvent<HTMLDivElement>, index: number, id: string) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(id, event.metaKey || event.ctrlKey, event.shiftKey); return; }
    const nextIndex = event.key === "ArrowDown" ? Math.min(state.scene.length - 1, index + 1) : event.key === "ArrowUp" ? Math.max(0, index - 1) : -1;
    if (nextIndex >= 0) { event.preventDefault(); choose(state.scene[nextIndex].id); (event.currentTarget.parentElement?.children[nextIndex] as HTMLElement | undefined)?.focus(); }
  };
  const importSolid = async () => {
    if (!isNativeRuntime()) { dispatch({ type: "SET_TOAST", message: "The browser adapter records import intent only" }); return; }
    try {
      const selectedPath = await open({ directory: false, multiple: false, title: "Import validated solid", filters: [{ name: "Solid", extensions: ["stl", "3mf"] }] });
      if (typeof selectedPath !== "string") return;
      await authorizeNativePath(selectedPath);
      const format = selectedPath.toLowerCase().endsWith(".3mf") ? "3mf" : "stl";
      const mesh = await readSolid(selectedPath, format);
      dispatch({ type: "SET_IMPORTED_SOLID", path: selectedPath, format, ...mesh });
      const centeredVertices = mesh.vertices.map((vertex) => [vertex[0] - mesh.centerMm.x, vertex[1] - mesh.centerMm.y, vertex[2] - mesh.centerMm.z]);
      const validation = await sidecar.validateScene({ ...state, scene: [...state.scene, { id: "import-pending", name: "Imported solid", kind: "fixture", region: "fixture", tool: "T1", sourcePath: selectedPath, sourceCenterMm: mesh.centerMm, sourceDimensionsMm: mesh.dimensionsMm, dimensionsMm: mesh.dimensionsMm, vertices: centeredVertices, faces: mesh.faces, transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: mesh.dimensionsMm }, visible: true }] });
      dispatch({ type: "SET_TOAST", message: validation.valid ? `Validated ${format.toUpperCase()} import` : validation.messages.join(" · ") });
    } catch (error) { dispatch({ type: "SET_TOAST", message: error instanceof Error ? error.message : "Solid import failed" }); }
  };
  const boolean = (operation: "union" | "subtract" | "intersect") => dispatch({ type: "BOOLEAN_SCENE", operation, operandIds: editableSelected.filter((object) => object.visible).map((object) => object.id) });

  return <div className="workspace-layout design-layout">
    <aside className="left-rail" aria-label="Scene rail">
      <RailHeader title="Scene" action="plus" actionLabel="Add primitive" onAction={() => dispatch({ type: "ADD_PRIMITIVE", kind: "box" })} />
      <div className="rail-subline"><span>{state.scene.length} objects · {selectedIds.length} selected</span><IconButton label="Select every editable structure (⌘A)" icon="more" size={16} onClick={() => { const ids = state.scene.filter((object) => object.kind !== "dicom").map((object) => object.id); setSelections(ids, ids[0]); }} /></div>
      <div className="scene-tree" role="tree" aria-label="Scene objects" aria-multiselectable="true">
        {state.scene.map((object, index) => <div key={object.id} className={`scene-row ${selectedIdSet.has(object.id) ? "selected" : ""} ${selected?.id === object.id ? "primary-selection" : ""} ${object.locked || object.kind === "dicom" ? "locked" : ""}`} role="treeitem" aria-selected={selectedIdSet.has(object.id)} aria-keyshortcuts="Delete Meta+D Meta+G" onClick={(event) => choose(object.id, event.metaKey || event.ctrlKey, event.shiftKey)} onDoubleClick={() => beginRename(object)} tabIndex={selected?.id === object.id || (!selected && index === 0) ? 0 : -1} data-testid={`scene-row-${object.id}`} onKeyDown={(event) => handleSceneRowKey(event, index, object.id)}>
          <Icon name={object.kind === "dicom" ? "dicom" : object.groupId ? "group" : "cube"} size={16} />{renameId === object.id ? <input className="scene-name-input" aria-label={`Rename ${object.name}`} autoFocus value={renameDraft} onClick={(event) => event.stopPropagation()} onChange={(event) => setRenameDraft(event.target.value)} onBlur={(event) => commitRename(object.id, event.currentTarget.value)} onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { cancelRename(); event.currentTarget.blur(); } }} /> : <span>{object.name}</span>}{(object.locked || object.kind === "dicom") && <Icon name="lock" size={13} />}<button type="button" className="row-eye" aria-label={`${object.visible ? "Hide" : "Show"} ${object.name}`} aria-pressed={!object.visible} onClick={(event) => { event.stopPropagation(); toggleVisibility(object); }}><Icon name={object.visible ? "eye" : "eyeOff"} size={15} /></button>
        </div>)}
      </div>
      <div className="rail-divider" />
      <SectionHeading action={<StatusBadge tone="ready" icon="check">valid</StatusBadge>}>Ownership</SectionHeading>
      <div className="ownership-list"><div><span className="ownership-swatch t0" />T0 · Natural PLA</div><div><span className="ownership-swatch t1" />T1 · White PLA</div><p>Ambiguous overlap: none</p></div>
      <div className="rail-bottom"><Button variant="quiet" icon="scan" onClick={() => dispatch({ type: "SET_WORKSPACE", workspace: "dicom" })}>Inspect DICOM source</Button></div>
    </aside>

    <section className="workspace-center design-center" aria-labelledby="design-heading">
      <div className="center-toolbar"><div><span className="workspace-kicker">PARAMETRIC GEOMETRY + SOURCE</span><h1 id="design-heading">Design</h1></div><div className="tool-group" aria-label="Transform tools"><IconButton label="Move selection" icon="move" aria-pressed={transformMode === "translate"} disabled={transformLocked} onClick={() => setMode("translate")} /><IconButton label="Rotate selection" icon="rotate" aria-pressed={transformMode === "rotate"} disabled={transformLocked} onClick={() => setMode("rotate")} /><IconButton label="Scale selection" icon="scale" aria-pressed={transformMode === "scale"} disabled={transformLocked} onClick={() => setMode("scale")} /><IconButton label="Toggle transform snapping" icon="lock" aria-pressed={snapEnabled} disabled={transformLocked} onClick={() => setSnapEnabled((value) => !value)} /><span className="toolbar-separator" /><IconButton label="Undo scene edit" title="Undo scene edit (⌘Z)" aria-keyshortcuts="Meta+Z" icon="stepBack" disabled={!canUndoSceneEdit} onClick={undoSceneEdit} /><IconButton label="Redo scene edit" title="Redo scene edit (⇧⌘Z)" aria-keyshortcuts="Meta+Shift+Z" icon="stepForward" disabled={!canRedoSceneEdit} onClick={redoSceneEdit} /><IconButton label="Center selection on XY origin" icon="target" disabled={transformLocked} onClick={centerSelection} /><IconButton label="Focus selection in view" icon="fit" disabled={!selected} onClick={() => fitView(selected?.id)} /><IconButton label="Fit entire scene" icon="scan" onClick={() => fitView()} /><IconButton label="Toggle grid" icon="grid" aria-pressed={gridVisible} onClick={() => setGridVisible((value) => !value)} /></div></div>
      <div className="selection-action-bar" role="toolbar" aria-label="Object actions" data-testid="selection-action-bar"><span className="selection-count" aria-live="polite">{selectedIds.length ? `${selectedIds.length} selected` : "No selection"}</span><Button variant="secondary" icon="copy" disabled={!editableSelected.length} onClick={duplicateSelection} title="Duplicate (⌘D)">Duplicate</Button><Button variant="secondary" icon={groupedSelection.length ? "ungroup" : "group"} disabled={groupedSelection.length ? false : editableSelected.length < 2} onClick={groupedSelection.length ? ungroupSelection : groupSelection}>{groupedSelection.length ? "Ungroup" : "Group"}</Button><label className="align-control"><Icon name="align" size={15} /><span>Align</span><select aria-label="Align selected structures" defaultValue="" disabled={editableSelected.length < 2} onChange={(event) => { if (event.target.value) alignSelection(event.target.value); event.target.value = ""; }}><option value="" disabled>Align</option><option value="x:min">Left on X</option><option value="x:center">Center on X</option><option value="x:max">Right on X</option><option value="y:min">Front on Y</option><option value="y:center">Center on Y</option><option value="y:max">Back on Y</option><option value="z:min">Bottom on Z</option><option value="z:center">Center on Z</option><option value="z:max">Top on Z</option></select></label><Button variant="secondary" icon={selectedObjects.length > 0 && selectedObjects.filter((object) => object.kind !== "dicom").every((object) => object.locked) ? "unlock" : "lock"} disabled={!selectedObjects.some((object) => object.kind !== "dicom")} onClick={toggleSelectionLock}>{selectedObjects.length > 0 && selectedObjects.filter((object) => object.kind !== "dicom").every((object) => object.locked) ? "Unlock" : "Lock"}</Button><Button variant="danger" icon="trash" disabled={!selectedIds.length} onClick={deleteSelection} title="Delete (Delete)">Delete</Button></div>
      <div className="canvas-toolbar"><div className="canvas-command-group"><Button variant="secondary" icon="plus" onClick={() => dispatch({ type: "ADD_PRIMITIVE", kind: "box" })}>Box</Button><Button variant="secondary" icon="cube" onClick={() => dispatch({ type: "ADD_PRIMITIVE", kind: "cylinder" })}>Cylinder</Button><Button variant="secondary" icon="design" onClick={() => dispatch({ type: "ADD_PRIMITIVE", kind: "wedge" })}>Wedge</Button><Button variant="secondary" icon="design" onClick={() => dispatch({ type: "ADD_PRIMITIVE", kind: "polygon-prism" })}>Polygon prism</Button><Button variant="secondary" icon="design" onClick={() => dispatch({ type: "ADD_PRIMITIVE", kind: "extrusion" })}>Extrusion</Button></div><div className="canvas-command-group boolean-command-group"><Button variant="quiet" icon="union" disabled={editableSelected.filter((object) => object.visible).length < 2} onClick={() => boolean("union")}>Union</Button><Button variant="quiet" icon="subtract" disabled={editableSelected.filter((object) => object.visible).length < 2} onClick={() => boolean("subtract")}>Subtract</Button><Button variant="quiet" icon="intersect" disabled={editableSelected.filter((object) => object.visible).length < 2} onClick={() => boolean("intersect")}>Intersect</Button></div><span className="toolbar-spacer" /><Button variant="quiet" icon="upload" onClick={() => void importSolid()}>Import STL / 3MF</Button></div>
      <DesignViewport selectedId={selected?.id ?? ""} selectedIds={selectedIds} mode={transformMode} snapEnabled={snapEnabled} gridVisible={gridVisible} fitVersion={fitVersion} fitTargetId={fitTargetId} onSelect={(id, additive) => choose(id, additive)} onClearSelection={clearSelection} onTransformCommit={commitTransform} onKeyboardCommand={handleViewportKey} scene={state.scene} />
      <div className="canvas-caption"><span><Icon name="info" size={14} />Interactive preview · canonical validation remains a sidecar responsibility</span><span>{snapEnabled ? "Snap on" : "Free transform"} · physical mm</span></div>
    </section>

    <aside className="right-inspector" aria-label="Design inspector">
      <div className="inspector-title"><div><span className="workspace-kicker">ACTIVE SELECTION</span><h2>{selectedIds.length > 1 ? `${selectedIds.length} structures selected` : selected?.name ?? "No selection"}</h2></div><IconButton label="Inspector options" icon="more" size={17} onClick={() => dispatch({ type: "SET_TOAST", message: "Use Shift-click or ⌘-click to build a selection" })} /></div>
      {selectedIds.length > 1 && <div className="batch-action-panel"><span>Batch actions</span><Button variant="secondary" icon="copy" onClick={duplicateSelection}>Duplicate</Button><Button variant="secondary" icon="lock" onClick={toggleSelectionLock}>Lock</Button><Button variant="danger" icon="trash" onClick={deleteSelection}>Delete</Button></div>}
      {!selected && <div className="empty-selection-panel"><Icon name="cube" size={24} /><strong>Select a structure</strong><span>Click an object, or Shift-click to edit several together.</span><div><kbd>⌘A</kbd> Select all <kbd>⌘V</kbd> Paste</div></div>}
      {selected && selectedIds.length === 1 && selected.kind !== "dicom" && <div className="rename-panel"><label htmlFor="selected-object-name">Structure name</label><input key={`${selected.id}:${selected.name}`} id="selected-object-name" defaultValue={selected.name} onBlur={(event) => commitRename(selected.id, event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { event.currentTarget.value = selected.name; cancelRename(); event.currentTarget.blur(); } }} disabled={selected.locked} /></div>}
      {selected && <Disclosure title={selectedIds.length > 1 ? "Transform primary" : "Transform"} open={transformOpen} onToggle={() => setTransformOpen((open) => !open)}>{selected.kind === "dicom" || selected.locked ? <div className="locked-transform-note"><Icon name="lock" size={16} /><div><strong>{selected.kind === "dicom" ? "Source geometry locked" : "Structure locked"}</strong><span>{selected.kind === "dicom" ? "DICOM position, orientation, and physical size come from patient coordinates." : "Unlock this structure before moving, rotating, or resizing it."}</span><code>{formatVector(selected.dimensionsMm ?? selected.transform.scale)} mm</code></div></div> : <div className="inspector-fields"><TransformRow label="Position" unit="mm" step={0.5} value={selected.transform.position} onChange={(position) => commitTransform(selected.id, { ...selected.transform, position })} /><TransformRow label="Rotation" unit="°" step={1} value={selected.transform.rotation} onChange={(rotation) => commitTransform(selected.id, { ...selected.transform, rotation })} /><TransformRow label="Size" unit="mm" step={0.5} min={0.001} value={selected.transform.scale} onChange={(scale) => commitTransform(selected.id, { ...selected.transform, scale })} />{selected.sourceDimensionsMm && <div className="source-size-readout"><span>Source mesh</span><code>{formatVector(selected.sourceDimensionsMm)} mm</code></div>}</div>}</Disclosure>}
      <Disclosure title="Region and tool" open={ownershipOpen} onToggle={() => setOwnershipOpen((open) => !open)}><SelectField label="Region" value={selected?.region ?? "measurement"} onChange={(event) => selected && dispatch({ type: "SET_SCENE_OWNERSHIP", id: selected.id, region: event.target.value as SceneObject["region"] })}><option value="measurement">Measurement</option><option value="support">Support</option><option value="fixture">Fixture</option></SelectField><SelectField label="Tool" value={selected?.tool ?? "T0"} onChange={(event) => selected && dispatch({ type: "SET_SCENE_OWNERSHIP", id: selected.id, tool: event.target.value as SceneObject["tool"] })}><option value="T0">T0 · Natural PLA</option><option value="T1">T1 · White PLA</option></SelectField>{selected && selected.kind !== "dicom" && <NumberField label="Target HU" value={selectedTargetHu} step={1} onChange={(targetHu) => dispatch({ type: "SET_SCENE_TARGET_HU", id: selected.id, targetHu })} />}</Disclosure>
      <Disclosure title="Boolean history" open={booleanOpen} onToggle={() => setBooleanOpen((open) => !open)}><div className="boolean-history">{state.scene.filter((object) => object.boolean).map((object, index) => <div key={object.id}><span className="history-index">{String(index + 1).padStart(2, "0")}</span><span>{object.name}</span><StatusBadge tone="neutral">{object.boolean?.operation}</StatusBadge></div>)}<p>Operands remain inspectable for canonical sidecar validation.</p></div></Disclosure>
      <div className="inspector-actions"><Button variant="primary" icon="check" onClick={async () => { const result = await sidecar.validateScene(state); dispatch({ type: "SET_TOAST", message: result.messages.join(" · ") || (result.valid ? "Scene validated" : "Scene validation failed") }); }}>Validate scene</Button><Button variant="quiet" icon="arrowUpRight" onClick={() => dispatch({ type: "SET_WORKSPACE", workspace: "dicom" })}>Continue to DICOM</Button></div>
    </aside>
    <AppStatusBar crosshair="origin 0.0, 0.0, 0.0 mm · physical coordinates" />
  </div>;
}

function formatVector(value: Vec3): string {
  return `${Number(value.x.toFixed(3))} × ${Number(value.y.toFixed(3))} × ${Number(value.z.toFixed(3))}`;
}

function selectionPivot(objects: SceneObject[]): Vec3 {
  if (!objects.length) return { x: 0, y: 0, z: 0 };
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  objects.forEach((object) => {
    const half = worldHalfExtents(object);
    min.x = Math.min(min.x, object.transform.position.x - half.x);
    min.y = Math.min(min.y, object.transform.position.y - half.y);
    min.z = Math.min(min.z, object.transform.position.z - half.z);
    max.x = Math.max(max.x, object.transform.position.x + half.x);
    max.y = Math.max(max.y, object.transform.position.y + half.y);
    max.z = Math.max(max.z, object.transform.position.z + half.z);
  });
  return {
    x: Number(((min.x + max.x) / 2).toFixed(4)),
    y: Number(((min.y + max.y) / 2).toFixed(4)),
    z: Number(((min.z + max.z) / 2).toFixed(4)),
  };
}

function worldHalfExtents(object: SceneObject): Vec3 {
  const dimensions = {
    x: Math.max(0, object.transform.scale.x),
    y: Math.max(0, object.transform.scale.y),
    z: Math.max(0, object.transform.scale.z),
  };
  const rotation = object.transform.rotation;
  const x = rotation.x * Math.PI / 180;
  const y = rotation.y * Math.PI / 180;
  const z = rotation.z * Math.PI / 180;
  const cx = Math.cos(x); const sx = Math.sin(x);
  const cy = Math.cos(y); const sy = Math.sin(y);
  const cz = Math.cos(z); const sz = Math.sin(z);
  const matrix = [
    [cy * cz, -cy * sz, sy],
    [cx * sz + sx * sy * cz, cx * cz - sx * sy * sz, -cy * sx],
    [sx * sz - cx * sy * cz, sx * cz + cx * sy * sz, cx * cy],
  ];
  return {
    x: Math.abs(matrix[0][0]) * dimensions.x / 2 + Math.abs(matrix[0][1]) * dimensions.y / 2 + Math.abs(matrix[0][2]) * dimensions.z / 2,
    y: Math.abs(matrix[1][0]) * dimensions.x / 2 + Math.abs(matrix[1][1]) * dimensions.y / 2 + Math.abs(matrix[1][2]) * dimensions.z / 2,
    z: Math.abs(matrix[2][0]) * dimensions.x / 2 + Math.abs(matrix[2][1]) * dimensions.y / 2 + Math.abs(matrix[2][2]) * dimensions.z / 2,
  };
}

export function rotateSceneVector(vector: Vec3, rotation: Vec3): Vec3 {
  const rx = rotation.x * Math.PI / 180;
  const ry = rotation.y * Math.PI / 180;
  const rz = rotation.z * Math.PI / 180;
  const cosX = Math.cos(rx);
  const sinX = Math.sin(rx);
  const cosY = Math.cos(ry);
  const sinY = Math.sin(ry);
  const cosZ = Math.cos(rz);
  const sinZ = Math.sin(rz);
  // Match THREE.Euler(..., "XYZ") exactly. Matrix multiplication applies
  // the vector's Z rotation first, followed by Y and X.
  return {
    x: (cosY * cosZ) * vector.x + (-cosY * sinZ) * vector.y + sinY * vector.z,
    y: (cosX * sinZ + sinX * sinY * cosZ) * vector.x + (cosX * cosZ - sinX * sinY * sinZ) * vector.y + (-cosY * sinX) * vector.z,
    z: (sinX * sinZ - cosX * sinY * cosZ) * vector.x + (sinX * cosZ + cosX * sinY * sinZ) * vector.y + (cosX * cosY) * vector.z,
  };
}

function rigidGroupPosition(position: Vec3, pivot: Vec3, ratio: Vec3, rotation: Vec3, translation: Vec3): Vec3 {
  const relative = {
    x: (position.x - pivot.x) * ratio.x,
    y: (position.y - pivot.y) * ratio.y,
    z: (position.z - pivot.z) * ratio.z,
  };
  const rotated = rotateSceneVector(relative, rotation);
  return {
    x: Number((pivot.x + rotated.x + translation.x).toFixed(4)),
    y: Number((pivot.y + rotated.y + translation.y).toFixed(4)),
    z: Number((pivot.z + rotated.z + translation.z).toFixed(4)),
  };
}

function TransformRow({ label, unit, value, step, min, onChange }: { label: string; unit: string; value?: Vec3; step: number; min?: number; onChange: (value: Vec3) => void }) {
  const resolved = value ?? { x: 0, y: 0, z: 0 };
  return <FieldRow label={label} hint={unit} className="transform-field-row"><div className="triple-inputs">{axes.map((axis) => <TransformAxisInput key={axis} label={`${label} ${axis}`} axis={axis} unit={unit} value={resolved[axis]} step={step} min={min} onCommit={(next) => onChange({ ...resolved, [axis]: next })} />)}</div></FieldRow>;
}

function TransformAxisInput({ label, axis, unit, value, step, min, onCommit }: { label: string; axis: typeof axes[number]; unit: string; value: number; step: number; min?: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(String(Number(value.toFixed(4))));
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setDraft(String(Number(value.toFixed(4)))); }, [value]);
  const commit = () => {
    editing.current = false;
    const parsed = Number(draft.trim());
    if (!Number.isFinite(parsed) || (min !== undefined && parsed < min)) { setDraft(String(Number(value.toFixed(4)))); return; }
    const normalized = Number(parsed.toFixed(4));
    setDraft(String(normalized));
    if (normalized !== value) onCommit(normalized);
  };
  return <label className="transform-axis"><span>{axis.toUpperCase()}</span><input aria-label={label} inputMode="decimal" type="text" value={draft} onFocus={(event) => { editing.current = true; event.currentTarget.select(); }} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); const parsed = Number(draft); setDraft(String(Number(((Number.isFinite(parsed) ? parsed : value) + (event.key === "ArrowUp" ? step : -step)).toFixed(4)))); } if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setDraft(String(Number(value.toFixed(4)))); event.currentTarget.blur(); } }} /><small>{unit}</small></label>;
}
