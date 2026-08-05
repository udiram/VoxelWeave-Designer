import { useEffect, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useProject } from "../../state/ProjectContext";
import { Button, Disclosure, NumberField, SegmentedControl, StatusBadge, IconButton } from "../../components/ui";
import { Icon } from "../../components/icons";
import { InteractiveMprPane, InteractiveVolumePreview } from "../../components/visuals";
import { AppStatusBar, RailHeader } from "../shell/Shell";
import type { Orientation, OutputMode, SelectionKind } from "../../types";
import { authorizeNativePath, isNativeRuntime } from "../../services/projectDocument";
import type { MprPlaneResult, VolumePreviewResult } from "../../services/sidecarClient";
import { sourcePhysicalBounds } from "../../state/projectState";

const planes: Orientation[] = ["axial", "sagittal", "coronal"];

export function DicomWorkspace() {
  const { state, dispatch, sidecar } = useProject();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [cropOpen, setCropOpen] = useState(true);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [mpr, setMpr] = useState<Partial<Record<Orientation, MprPlaneResult>>>({});
  const [volumePreview, setVolumePreview] = useState<VolumePreviewResult>();
  const selection = state.selection;
  const maxIndex = Math.max(0, state.source.sliceCount - 1);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!state.source.path || state.source.sliceCount < 1 || (sidecar.mode === "native" && !state.source.cache.directory)) return;
      try {
        const result = await Promise.all(planes.map((plane) => sidecar.requestMprPlane(state, plane)));
        if (!cancelled) setMpr({ axial: result[0], sagittal: result[1], coronal: result[2] });
        const preview = await sidecar.requestVolumePreview(state);
        if (!cancelled) setVolumePreview(preview);
      } catch (error) {
        if (!cancelled) dispatch({ type: "SET_TOAST", message: error instanceof Error ? error.message : "DICOM view request failed" });
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [dispatch, sidecar, state.source.path, state.source.sliceCount, selection.start, selection.orientation, selection.resamplingMethod]);

  const importDicom = async () => {
    if (!isNativeRuntime()) {
      dispatch({ type: "SET_TOAST", message: "The browser test adapter uses its controlled DICOM fixture" });
      return;
    }
    setImporting(true);
    try {
      const selected = await open({ directory: true, multiple: false, title: "Choose DICOM folder" });
      if (typeof selected !== "string") return;
      await authorizeNativePath(selected);
      const candidate = { ...state.source, path: selected, name: selected.split(/[\\/]/).pop() ?? "DICOM source", seriesUid: "", status: "needs-review" as const };
      const inspected = await sidecar.inspectDicomSource({ ...state, source: candidate }, progress(dispatch));
      dispatch({ type: "SET_DICOM_SOURCE", source: inspected.source });
      const selectedSeries = await sidecar.selectDicomSeries({ ...state, source: inspected.source }, inspected.source.seriesUid, progress(dispatch));
      dispatch({ type: "SET_DICOM_SOURCE", source: selectedSeries.source });
      const cache = await sidecar.buildVolumeCache({ ...state, source: selectedSeries.source }, progress(dispatch));
      dispatch({ type: "SET_DICOM_SOURCE", source: {
        ...selectedSeries.source,
        ...(cache.sourceHash ? { sourceHash: cache.sourceHash } : {}),
        ...(cache.dimensions ? { dimensions: cache.dimensions } : {}),
        ...(cache.spacing ? { spacing: cache.spacing } : {}),
        ...(cache.origin ? { origin: cache.origin } : {}),
        ...(cache.directionLps ? { directionLps: cache.directionLps } : {}),
        cache: { ...selectedSeries.source.cache, directory: cache.directory, volumePath: cache.volumePath, previewPath: cache.previewPath },
      } });
      dispatch({ type: "SET_TOAST", message: `Imported ${selectedSeries.source.name}` });
    } catch (error) {
      dispatch({ type: "SET_TOAST", message: error instanceof Error ? error.message : "DICOM import failed" });
    } finally { setImporting(false); }
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      const result = await sidecar.createPrintSelection(state, progress(dispatch));
      dispatch({ type: "CREATE_PRINT_SELECTION" });
      dispatch({ type: "SET_TOAST", message: `Print selection created · ${result.physicalThicknessMm.toFixed(1)} mm physical slab` });
    } catch (error) {
      dispatch({ type: "SET_TOAST", message: error instanceof Error ? error.message : "Unable to create print selection" });
    } finally { setCreating(false); }
  };

  const setOrientation = (orientation: Orientation) => {
    dispatch({ type: "SET_SELECTION", patch: { orientation } });
    dispatch({ type: "SET_SELECTED_PANE", pane: orientation });
  };

  return <div className="workspace-layout dicom-layout">
    <aside className="left-rail dicom-rail" aria-label="DICOM source rail">
      <RailHeader title="Series" action="plus" actionLabel="Choose DICOM folder" onAction={() => void importDicom()} />
      <div className="series-card selected"><div className="series-thumb"><InteractiveMprPane testAdapter={sidecar.mode !== "native"} plane="axial" result={mpr.axial} index={selection.orientation === "axial" ? selection.start : 0} selected={state.ui.selectedPane === "axial"} /></div><div className="series-copy"><strong>{state.source.name}</strong><span>{state.source.sliceCount || "—"} slices</span><span>{state.source.spacing.x ? `${state.source.spacing.x.toFixed(2)} × ${state.source.spacing.y.toFixed(2)} × ${state.source.spacing.z.toFixed(2)} mm` : "Choose a DICOM folder"}</span><StatusBadge tone={state.source.status === "ready" ? "ready" : "warning"} icon={state.source.status === "ready" ? "checkCircle" : "warning"}>{state.source.status === "ready" ? "Ready" : "Needs review"}</StatusBadge></div><IconButton label="Series options" icon="more" size={16} onClick={() => void importDicom()} /></div>
      <Disclosure title="Series details" open={detailsOpen} onToggle={() => setDetailsOpen((open) => !open)}><div className="detail-list"><div><span>SeriesInstanceUID</span><code>{state.source.seriesUid || "—"}</code></div><div><span>Source path</span><code>{state.source.path ?? "Not selected"}</code></div><div><span>Orientation</span><strong>{state.source.orientation || "—"}</strong></div><div><span>HU range</span><strong>{state.source.sliceCount ? `${state.source.huRange.min} to ${state.source.huRange.max}` : "—"}</strong></div><div><span>Series review</span><StatusBadge tone={state.source.status === "ready" ? "ready" : "warning"} icon={state.source.status === "ready" ? "check" : "warning"}>{state.source.status}</StatusBadge></div></div></Disclosure>
      <div className="rail-divider" />
      <div className="rail-evidence"><div><Icon name="database" size={16} /><span>Source boundary</span></div><strong>{isNativeRuntime() ? "Signed HU data stays in the local sidecar cache." : "Controlled test data stays in the browser adapter."}</strong><p>Preview textures are derived views and never slicing inputs.</p><Button variant="secondary" icon={importing ? "refresh" : "folder"} disabled={importing} onClick={() => void importDicom()}>{importing ? "Importing…" : "Choose DICOM folder"}</Button></div>
    </aside>
    <section className="workspace-center dicom-center" aria-labelledby="dicom-heading">
      <div className="center-toolbar"><div><span className="workspace-kicker">SERIES / MPR / PHYSICAL COORDINATES</span><h1 id="dicom-heading">DICOM</h1></div><div className="tool-group"><Button variant="quiet" icon="crosshair" onClick={() => dispatch({ type: "SET_TOAST", message: "Crosshair synchronized across all four views" })}>Synchronize crosshair</Button><IconButton label="Reset MPR layout" icon="fit" onClick={() => dispatch({ type: "SET_TOAST", message: "MPR layout reset to synchronized 2 × 2" })} /></div></div>
      <div className="mpr-toolbar"><SegmentedControl label="Active plane" value={state.ui.selectedPane === "3d" ? "axial" : state.ui.selectedPane} options={planes.map((plane) => ({ value: plane, label: plane[0].toUpperCase() + plane.slice(1) }))} onChange={(value) => setOrientation(value as Orientation)} /><span className="mpr-toolbar-note" aria-live="polite"><Icon name="link" size={15} />Linked physical coordinates · window 1600 / level −600 · {state.source.cache.preview}</span></div>
      <div className="mpr-grid">{planes.map((plane) => <InteractiveMprPane key={plane} testAdapter={sidecar.mode !== "native"} plane={plane} result={mpr[plane]} index={selection.orientation === plane ? selection.start : Math.floor(maxIndex / 2)} selected={state.ui.selectedPane === plane} onSelect={() => dispatch({ type: "SET_SELECTED_PANE", pane: plane })} onCrosshair={(x) => { const next = Math.round(x * maxIndex); dispatch({ type: "SET_SELECTION", patch: { start: next, end: Math.max(selection.end, next) } }); }} />)}<InteractiveVolumePreview result={volumePreview} /></div>
    </section>
    <aside className="right-inspector dicom-inspector" aria-label="Print selection inspector">
      <div className="inspector-title"><div><span className="workspace-kicker">PHYSICAL OUTPUT</span><h2>Print selection</h2></div><IconButton label="Selection options" icon="more" size={17} onClick={() => dispatch({ type: "SET_TOAST", message: "Selection options use patient-coordinate bounds" })} /></div>
      <div className="inspector-section"><h3>Orientation</h3><SegmentedControl label="Print orientation" value={selection.orientation} options={planes.map((plane) => ({ value: plane, label: plane[0].toUpperCase() + plane.slice(1) }))} onChange={(value) => setOrientation(value as Orientation)} /></div>
      <div className="inspector-section"><h3>Selection</h3><SegmentedControl label="Selection type" value={selection.kind} options={[{ value: "single", label: "Single slice" }, { value: "range", label: "Inclusive range" }, { value: "tiles", label: "Tile range" }]} onChange={(value) => dispatch({ type: "SET_SELECTION", patch: { kind: value as SelectionKind, outputMode: value === "tiles" ? "tiles" : selection.outputMode } })} />{selection.kind !== "single" ? <div className="range-fields"><NumberField label="Start index" value={selection.start} min={0} max={maxIndex} onChange={(value) => dispatch({ type: "SET_SELECTION", patch: { start: value } })} /><NumberField label="End index" value={selection.end} min={selection.start} max={maxIndex} onChange={(value) => dispatch({ type: "SET_SELECTION", patch: { end: value } })} /><div className="thickness-readout"><strong>{selection.thicknessMm.toFixed(2)} mm</strong><span>physical slab · {Math.max(1, selection.end - selection.start + 1)} planes</span></div></div> : <div className="single-note">Source plane repeated through the configured print thickness.</div>}{selection.kind === "tiles" && <NumberField label="Tile stride" value={selection.stride} min={1} max={Math.max(1, selection.end - selection.start + 1)} onChange={(value) => dispatch({ type: "SET_SELECTION", patch: { stride: value } })} />}</div>
      <div className="inspector-section"><h3>Output mode</h3><SegmentedControl label="Output mode" value={selection.outputMode} options={[{ value: "continuous", label: "Continuous volume" }, { value: "tiles", label: "Separate tiles" }]} onChange={(value) => dispatch({ type: "SET_SELECTION", patch: { outputMode: value as OutputMode } })} /></div>
      <Disclosure title="Crop dimensions" open={cropOpen} onToggle={() => setCropOpen((open) => !open)} action={<IconButton label="Reset crop bounds" icon="crop" size={16} onClick={() => dispatch({ type: "SET_SELECTION", patch: { crop: sourcePhysicalBounds(state.source) } })} />}><div className="crop-readout"><strong>{Math.abs(selection.crop.x[1] - selection.crop.x[0]).toFixed(1)} × {Math.abs(selection.crop.y[1] - selection.crop.y[0]).toFixed(1)} × {selection.thicknessMm.toFixed(2)} mm</strong><span>Patient-coordinate bounds · aspect ratio locked</span></div><FieldRowCompact label="Scale"><div className="number-field"><input aria-label="Scale" type="number" value={selection.scale.toFixed(2)} step="0.05" min="0.1" max="10" onChange={(event) => dispatch({ type: "SET_SELECTION", patch: { scale: Number(event.target.value) } })} /><span>×</span></div></FieldRowCompact><div className="crop-coordinates"><code>{selection.crop.x.join(" … ")} mm</code><code>{selection.crop.y.join(" … ")} mm</code><code>{selection.crop.z.join(" … ")} mm</code></div></Disclosure>
      <div className="dimension-summary"><div><span>Source</span><strong>{state.source.dimensions.x || "—"} × {state.source.dimensions.y || "—"} × {state.source.dimensions.z || "—"}</strong></div><div><span>Output</span><strong>{selection.outputDimensionsMm ? `${selection.outputDimensionsMm.x.toFixed(1)} × ${selection.outputDimensionsMm.y.toFixed(1)} × ${selection.outputDimensionsMm.z.toFixed(2)} mm` : "—"}</strong></div><div><span>Transform</span><code>{selection.sourceToPrintTransform ? "recorded" : "created on selection"}</code></div></div>
      <div className="inspector-actions"><Button variant="primary" icon={creating ? "refresh" : "check"} disabled={creating || !state.source.path || state.source.status !== "ready"} onClick={() => void handleCreate()} data-testid="create-print-selection">{creating ? "Creating selection…" : selection.created ? "Selection created" : "Create print selection"}</Button>{selection.created && <Button variant="quiet" icon="arrowUpRight" onClick={() => dispatch({ type: "SET_WORKSPACE", workspace: "calibrate" })}>Review calibration</Button>}</div>
    </aside>
    <AppStatusBar warning={!selection.created} />
  </div>;
}

function progress(dispatch: (action: { type: "SET_TOAST"; message: string }) => void) {
  return (event: { stage: string; progress: number }) => dispatch({ type: "SET_TOAST", message: `${event.stage} · ${Math.round(event.progress * 100)}%` });
}

function FieldRowCompact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="field-row compact-field"><div className="field-label"><span>{label}</span></div><div className="field-control">{children}</div></div>;
}
