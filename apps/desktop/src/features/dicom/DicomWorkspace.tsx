import { useState, type ReactNode } from "react";
import { useProject } from "../../state/ProjectContext";
import { Button, Disclosure, NumberField, SegmentedControl, SelectField, StatusBadge, IconButton } from "../../components/ui";
import { Icon } from "../../components/icons";
import { SyntheticSlice, VolumePreview } from "../../components/visuals";
import { AppStatusBar, RailHeader } from "../shell/Shell";
import type { Orientation, OutputMode, SelectionKind } from "../../types";

export function DicomWorkspace() {
  const { state, dispatch, sidecar } = useProject();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [cropOpen, setCropOpen] = useState(true);
  const [creating, setCreating] = useState(false);
  const selection = state.selection;

  const handleCreate = async () => {
    setCreating(true);
    const result = await sidecar.createPrintSelection(state, (event) => dispatch({ type: "SET_TOAST", message: `${event.stage} · ${Math.round(event.progress * 100)}%` }));
    dispatch({ type: "CREATE_PRINT_SELECTION" });
    dispatch({ type: "SET_TOAST", message: `Print selection created · ${result.physicalThicknessMm.toFixed(1)} mm physical slab` });
    setCreating(false);
  };

  const setOrientation = (orientation: Orientation) => {
    dispatch({ type: "SET_SELECTION", patch: { orientation } });
    dispatch({ type: "SET_SELECTED_PANE", pane: orientation });
  };

  return <div className="workspace-layout dicom-layout">
    <aside className="left-rail dicom-rail" aria-label="DICOM source rail">
      <RailHeader title="Series" action="plus" actionLabel="Inspect another series" onAction={() => dispatch({ type: "SET_TOAST", message: "Synthetic catalog contains one eligible CT series" })} />
      <div className="series-card selected"><div className="series-thumb"><SyntheticSlice plane="axial" index={64} /></div><div className="series-copy"><strong>Chest CT</strong><span>150 slices</span><span>0.70 × 0.70 × 1.00 mm</span><StatusBadge tone="ready" icon="checkCircle">Ready</StatusBadge></div><IconButton label="Series options" icon="more" size={16} onClick={() => dispatch({ type: "SET_TOAST", message: "Series grouped by SeriesInstanceUID and sorted by physical position" })} /></div>
      <Disclosure title="Series details" open={detailsOpen} onToggle={() => setDetailsOpen((open) => !open)}><div className="detail-list"><div><span>SeriesInstanceUID</span><code>{state.source.seriesUid}</code></div><div><span>Orientation</span><strong>{state.source.orientation}</strong></div><div><span>HU range</span><strong>{state.source.huRange.min} to {state.source.huRange.max}</strong></div><div><span>Continuity</span><StatusBadge tone="ready" icon="check">0 gaps</StatusBadge></div></div></Disclosure>
      <div className="rail-divider" />
      <div className="rail-evidence"><div><Icon name="database" size={16} /><span>Source boundary</span></div><strong>Signed HU data stays in the sidecar cache.</strong><p>Preview textures below are derived views and never slicing inputs.</p></div>
    </aside>
    <section className="workspace-center dicom-center" aria-labelledby="dicom-heading">
      <div className="center-toolbar"><div><span className="workspace-kicker">SERIES / MPR / PHYSICAL COORDINATES</span><h1 id="dicom-heading">DICOM</h1></div><div className="tool-group"><Button variant="quiet" icon="crosshair" onClick={() => dispatch({ type: "SET_TOAST", message: "Crosshair synchronized across all four views" })}>Synchronize crosshair</Button><IconButton label="Reset MPR layout" icon="fit" onClick={() => dispatch({ type: "SET_TOAST", message: "MPR layout reset to synchronized 2 × 2" })} /></div></div>
      <div className="mpr-toolbar"><SegmentedControl label="Active plane" value={state.ui.selectedPane === "3d" ? "axial" : state.ui.selectedPane} options={[{ value: "axial", label: "Axial" }, { value: "sagittal", label: "Sagittal" }, { value: "coronal", label: "Coronal" }]} onChange={(value) => setOrientation(value as Orientation)} /><span className="mpr-toolbar-note" aria-live="polite"><Icon name="link" size={15} />Linked physical coordinates · window 1600 / level −600</span></div>
      <div className="mpr-grid">
        <SyntheticSlice plane="axial" index={selection.orientation === "axial" ? selection.start : 42} selected={state.ui.selectedPane === "axial"} onSelect={() => dispatch({ type: "SET_SELECTED_PANE", pane: "axial" })} />
        <SyntheticSlice plane="sagittal" index={selection.orientation === "sagittal" ? selection.start : 256} selected={state.ui.selectedPane === "sagittal"} onSelect={() => dispatch({ type: "SET_SELECTED_PANE", pane: "sagittal" })} />
        <SyntheticSlice plane="coronal" index={selection.orientation === "coronal" ? selection.start : 256} selected={state.ui.selectedPane === "coronal"} onSelect={() => dispatch({ type: "SET_SELECTED_PANE", pane: "coronal" })} />
        <VolumePreview />
      </div>
    </section>
    <aside className="right-inspector dicom-inspector" aria-label="Print selection inspector">
      <div className="inspector-title"><div><span className="workspace-kicker">PHYSICAL OUTPUT</span><h2>Print selection</h2></div><IconButton label="Selection options" icon="more" size={17} onClick={() => dispatch({ type: "SET_TOAST", message: "Selection options: inspect transform or reset crop" })} /></div>
      <div className="inspector-section"><h3>Orientation</h3><SegmentedControl label="Print orientation" value={selection.orientation} options={[{ value: "axial", label: "Axial" }, { value: "sagittal", label: "Sagittal" }, { value: "coronal", label: "Coronal" }]} onChange={(value) => setOrientation(value as Orientation)} /></div>
      <div className="inspector-section"><h3>Selection</h3><SegmentedControl label="Selection type" value={selection.kind} options={[{ value: "single", label: "Single slice" }, { value: "range", label: "Inclusive range" }, { value: "tiles", label: "Tile range" }]} onChange={(value) => dispatch({ type: "SET_SELECTION", patch: { kind: value as SelectionKind, outputMode: value === "tiles" ? "tiles" : selection.outputMode } })} />{selection.kind !== "single" ? <div className="range-fields"><NumberField label="Start" value={selection.start} min={1} max={149} onChange={(value) => dispatch({ type: "SET_SELECTION", patch: { start: value } })} /><NumberField label="End" value={selection.end} min={selection.start + 1} max={150} onChange={(value) => dispatch({ type: "SET_SELECTION", patch: { end: value } })} /><div className="thickness-readout"><strong>{selection.thicknessMm.toFixed(1)} mm</strong><span>physical thickness</span></div></div> : <div className="single-note">Source plane repeated through the configured print thickness.</div>}</div>
      <div className="inspector-section"><h3>Output mode</h3><SegmentedControl label="Output mode" value={selection.outputMode} options={[{ value: "continuous", label: "Continuous volume" }, { value: "tiles", label: "Separate tiles" }]} onChange={(value) => dispatch({ type: "SET_SELECTION", patch: { outputMode: value as OutputMode } })} /></div>
      <Disclosure title="Crop dimensions" open={cropOpen} onToggle={() => setCropOpen((open) => !open)} action={<IconButton label="Reset crop bounds" icon="crop" size={16} onClick={() => dispatch({ type: "SET_TOAST", message: "Crop reset to 180 × 180 mm physical bounds" })} />}><div className="crop-readout"><strong>180.0 × 180.0 × {selection.thicknessMm.toFixed(1)} mm</strong><span>Patient-coordinate bounds · aspect ratio locked</span></div><FieldRowCompact label="Scale"><div className="number-field"><input aria-label="Scale" type="number" value={selection.scale.toFixed(2)} step="0.05" min="0.5" max="2" onChange={(event) => dispatch({ type: "SET_SELECTION", patch: { scale: Number(event.target.value) } })} /><span>×</span></div></FieldRowCompact></Disclosure>
      <div className="dimension-summary"><div><span>Source</span><strong>512 × 512 × 150</strong></div><div><span>Output</span><strong>180.0 × 180.0 × {selection.thicknessMm.toFixed(1)} mm</strong></div><div><span>Transform</span><code>sha256:7a81…e920</code></div></div>
      <div className="inspector-actions"><Button variant="primary" icon={creating ? "refresh" : "check"} disabled={creating} onClick={handleCreate} data-testid="create-print-selection">{creating ? "Creating selection…" : selection.created ? "Selection created" : "Create print selection"}</Button>{selection.created && <Button variant="quiet" icon="arrowUpRight" onClick={() => dispatch({ type: "SET_WORKSPACE", workspace: "calibrate" })}>Review calibration</Button>}</div>
    </aside>
    <AppStatusBar warning={!selection.created} />
  </div>;
}

function FieldRowCompact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="field-row compact-field"><div className="field-label"><span>{label}</span></div><div className="field-control">{children}</div></div>;
}
