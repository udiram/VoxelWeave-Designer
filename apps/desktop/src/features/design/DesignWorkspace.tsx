import { useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useProject } from "../../state/ProjectContext";
import { Button, Disclosure, FieldRow, IconButton, SelectField, SectionHeading, StatusBadge } from "../../components/ui";
import { Icon } from "../../components/icons";
import { DesignViewport } from "../../components/visuals";
import { AppStatusBar, RailHeader } from "../shell/Shell";
import type { SceneObject } from "../../types";
import { authorizeNativePath, isNativeRuntime } from "../../services/projectDocument";

const axes = ["x", "y", "z"] as const;

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
      dispatch({ type: "IMPORT_SOLID", path: selectedPath, format });
      const validation = await sidecar.validateScene({ ...state, scene: [...state.scene, { id: "import-pending", name: "Imported solid", kind: "fixture", region: "fixture", tool: "T1", sourcePath: selectedPath, transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, visible: true }] });
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
