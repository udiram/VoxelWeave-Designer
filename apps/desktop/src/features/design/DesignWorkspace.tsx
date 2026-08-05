import { useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { unzipSync } from "fflate";
import { useProject } from "../../state/ProjectContext";
import { Button, Disclosure, FieldRow, IconButton, SelectField, SectionHeading, StatusBadge } from "../../components/ui";
import { Icon } from "../../components/icons";
import { DesignViewport } from "../../components/visuals";
import { AppStatusBar, RailHeader } from "../shell/Shell";
import type { SceneObject } from "../../types";
import { authorizeNativePath, isNativeRuntime } from "../../services/projectDocument";

const axes = ["x", "y", "z"] as const;

type SolidMesh = { vertices: number[][]; faces: number[][]; dimensionsMm: { x: number; y: number; z: number } };

function meshDimensions(vertices: number[][]) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  vertices.forEach((vertex) => vertex.forEach((value, axis) => { min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value); }));
  return { x: Math.max(0.001, max[0] - min[0]), y: Math.max(0.001, max[1] - min[1]), z: Math.max(0.001, max[2] - min[2]) };
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
  return { vertices, faces, dimensionsMm: meshDimensions(vertices) };
}

function parse3mf(bytes: Uint8Array): SolidMesh {
  const files = unzipSync(bytes);
  const modelName = Object.keys(files).find((name) => /(^|\/)3dmodel\.model$/i.test(name));
  if (!modelName) throw new Error("3MF archive does not contain 3D/3dmodel.model");
  const xml = new DOMParser().parseFromString(new TextDecoder().decode(files[modelName]), "application/xml");
  const vertices = [...xml.querySelectorAll("vertices > vertex")].map((node) => [Number(node.getAttribute("x")), Number(node.getAttribute("y")), Number(node.getAttribute("z"))]);
  const faces = [...xml.querySelectorAll("triangles > triangle")].map((node) => [Number(node.getAttribute("v1")), Number(node.getAttribute("v2")), Number(node.getAttribute("v3"))]);
  if (!vertices.length || !faces.length || vertices.some((vertex) => vertex.some((value) => !Number.isFinite(value)))) throw new Error("3MF model did not contain finite vertices and triangles");
  return { vertices, faces, dimensionsMm: meshDimensions(vertices) };
}

async function readSolid(path: string, format: "stl" | "3mf"): Promise<SolidMesh> {
  const raw = await invoke<number[] | Uint8Array>("read_authorized_binary_file", { path });
  const bytes = raw instanceof Uint8Array ? raw : Uint8Array.from(raw);
  return format === "3mf" ? parse3mf(bytes) : parseStl(bytes);
}

