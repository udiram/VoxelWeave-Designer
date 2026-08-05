import { useMemo, useState } from "react";
import { useProject } from "../../state/ProjectContext";
import { Button, Disclosure, FieldRow, IconButton, SelectField, SectionHeading, StatusBadge } from "../../components/ui";
import { Icon } from "../../components/icons";
import { DesignViewport } from "../../components/visuals";
import { AppStatusBar, RailHeader } from "../shell/Shell";
import type { SceneObject } from "../../types";

const axes = ["x", "y", "z"] as const;

export function DesignWorkspace() {
  const { state, dispatch } = useProject();
  const [transformOpen, setTransformOpen] = useState(true);
  const [ownershipOpen, setOwnershipOpen] = useState(true);
  const [booleanOpen, setBooleanOpen] = useState(true);
  const selected = useMemo(() => state.scene.find((object) => object.id === state.ui.selectedSceneId) ?? state.scene[0], [state.scene, state.ui.selectedSceneId]);
  const choose = (id: string) => dispatch({ type: "SET_SCENE_SELECTION", id });

  return <div className="workspace-layout design-layout">
    <aside className="left-rail" aria-label="Scene rail">
      <RailHeader title="Scene" action="plus" actionLabel="Add primitive" onAction={() => dispatch({ type: "ADD_PRIMITIVE", kind: "box" })} />
      <div className="rail-subline"><span>{state.scene.length} objects · 1 DICOM source</span><IconButton label="Scene options" icon="more" size={16} onClick={() => dispatch({ type: "SET_TOAST", message: "Scene options: validate ownership or inspect provenance" })} /></div>
      <div className="scene-tree" role="tree" aria-label="Scene objects">
        {state.scene.map((object) => <div key={object.id} className={`scene-row ${selected?.id === object.id ? "selected" : ""}`} role="treeitem" aria-selected={selected?.id === object.id} onClick={() => choose(object.id)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") choose(object.id); }}>
          <Icon name={object.kind === "dicom" ? "dicom" : "cube"} size={16} /><span>{object.name}</span><button type="button" className="row-eye" aria-label={`${object.visible ? "Hide" : "Show"} ${object.name}`} onClick={(event) => { event.stopPropagation(); dispatch({ type: "TOGGLE_SCENE_VISIBILITY", id: object.id }); }}><Icon name={object.visible ? "eye" : "eyeOff"} size={15} /></button>
        </div>)}
      </div>
      <div className="rail-divider" />
      <SectionHeading action={<StatusBadge tone="ready" icon="check">valid</StatusBadge>}>Ownership</SectionHeading>
      <div className="ownership-list"><div><span className="ownership-swatch t0" />T0 · Natural PLA</div><div><span className="ownership-swatch t1" />T1 · White PLA</div><p>Ambiguous overlap: none</p></div>
      <div className="rail-bottom"><Button variant="quiet" icon="scan" onClick={() => dispatch({ type: "SET_TOAST", message: "Synthetic DICOM source is already cached; no raw identifiers are embedded" })}>Inspect source</Button></div>
    </aside>

    <section className="workspace-center design-center" aria-labelledby="design-heading">
      <div className="center-toolbar"><div><span className="workspace-kicker">MODELED GEOMETRY + SOURCE</span><h1 id="design-heading">Design</h1></div><div className="tool-group" aria-label="Transform tools"><IconButton label="Move selection" icon="move" onClick={() => dispatch({ type: "SET_TOAST", message: "Move tool active · snap increment 0.5 mm" })} /><IconButton label="Rotate selection" icon="rotate" onClick={() => dispatch({ type: "SET_TOAST", message: "Rotate tool active · angle entry is available in the inspector" })} /><IconButton label="Scale selection" icon="scale" onClick={() => dispatch({ type: "SET_TOAST", message: "Scale tool active · physical aspect ratio remains locked" })} /><span className="toolbar-separator" /><IconButton label="Align selection" icon="target" onClick={() => dispatch({ type: "SET_TOAST", message: "Alignment preview: scene objects share the project origin" })} /><IconButton label="Toggle grid" icon="grid" onClick={() => dispatch({ type: "SET_TOAST", message: "Grid visibility toggled for the synthetic scene" })} /></div></div>
      <div className="canvas-toolbar"><Button variant="secondary" icon="plus" onClick={() => dispatch({ type: "ADD_PRIMITIVE", kind: "box" })}>Box</Button><Button variant="secondary" icon="cube" onClick={() => dispatch({ type: "ADD_PRIMITIVE", kind: "cylinder" })}>Cylinder</Button><Button variant="secondary" icon="design" onClick={() => dispatch({ type: "ADD_PRIMITIVE", kind: "wedge" })}>Wedge</Button><span className="toolbar-separator" /><Button variant="quiet" icon="union" onClick={() => dispatch({ type: "SET_TOAST", message: "Boolean union staged · select a second operand to apply" })}>Union</Button><Button variant="quiet" icon="subtract" onClick={() => dispatch({ type: "SET_TOAST", message: "Boolean subtraction staged · select a second operand to apply" })}>Subtract</Button><Button variant="quiet" icon="intersect" onClick={() => dispatch({ type: "SET_TOAST", message: "Boolean intersection staged · select a second operand to apply" })}>Intersect</Button><span className="toolbar-spacer" /><Button variant="quiet" icon="upload" onClick={() => dispatch({ type: "ADD_PRIMITIVE", kind: "box" })}>Import 3MF</Button></div>
      <DesignViewport selectedId={selected?.id ?? ""} onSelect={choose} />
      <div className="canvas-caption"><span><Icon name="info" size={14} />Synthetic geometry preview · canonical validation remains a sidecar responsibility</span><span>Origin locked · mm</span></div>
    </section>

    <aside className="right-inspector" aria-label="Design inspector">
      <div className="inspector-title"><div><span className="workspace-kicker">ACTIVE SELECTION</span><h2>{selected?.name ?? "No selection"}</h2></div><IconButton label="Inspector options" icon="more" size={17} onClick={() => dispatch({ type: "SET_TOAST", message: "Inspector options are local to the active selection" })} /></div>
      <Disclosure title="Transform" open={transformOpen} onToggle={() => setTransformOpen((open) => !open)}><div className="inspector-fields"><TransformRow label="Position" value={selected?.transform.position} onChange={(position) => selected && dispatch({ type: "SET_SCENE_TRANSFORM", id: selected.id, transform: { position } })} /><TransformRow label="Rotation" value={selected?.transform.rotation} onChange={(rotation) => selected && dispatch({ type: "SET_SCENE_TRANSFORM", id: selected.id, transform: { rotation } })} /><TransformRow label="Scale" value={selected?.transform.scale} onChange={(scale) => selected && dispatch({ type: "SET_SCENE_TRANSFORM", id: selected.id, transform: { scale } })} /></div></Disclosure>
      <Disclosure title="Region and tool" open={ownershipOpen} onToggle={() => setOwnershipOpen((open) => !open)}><SelectField label="Region" value={selected?.region ?? "measurement"} onChange={(event) => selected && dispatch({ type: "SET_SCENE_OWNERSHIP", id: selected.id, region: event.target.value as SceneObject["region"] })}><option value="measurement">Measurement</option><option value="support">Support</option><option value="fixture">Fixture</option></SelectField><SelectField label="Tool" value={selected?.tool ?? "T0"} onChange={(event) => selected && dispatch({ type: "SET_SCENE_OWNERSHIP", id: selected.id, tool: event.target.value as SceneObject["tool"] })}><option value="T0">T0 · Natural PLA</option><option value="T1">T1 · White PLA</option></SelectField></Disclosure>
      <Disclosure title="Boolean history" open={booleanOpen} onToggle={() => setBooleanOpen((open) => !open)}><div className="boolean-history"><div><span className="history-index">01</span><span>Source volume</span><StatusBadge tone="neutral">operand</StatusBadge></div><div><span className="history-index">02</span><span>Reference frame</span><StatusBadge tone="neutral">fixture</StatusBadge></div><p>Operands remain inspectable after action.</p></div></Disclosure>
      <div className="inspector-actions"><Button variant="primary" icon="check" onClick={() => dispatch({ type: "SET_TOAST", message: "Scene validated locally · no ambiguous overlap" })}>Validate scene</Button><Button variant="quiet" icon="arrowUpRight" onClick={() => dispatch({ type: "SET_WORKSPACE", workspace: "dicom" })}>Continue to DICOM</Button></div>
    </aside>
    <AppStatusBar crosshair="origin 0.0, 0.0, 0.0 mm · synthetic" />
  </div>;
}

function TransformRow({ label, value, onChange }: { label: string; value?: SceneObject["transform"]["position"]; onChange: (value: SceneObject["transform"]["position"]) => void }) {
  return <FieldRow label={label}><div className="triple-inputs">{axes.map((axis) => <label key={axis}><input aria-label={`${label} ${axis}`} type="number" value={value?.[axis] ?? 0} onChange={(event) => onChange({ ...(value ?? { x: 0, y: 0, z: 0 }), [axis]: Number(event.target.value) })} /><span>{axis.toUpperCase()}</span></label>)}</div></FieldRow>;
}
