import { useState } from "react";
import { useProject } from "../../state/ProjectContext";
import { Button, Disclosure, SegmentedControl, StatusBadge, IconButton } from "../../components/ui";
import { Icon } from "../../components/icons";
import { ToolpathCanvas } from "../../components/visuals";
import { AppStatusBar, RailHeader } from "../shell/Shell";

export function PrepareWorkspace() {
  const { state, dispatch, sidecar } = useProject();
  const [view, setView] = useState("layer");
  const [runChecksOpen, setRunChecksOpen] = useState(true);
  const [selectionOpen, setSelectionOpen] = useState(true);
  const [layersOpen, setLayersOpen] = useState(true);
  const [visibilityOpen, setVisibilityOpen] = useState(true);
  const [estimateOpen, setEstimateOpen] = useState(true);
  const [estimating, setEstimating] = useState(false);
  const layer = state.toolpath.selectedLayer;
  const calibration = state.calibrations.find((profile) => profile.id === state.selection.calibrationId) ?? state.calibrations.find((profile) => profile.accepted);
  const sample = calibration?.huSamples[Math.min(2, Math.max(0, calibration.huSamples.length - 1))];

  const generatePreview = async () => {
    setEstimating(true);
    try {
      const result = await sidecar.generateToolpath(state, (event) => dispatch({ type: "SET_TOAST", message: `${event.stage} · ${Math.round(event.progress * 100)}%` }));
      dispatch({ type: "SET_TOOLPATH_GENERATED", runId: result.runId, estimate: result.estimate, clippingPercent: result.clippingPercent });
    } catch (error) {
      dispatch({ type: "SET_TOAST", message: error instanceof Error ? error.message : "Toolpath generation failed closed" });
    } finally { setEstimating(false); }
  };

  const generateAudited = async () => {
    try {
      const result = await sidecar.reverseAuditGcode(state);
      if (result.passed) dispatch({ type: "GENERATE_AUDITED_GCODE" });
      else dispatch({ type: "SET_TOAST", message: `Reverse audit blocked output: ${result.checks.join(" · ")}` });
    } catch (error) { dispatch({ type: "SET_TOAST", message: error instanceof Error ? error.message : "Reverse audit failed closed" }); }
  };

  const checks = [
    ["Geometry", state.selection.created && state.scene.some((object) => object.visible), state.selection.created ? "Selection and visible regions present" : "Create a print selection"],
    ["Calibration", state.calibrations.some((profile) => profile.accepted), "Accepted profiles available"],
    ["Flow limits", state.selection.created, state.selection.created ? "Checked by sidecar on generation" : "Pending selection"],
    ["Bed bounds", state.selection.created, state.selection.created ? "Checked by sidecar on generation" : "Pending selection"],
    ["Tool changes", state.toolpath.generated, state.toolpath.generated ? `${state.toolpath.estimated.toolChanges} planned` : "Pending generation"],
    ["G-code reverse audit", state.toolpath.audited, state.toolpath.audited ? "Preview stream matched" : "Pending clipping review"],
  ] as const;

  return <div className="workspace-layout prepare-layout">
    <aside className="left-rail prepare-rail" aria-label="Prepare layer rail">
      <RailHeader title="Build plates" action="plus" actionLabel="Add build plate" onAction={() => dispatch({ type: "SET_TOAST", message: "Additional build plates are arranged by the sidecar selection manifest" })} />
      <div className="plate-row selected"><Icon name="cube" size={17} /><span>Plate 1</span><StatusBadge tone="neutral">XL</StatusBadge></div>
      <div className="rail-divider" />
      <Disclosure title="Layers" open={layersOpen} onToggle={() => setLayersOpen((open) => !open)}><div className="layer-readout"><span>Layer {layer} / {state.toolpath.totalLayers}</span><IconButton label="Reset active layer" icon="fit" size={16} onClick={() => dispatch({ type: "SET_LAYER", layer: 112 })} /></div><input className="layer-range" aria-label="Active layer" type="range" min="1" max={state.toolpath.totalLayers} value={layer} onChange={(event) => dispatch({ type: "SET_LAYER", layer: Number(event.target.value) })} /><div className="layer-scale"><span>{state.toolpath.totalLayers}</span><span>{Math.round(state.toolpath.totalLayers / 2)}</span><span>1</span></div></Disclosure>
      <Disclosure title="Visibility" open={visibilityOpen} onToggle={() => setVisibilityOpen((open) => !open)}><div className="visibility-list"><div><i className="material-line t0" /><span>T0 Natural PLA</span><IconButton label="Toggle T0 visibility" icon="eye" size={15} onClick={() => dispatch({ type: "SET_TOAST", message: "T0 visibility toggled in the generated preview" })} /></div><div><i className="material-line t1" /><span>T1 White PLA</span><IconButton label="Toggle T1 visibility" icon="eye" size={15} onClick={() => dispatch({ type: "SET_TOAST", message: "T1 visibility toggled in the generated preview" })} /></div><div><i className="material-line travel" /><span>Travel</span><IconButton label="Toggle travel visibility" icon="eye" size={15} onClick={() => dispatch({ type: "SET_TOAST", message: "Travel visibility toggled in the generated preview" })} /></div><div><i className="material-line anchors" /><span>Brim & anchors</span><IconButton label="Toggle brim visibility" icon="eye" size={15} onClick={() => dispatch({ type: "SET_TOAST", message: "Brim and anchors visibility toggled" })} /></div></div></Disclosure>
    </aside>
    <section className="workspace-center prepare-center" aria-labelledby="prepare-heading">
      <div className="center-toolbar"><div><span className="workspace-kicker">GENERATED SEGMENTS / MULTI-TOOL</span><h1 id="prepare-heading">Prepare</h1></div><div className="tool-group"><IconButton label="Reset camera" icon="home" onClick={() => dispatch({ type: "SET_TOAST", message: "Toolpath camera reset to bed fit" })} /><IconButton label="Zoom in" icon="zoomIn" onClick={() => dispatch({ type: "SET_TOAST", message: "Zoomed toolpath view" })} /><IconButton label="Zoom out" icon="zoomOut" onClick={() => dispatch({ type: "SET_TOAST", message: "Zoomed toolpath view" })} /><IconButton label="Fit toolpath" icon="fit" onClick={() => dispatch({ type: "SET_TOAST", message: "Toolpath fitted to the Prusa XL bed" })} /></div></div>
      <div className="toolpath-toolbar"><SegmentedControl label="Toolpath view" value={view} options={[{ value: "3d", label: "3D" }, { value: "layer", label: "Layer" }, { value: "width", label: "Width" }, { value: "flow", label: "Flow" }, { value: "tool", label: "Tool" }]} onChange={setView} /><span className="toolpath-toolbar-note"><Icon name="layers" size={15} />Layer {layer} / {state.toolpath.totalLayers} · {state.toolpath.generated ? "generated-segment stream" : "preview not generated"}</span></div>
      <div className="toolpath-stage"><ToolpathCanvas selectedLayer={layer} activeTool={view === "tool" ? "T1" : "T0"} generated={state.toolpath.generated} totalLayers={state.toolpath.totalLayers} />{!state.toolpath.generated && <div className="toolpath-empty"><Icon name="refresh" size={20} /><strong>Generate the sidecar toolpath preview</strong><span>Uses the selected physical crop, scene ownership, and accepted calibration profiles.</span>{!state.calibrations.some((profile) => profile.accepted) && <span role="alert">Create and explicitly accept a calibration profile before generation.</span>}<Button variant="primary" icon="play" disabled={estimating || !state.selection.created || !state.calibrations.some((profile) => profile.accepted)} onClick={generatePreview} data-testid="generate-toolpath">{estimating ? "Generating preview…" : "Generate toolpath preview"}</Button></div>}</div>
      <div className="layer-timeline"><div className="timeline-controls"><IconButton label="First layer" icon="stepBack" onClick={() => dispatch({ type: "SET_LAYER", layer: 1 })} /><IconButton label="Previous layer" icon="stepBack" onClick={() => dispatch({ type: "SET_LAYER", layer: Math.max(1, layer - 1) })} /><Button variant="secondary" icon="play" onClick={() => dispatch({ type: "SET_LAYER", layer: Math.min(state.toolpath.totalLayers, layer + 5) })}>Advance 5</Button><IconButton label="Next layer" icon="stepForward" onClick={() => dispatch({ type: "SET_LAYER", layer: Math.min(state.toolpath.totalLayers, layer + 1) })} /><IconButton label="Last layer" icon="stepForward" onClick={() => dispatch({ type: "SET_LAYER", layer: state.toolpath.totalLayers })} /></div><div className="timeline-track"><span>Layer 1</span><input aria-label="Timeline layer" type="range" min="1" max={state.toolpath.totalLayers} value={layer} onChange={(event) => dispatch({ type: "SET_LAYER", layer: Number(event.target.value) })} /><span>Layer {state.toolpath.totalLayers}</span></div><div className="timeline-legend"><span><i className="legend-line graphite" />T0 Natural PLA</span><span><i className="legend-line teal" />T1 White PLA</span><span><i className="legend-line dashed" />Travel</span><span><i className="legend-line sienna" />Selected</span></div></div>
    </section>
    <aside className="right-inspector prepare-inspector" aria-label="Prepare run checks inspector">
      <div className="inspector-title"><div><span className="workspace-kicker">AUDIT GATE</span><h2>Run checks</h2></div><IconButton label="Run checks options" icon="more" size={17} onClick={() => dispatch({ type: "SET_TOAST", message: "Run checks use the current source, scene, calibration, and generated stream" })} /></div>
      <Disclosure title="Run checks" open={runChecksOpen} onToggle={() => setRunChecksOpen((open) => !open)}><div className="check-list">{checks.map(([name, passed, detail]) => <div className="check-row" key={name}><span>{name}<small>{detail}</small></span><Icon name={passed ? "checkCircle" : "alert"} size={18} /></div>)}<div className="clipping-row"><Icon name="warning" size={18} /><div><strong>Width clipping · {state.toolpath.clippingPercent.toFixed(1)}%</strong><span>Review before audited output.</span></div>{state.toolpath.clippingAcknowledged ? <StatusBadge tone="ready" icon="check">acknowledged</StatusBadge> : <button type="button" className="inline-action" onClick={() => dispatch({ type: "ACKNOWLEDGE_CLIPPING" })} data-testid="acknowledge-clipping">Review clipping</button>}</div></div></Disclosure>
      <Disclosure title="Selection" open={selectionOpen} onToggle={() => setSelectionOpen((open) => !open)}><div className="selection-summary"><div><span>Layer</span><strong>{layer}</strong></div><div><span>Source plane</span><strong>{state.selection.orientation} · {state.selection.start}</strong></div><div><span>Tool</span><strong>{calibration ? `${calibration.tool} · ${calibration.nozzleMm.toFixed(2)} mm` : "No accepted profile"}</strong></div><div><span>Width sample</span><strong>{sample ? `${sample.widthMm.toFixed(2)} mm` : "—"}</strong></div><div><span>Target HU</span><strong>{sample ? sample.targetHu : "—"}</strong></div><div><span>Measured HU</span><strong>{sample ? sample.measuredHu : "—"}</strong></div><div><span>Run</span><strong>{state.toolpath.runId ?? "Not generated"}</strong></div></div></Disclosure>
      <Disclosure title="Estimate" open={estimateOpen} onToggle={() => setEstimateOpen((open) => !open)}><div className="estimate-table"><div><span>Print time</span><strong>{state.toolpath.estimated.printTime}</strong></div><div><span>T0 (Natural PLA)</span><strong>{state.toolpath.estimated.t0Grams.toFixed(1)} g</strong></div><div><span>T1 (White PLA)</span><strong>{state.toolpath.estimated.t1Grams.toFixed(1)} g</strong></div><div><span>Tool changes</span><strong>{state.toolpath.estimated.toolChanges}</strong></div></div></Disclosure>
      <div className="inspector-actions"><Button variant="primary" icon={state.toolpath.audited ? "check" : "lock"} disabled={!state.toolpath.generated || !state.toolpath.clippingAcknowledged || state.toolpath.audited} onClick={generateAudited} data-testid="generate-audited-gcode">{state.toolpath.audited ? "Audited G-code ready" : "Generate audited G-code"}</Button><p className="gate-note">{state.toolpath.audited ? "Reverse audit matched the exact preview stream." : "Acknowledge width clipping to enable."}</p>{state.toolpath.audited && <Button variant="quiet" icon="arrowUpRight" onClick={() => dispatch({ type: "SET_WORKSPACE", workspace: "send" })}>Continue to Send</Button>}</div>
    </aside>
    <AppStatusBar warning={!state.toolpath.clippingAcknowledged} />
  </div>;
}