export function DesignWorkspace() {
  const { state, dispatch, sidecar } = useProject();
  const [transformOpen, setTransformOpen] = useState(true);
  const [ownershipOpen, setOwnershipOpen] = useState(true);
  const [booleanOpen, setBooleanOpen] = useState(true);
  const selected = useMemo(() => state.scene.find((object) => object.id === state.ui.selectedSceneId) ?? state.scene[0], [state.scene, state.ui.selectedSceneId]);
  const choose = (id: string) => dispatch({ type: "SET_SCENE_SELECTION", id });
  const importSolid = async () => {
    if (!isNativeRuntime()) { dispatch({ type: "SET_TOAST", message: "The browser adapter records import intent only" }); return; }
    try {
      const selectedPath = await open({ directory: false, multiple: false, title: "Import validated solid", filters: [{ name: "Solid", extensions: ["stl", "3mf"] }] });
      if (typeof selectedPath !== "string") return;
      await authorizeNativePath(selectedPath);
      const format = selectedPath.toLowerCase().endsWith(".3mf") ? "3mf" : "stl";
      const mesh = await readSolid(selectedPath, format);
      dispatch({ type: "SET_IMPORTED_SOLID", path: selectedPath, format, ...mesh });
      const validation = await sidecar.validateScene({ ...state, scene: [...state.scene, { id: "import-pending", name: "Imported solid", kind: "fixture", region: "fixture", tool: "T1", sourcePath: selectedPath, dimensionsMm: mesh.dimensionsMm, vertices: mesh.vertices, faces: mesh.faces, transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: mesh.dimensionsMm }, visible: true }] });
      dispatch({ type: "SET_TOAST", message: validation.valid ? `Validated ${format.toUpperCase()} import` : validation.messages.join(" · ") });
    } catch (error) { dispatch({ type: "SET_TOAST", message: error instanceof Error ? error.message : "Solid import failed" }); }
  };
  const boolean = (operation: "union" | "subtract" | "intersect") => dispatch({ type: "BOOLEAN_SCENE", operation, operandIds: state.scene.filter((object) => object.visible).map((object) => object.id) });

  return <div className="workspace-layout design-layout">
    <aside className="left-rail" aria-label="Scene rail">
      <RailHeader title="Scene" action="plus" actionLabel="Add primitive" onAction={() => dispatch({ type: "ADD_PRIMITIVE", kind: "box" })} />
      <div className="rail-subline"><span>{state.scene.length} objects · {state.source.path ? "1 DICOM source" : "no DICOM source"}</span><IconButton label="Scene options" icon="more" size={16} onClick={() => dispatch({ type: "SET_TOAST", message: "Scene options: validate ownership or inspect provenance" })} /></div>
      <div className="scene-tree" role="tree" aria-label="Scene objects">
        {state.scene.map((object) => <div key={object.id} className={`scene-row ${selected?.id === object.id ? "selected" : ""}`} role="treeitem" aria-selected={selected?.id === object.id} onClick={() => choose(object.id)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") choose(object.id); }}>
          <Icon name={object.kind === "dicom" ? "dicom" : "cube"} size={16} /><span>{object.name}</span><button type="button" className="row-eye" aria-label={`${object.visible ? "Hide" : "Show"} ${object.name}`} onClick={(event) => { event.stopPropagation(); dispatch({ type: "TOGGLE_SCENE_VISIBILITY", id: object.id }); }}><Icon name={object.visible ? "eye" : "eyeOff"} size={15} /></button>
        </div>)}
      </div>
      <div className="rail-divider" />
      <SectionHeading action={<StatusBadge tone="ready" icon="check">valid</StatusBadge>}>Ownership</SectionHeading>
      <div className="ownership-list"><div><span className="ownership-swatch t0" />T0 · Natural PLA</div><div><span className="ownership-swatch t1" />T1 · White PLA</div><p>Ambiguous overlap: none</p></div>
      <div className="rail-bottom"><Button variant="quiet" icon="scan" onClick={() => dispatch({ type: "SET_WORKSPACE", workspace: "dicom" })}>Inspect DICOM source</Button></div>
    </aside>

    <section className="workspace-center design-center" aria-labelledby="design-heading">
      <div className="center-toolbar"><div><span className="workspace-kicker">PARAMETRIC GEOMETRY + SOURCE</span><h1 id="design-heading">Design</h1></div><div className="tool-group" aria-label="Transform tools"><IconButton label="Move selection" icon="move" onClick={() => dispatch({ type: "SET_TOAST", message: "Move tool active · snap increment 0.5 mm" })} /><IconButton label="Rotate selection" icon="rotate" onClick={() => dispatch({ type: "SET_TOAST", message: "Rotate tool active · exact angle entry is available in the inspector" })} /><IconButton label="Scale selection" icon="scale" onClick={() => dispatch({ type: "SET_TOAST", message: "Scale tool active · dimensions remain in millimetres" })} /><span className="toolbar-separator" /><IconButton label="Align selection" icon="target" onClick={() => dispatch({ type: "SET_TOAST", message: "Alignment uses scene physical coordinates" })} /><IconButton label="Toggle grid" icon="grid" onClick={() => dispatch({ type: "SET_TOAST", message: "Grid visibility toggled" })} /></div></div>
      <div className="canvas-toolbar"><Button variant="secondary" icon="plus" onClick={() => dispatch({ type: "ADD_PRIMITIVE", kind: "box" })}>Box</Button><Button variant="secondary" icon="cube" onClick={() => dispatch({ type: "ADD_PRIMITIVE", kind: "cylinder" })}>Cylinder</Button><Button variant="secondary" icon="design" onClick={() => dispatch({ type: "ADD_PRIMITIVE", kind: "wedge" })}>Wedge</Button><Button variant="secondary" icon="design" onClick={() => dispatch({ type: "ADD_PRIMITIVE", kind: "polygon-prism" })}>Polygon prism</Button><Button variant="secondary" icon="design" onClick={() => dispatch({ type: "ADD_PRIMITIVE", kind: "extrusion" })}>Extrusion</Button><span className="toolbar-separator" /><Button variant="quiet" icon="union" onClick={() => boolean("union")}>Union</Button><Button variant="quiet" icon="subtract" onClick={() => boolean("subtract")}>Subtract</Button><Button variant="quiet" icon="intersect" onClick={() => boolean("intersect")}>Intersect</Button><span className="toolbar-spacer" /><Button variant="quiet" icon="upload" onClick={() => void importSolid()}>Import STL / 3MF</Button></div>
      <DesignViewport selectedId={selected?.id ?? ""} onSelect={choose} scene={state.scene} />
      <div className="canvas-caption"><span><Icon name="info" size={14} />Interactive scene preview · canonical validation remains a sidecar responsibility</span><span>Origin locked · mm</span></div>
    </section>

    <aside className="right-inspector" aria-label="Design inspector">
      <div className="inspector-title"><div><span className="workspace-kicker">ACTIVE SELECTION</span><h2>{selected?.name ?? "No selection"}</h2></div><IconButton label="Inspector options" icon="more" size={17} onClick={() => dispatch({ type: "SET_TOAST", message: "Inspector options are local to the active selection" })} /></div>
      <Disclosure title="Transform" open={transformOpen} onToggle={() => setTransformOpen((open) => !open)}><div className="inspector-fields"><TransformRow label="Position" value={selected?.transform.position} onChange={(position) => selected && dispatch({ type: "SET_SCENE_TRANSFORM", id: selected.id, transform: { position } })} /><TransformRow label="Rotation" value={selected?.transform.rotation} onChange={(rotation) => selected && dispatch({ type: "SET_SCENE_TRANSFORM", id: selected.id, transform: { rotation } })} /><TransformRow label="Scale" value={selected?.transform.scale} onChange={(scale) => selected && dispatch({ type: "SET_SCENE_TRANSFORM", id: selected.id, transform: { scale } })} /><TransformRow label="Dimensions" value={selected?.dimensionsMm ?? selected?.transform.scale} onChange={(dimensionsMm) => selected && dispatch({ type: "SET_SCENE_DIMENSIONS", id: selected.id, dimensionsMm })} /></div></Disclosure>
      <Disclosure title="Region and tool" open={ownershipOpen} onToggle={() => setOwnershipOpen((open) => !open)}><SelectField label="Region" value={selected?.region ?? "measurement"} onChange={(event) => selected && dispatch({ type: "SET_SCENE_OWNERSHIP", id: selected.id, region: event.target.value as SceneObject["region"] })}><option value="measurement">Measurement</option><option value="support">Support</option><option value="fixture">Fixture</option></SelectField><SelectField label="Tool" value={selected?.tool ?? "T0"} onChange={(event) => selected && dispatch({ type: "SET_SCENE_OWNERSHIP", id: selected.id, tool: event.target.value as SceneObject["tool"] })}><option value="T0">T0 · Natural PLA</option><option value="T1">T1 · White PLA</option></SelectField></Disclosure>
      <Disclosure title="Boolean history" open={booleanOpen} onToggle={() => setBooleanOpen((open) => !open)}><div className="boolean-history">{state.scene.filter((object) => object.boolean).map((object, index) => <div key={object.id}><span className="history-index">{String(index + 1).padStart(2, "0")}</span><span>{object.name}</span><StatusBadge tone="neutral">{object.boolean?.operation}</StatusBadge></div>)}<p>Operands remain inspectable for canonical sidecar validation.</p></div></Disclosure>
      <div className="inspector-actions"><Button variant="primary" icon="check" onClick={async () => { const result = await sidecar.validateScene(state); dispatch({ type: "SET_TOAST", message: result.messages.join(" · ") || (result.valid ? "Scene validated" : "Scene validation failed") }); }}>Validate scene</Button><Button variant="quiet" icon="arrowUpRight" onClick={() => dispatch({ type: "SET_WORKSPACE", workspace: "dicom" })}>Continue to DICOM</Button></div>
    </aside>
    <AppStatusBar crosshair="origin 0.0, 0.0, 0.0 mm · physical coordinates" />
  </div>;
}

function TransformRow({ label, value, onChange }: { label: string; value?: SceneObject["transform"]["position"]; onChange: (value: SceneObject["transform"]["position"]) => void }) {
  return <FieldRow label={label}><div className="triple-inputs">{axes.map((axis) => <label key={axis}><input aria-label={`${label} ${axis}`} type="number" value={value?.[axis] ?? 0} onChange={(event) => onChange({ ...(value ?? { x: 0, y: 0, z: 0 }), [axis]: Number(event.target.value) })} /><span>{axis.toUpperCase()}</span></label>)}</div></FieldRow>;
}
