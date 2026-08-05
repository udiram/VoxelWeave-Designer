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
  const [pendingSeries, setPendingSeries] = useState<Array<{ seriesUid: string; name: string; sliceCount: number; modality: string }>>([]);
  const [mpr, setMpr] = useState<Partial<Record<Orientation, MprPlaneResult>>>({});
  const [volumePreview, setVolumePreview] = useState<VolumePreviewResult>();
  const [linkedCrosshair, setLinkedCrosshair] = useState({ x: 0.5, y: 0.5 });
  const [crosshairLinked, setCrosshairLinked] = useState(true);
  const [windowLevel, setWindowLevel] = useState({ width: 1600, center: -600 });
  const [windowingLinked, setWindowingLinked] = useState(true);
  const selection = state.selection;
  const planeMaxIndex = (plane: Orientation) => Math.max(0, (plane === "axial" ? state.source.dimensions.z : plane === "sagittal" ? state.source.dimensions.x : state.source.dimensions.y) - 1);
  const maxIndex = planeMaxIndex(selection.orientation);

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

  const finishImport = async (candidate: typeof state.source, seriesUid: string) => {
    const selectedSeries = await sidecar.selectDicomSeries({ ...state, source: { ...candidate, seriesUid } }, seriesUid, progress(dispatch));
    const selectedSource = { ...selectedSeries.source, inputPaths: candidate.inputPaths };
    dispatch({ type: "SET_DICOM_SOURCE", source: selectedSource });
    const cache = await sidecar.buildVolumeCache({ ...state, source: selectedSource }, progress(dispatch));
    dispatch({ type: "SET_DICOM_SOURCE", source: {
      ...selectedSource,
      ...(cache.sourceHash ? { sourceHash: cache.sourceHash } : {}),
      ...(cache.dimensions ? { dimensions: cache.dimensions } : {}),
      ...(cache.spacing ? { spacing: cache.spacing } : {}),
      ...(cache.origin ? { origin: cache.origin } : {}),
      ...(cache.directionLps ? { directionLps: cache.directionLps } : {}),
      cache: { ...selectedSource.cache, directory: cache.directory, volumePath: cache.volumePath, previewPath: cache.previewPath },
    } });
    setPendingSeries([]);
    dispatch({ type: "SET_TOAST", message: `Imported ${selectedSeries.source.name}` });
  };

  const importDicom = async (inputKind: "directory" | "files" = "directory") => {
    if (!isNativeRuntime()) {
      dispatch({ type: "SET_TOAST", message: "The browser test adapter uses its controlled DICOM fixture" });
      return;
    }
    setImporting(true);
    try {
      const selected = await open({ directory: inputKind === "directory", multiple: inputKind === "files", title: inputKind === "directory" ? "Choose DICOM folder" : "Choose DICOM archive or files", filters: inputKind === "files" ? [{ name: "DICOM input", extensions: ["zip", "dcm", "dicom"] }] : undefined });
      const paths = typeof selected === "string" ? [selected] : Array.isArray(selected) ? selected : [];
      if (!paths.length) return;
      await Promise.all(paths.map((path) => authorizeNativePath(path)));
      const sourcePath = paths[0];
      const candidate = {
        ...state.source,
        path: sourcePath,
        inputPaths: paths,
        sourceHash: undefined,
        directionLps: undefined,
        name: sourcePath.split(/[\\/]/).pop() ?? "DICOM source",
        seriesUid: "",
        status: "needs-review" as const,
        cache: { scientificSource: "full-resolution signed-HU cache" as const, preview: "256³ refined" as const, identity: "pending" },
      };
      const inspected = await sidecar.inspectDicomSource({ ...state, source: candidate }, progress(dispatch));
      const inspectedSource = { ...inspected.source, inputPaths: paths };
      dispatch({ type: "SET_DICOM_SOURCE", source: inspectedSource });
      const eligible = (inspected.candidates ?? []).filter((series) => series.status === "eligible");
      if (eligible.length > 1 && !inspectedSource.seriesUid) {
        setPendingSeries(eligible.map((series) => ({ seriesUid: series.seriesUid, name: series.name, sliceCount: series.sliceCount, modality: series.modality })));
        dispatch({ type: "SET_TOAST", message: `${eligible.length} eligible CT series found; choose one before caching` });
      } else if (inspectedSource.seriesUid) {
        await finishImport(inspectedSource, inspectedSource.seriesUid);
      } else {
        throw new Error("No eligible CT series was found in the selected source.");
      }
    } catch (error) {
      dispatch({ type: "SET_TOAST", message: error instanceof Error ? error.message : "DICOM import failed" });
    } finally { setImporting(false); }
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      const result = await sidecar.createPrintSelection(state, progress(dispatch));
      dispatch({ type: "SET_SELECTION_RESULT", result });
      dispatch({ type: "SET_TOAST", message: `Print selection created · ${result.physicalThicknessMm.toFixed(1)} mm physical slab` });
    } catch (error) {
      dispatch({ type: "SET_TOAST", message: error instanceof Error ? error.message : "Unable to create print selection" });
    } finally { setCreating(false); }
  };

  const setOrientation = (orientation: Orientation) => {
    dispatch({ type: "SET_SELECTION", patch: { orientation } });
    dispatch({ type: "SET_SELECTED_PANE", pane: orientation });
  };
  const physicalBounds = sourcePhysicalBounds(state.source);
  const updateCrop = (axis: keyof typeof selection.crop, side: 0 | 1, value: number) => {
    const bounds = physicalBounds[axis];
    const next = [...selection.crop[axis]] as [number, number];
    next[side] = Math.max(bounds[0], Math.min(bounds[1], value));
    if (next[0] > next[1]) next[side] = next[side === 0 ? 1 : 0];
    dispatch({ type: "SET_SELECTION", patch: { crop: { ...selection.crop, [axis]: next } } });
  };
  const positionForIndex = (index: number) => {
    const spacing = selection.orientation === "axial" ? state.source.spacing.z : selection.orientation === "sagittal" ? state.source.spacing.x : state.source.spacing.y;
    const column = selection.orientation === "axial" ? 2 : selection.orientation === "sagittal" ? 0 : 1;
    const direction = state.source.directionLps && state.source.directionLps.length === 3 ? state.source.directionLps : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const originProjection = state.source.origin.x * direction[0][column] + state.source.origin.y * direction[1][column] + state.source.origin.z * direction[2][column];
    return originProjection + index * spacing;
  };

  return <div className="workspace-layout dicom-layout">
    <aside className="left-rail dicom-rail" aria-label="DICOM source rail">
      <RailHeader title="Series" action="plus" actionLabel="Choose DICOM folder" onAction={() => void importDicom("directory")} />
      <div className="series-card selected"><div className="series-thumb"><InteractiveMprPane testAdapter={sidecar.mode !== "native"} plane="axial" result={mpr.axial} index={selection.orientation === "axial" ? selection.start : 0} selected={state.ui.selectedPane === "axial"} /></div><div className="series-copy"><strong>{state.source.name}</strong><span>{state.source.sliceCount || "—"} slices</span><span>{state.source.spacing.x ? `${state.source.spacing.x.toFixed(2)} × ${state.source.spacing.y.toFixed(2)} × ${state.source.spacing.z.toFixed(2)} mm` : "Choose a DICOM folder"}</span><StatusBadge tone={state.source.status === "ready" ? "ready" : "warning"} icon={state.source.status === "ready" ? "checkCircle" : "warning"}>{state.source.status === "ready" ? "Ready" : "Needs review"}</StatusBadge></div><IconButton label="Series options" icon="more" size={16} onClick={() => void importDicom()} /></div>
      <Disclosure title="Series details" open={detailsOpen} onToggle={() => setDetailsOpen((open) => !open)}><div className="detail-list"><div><span>SeriesInstanceUID</span><code>{state.source.seriesUid || "—"}</code></div><div><span>Source path</span><code>{state.source.path ?? "Not selected"}</code></div><div><span>Orientation</span><strong>{state.source.orientation || "—"}</strong></div><div><span>HU range</span><strong>{state.source.sliceCount ? `${state.source.huRange.min} to ${state.source.huRange.max}` : "—"}</strong></div><div><span>Series review</span><StatusBadge tone={state.source.status === "ready" ? "ready" : "warning"} icon={state.source.status === "ready" ? "check" : "warning"}>{state.source.status}</StatusBadge></div></div></Disclosure>
      <div className="rail-divider" />
      <div className="rail-evidence"><div><Icon name="database" size={16} /><span>Source boundary</span></div><strong>{isNativeRuntime() ? "Signed HU data stays in the local sidecar cache." : "Controlled test data stays in the browser adapter."}</strong><p>Preview textures are derived views and never slicing inputs.</p><Button variant="secondary" icon={importing ? "refresh" : "folder"} disabled={importing} onClick={() => void importDicom("directory")}>{importing ? "Importing…" : "Choose DICOM folder"}</Button><Button variant="quiet" icon="upload" disabled={importing} onClick={() => void importDicom("files")}>Choose ZIP or DICOM files</Button></div>
    </aside>
    <section className="workspace-center dicom-center" aria-labelledby="dicom-heading">
      <div className="center-toolbar"><div><span className="workspace-kicker">SERIES / MPR / PHYSICAL COORDINATES</span><h1 id="dicom-heading">DICOM</h1></div><div className="tool-group"><Button variant={crosshairLinked ? "quiet" : "secondary"} icon="crosshair" onClick={() => { setCrosshairLinked((value) => !value); dispatch({ type: "SET_TOAST", message: crosshairLinked ? "Crosshair linking disabled; panes are independent" : "Crosshair synchronized across all four views" }); }}>{crosshairLinked ? "Linked crosshair" : "Independent crosshair"}</Button><Button variant={windowingLinked ? "quiet" : "secondary"} icon="sliders" onClick={() => setWindowingLinked((value) => !value)}>{windowingLinked ? "Linked W/L" : "Independent W/L"}</Button><IconButton label="Reset MPR layout" icon="fit" onClick={() => dispatch({ type: "SET_TOAST", message: "MPR layout reset to synchronized 2 × 2" })} /></div></div>
      <div className="mpr-toolbar"><SegmentedControl label="Active plane" value={state.ui.selectedPane === "3d" ? "axial" : state.ui.selectedPane} options={planes.map((plane) => ({ value: plane, label: plane[0].toUpperCase() + plane.slice(1) }))} onChange={(value) => setOrientation(value as Orientation)} /><span className="mpr-toolbar-note" aria-live="polite"><Icon name="link" size={15} />{crosshairLinked ? "Linked physical coordinates" : "Independent physical coordinates"} · {windowingLinked ? "linked" : "independent"} window {Math.round(windowLevel.width)} / level {Math.round(windowLevel.center)} · {state.source.cache.preview}</span></div>
      {pendingSeries.length > 0 && <div className="series-chooser" role="dialog" aria-label="Choose DICOM series"><strong>Choose a CT series</strong><span>Multiple eligible SeriesInstanceUID values were found; no series was auto-selected.</span><select aria-label="DICOM series" defaultValue="" onChange={(event) => { const candidate = pendingSeries.find((series) => series.seriesUid === event.target.value); if (candidate) void finishImport({ ...state.source, seriesUid: candidate.seriesUid, name: candidate.name, status: "needs-review", inputPaths: state.source.inputPaths }, candidate.seriesUid); }}><option value="" disabled>Select a series…</option>{pendingSeries.map((series) => <option key={series.seriesUid} value={series.seriesUid}>{series.name || series.modality} · {series.sliceCount} slices · {series.seriesUid}</option>)}</select></div>}
      <div className="mpr-grid">{planes.map((plane) => <InteractiveMprPane key={plane} testAdapter={sidecar.mode !== "native"} plane={plane} result={mpr[plane]} index={selection.orientation === plane ? selection.start : Math.floor(planeMaxIndex(plane) / 2)} selected={state.ui.selectedPane === plane} crosshair={crosshairLinked ? linkedCrosshair : undefined} windowWidth={windowLevel.width} windowCenter={windowLevel.center} onSelect={() => setOrientation(plane)} onSliceChange={(delta) => { const current = selection.orientation === plane ? selection.start : Math.floor(planeMaxIndex(plane) / 2); const next = Math.max(0, Math.min(planeMaxIndex(plane), current + delta)); dispatch({ type: "SET_SELECTION", patch: { orientation: plane, start: next, end: Math.max(next, selection.orientation === plane ? selection.end : next) } }); dispatch({ type: "SET_SELECTED_PANE", pane: plane }); }} onCrosshair={(x, y) => { if (crosshairLinked) setLinkedCrosshair({ x, y }); const horizontalAxis = plane === "sagittal" ? "y" : "x"; const verticalAxis = plane === "axial" ? "y" : "z"; const horizontal = physicalBounds[horizontalAxis][0] + x * (physicalBounds[horizontalAxis][1] - physicalBounds[horizontalAxis][0]); const vertical = physicalBounds[verticalAxis][0] + y * (physicalBounds[verticalAxis][1] - physicalBounds[verticalAxis][0]); dispatch({ type: "SET_TOAST", message: `${plane} crosshair · LPS ${horizontalAxis.toUpperCase()} ${horizontal.toFixed(1)}, ${verticalAxis.toUpperCase()} ${vertical.toFixed(1)} mm` }); }} onWindowLevel={(width, center) => { if (windowingLinked) setWindowLevel({ width, center }); }} />)}<InteractiveVolumePreview result={volumePreview} windowWidth={windowLevel.width} windowCenter={windowLevel.center} crop={selection.crop} bounds={physicalBounds} onCropChange={(crop) => dispatch({ type: "SET_SELECTION", patch: { crop } })} /></div>
    </section>
    <aside className="right-inspector dicom-inspector" aria-label="Print selection inspector">
      <div className="inspector-title"><div><span className="workspace-kicker">PHYSICAL OUTPUT</span><h2>Print selection</h2></div><IconButton label="Selection options" icon="more" size={17} onClick={() => dispatch({ type: "SET_TOAST", message: "Selection options use patient-coordinate bounds" })} /></div>
      <div className="inspector-section"><h3>Orientation</h3><SegmentedControl label="Print orientation" value={selection.orientation} options={planes.map((plane) => ({ value: plane, label: plane[0].toUpperCase() + plane.slice(1) }))} onChange={(value) => setOrientation(value as Orientation)} /></div>
      <div className="inspector-section"><h3>Selection</h3><SegmentedControl label="Selection type" value={selection.kind} options={[{ value: "single", label: "Single slice" }, { value: "range", label: "Inclusive range" }, { value: "tiles", label: "Tile range" }]} onChange={(value) => dispatch({ type: "SET_SELECTION", patch: { kind: value as SelectionKind, outputMode: value === "tiles" ? "tiles" : selection.outputMode } })} />{selection.kind !== "single" ? <div className="range-fields"><NumberField label="Start index" value={selection.start} min={0} max={maxIndex} onChange={(value) => dispatch({ type: "SET_SELECTION", patch: { start: value } })} /><NumberField label="End index" value={selection.end} min={selection.start} max={maxIndex} onChange={(value) => dispatch({ type: "SET_SELECTION", patch: { end: value } })} /><div className="position-readout"><span>Start physical position</span><strong>{positionForIndex(selection.start).toFixed(2)} mm</strong><span>End physical position</span><strong>{positionForIndex(selection.end).toFixed(2)} mm</strong></div><div className="thickness-readout"><strong>{selection.thicknessMm.toFixed(2)} mm</strong><span>physical slab · {Math.max(1, selection.end - selection.start + 1)} planes</span></div></div> : <div className="single-note">Source plane repeated through the configured print thickness.</div>}{selection.kind === "tiles" && <div className="tile-controls"><NumberField label="Tile thickness" value={selection.tileThicknessMm ?? selection.thicknessMm} min={0.01} step={0.01} suffix="mm" onChange={(value) => dispatch({ type: "SET_SELECTION", patch: { tileThicknessMm: value } })} /><NumberField label="Tile stride" value={selection.stride} min={1} max={Math.max(1, selection.end - selection.start + 1)} onChange={(value) => dispatch({ type: "SET_SELECTION", patch: { stride: value } })} /><NumberField label="Plate columns" value={selection.tilePlateColumns ?? 4} min={1} max={12} onChange={(value) => dispatch({ type: "SET_SELECTION", patch: { tilePlateColumns: value } })} /><NumberField label="Plate rows" value={selection.tilePlateRows ?? 1} min={1} max={12} onChange={(value) => dispatch({ type: "SET_SELECTION", patch: { tilePlateRows: value } })} /><label className="checkbox-field"><input type="checkbox" checked={selection.tileOrientationMarkers ?? true} onChange={(event) => dispatch({ type: "SET_SELECTION", patch: { tileOrientationMarkers: event.target.checked } })} /> Orientation markers</label><label className="checkbox-field"><input type="checkbox" checked={selection.tileTabs ?? false} onChange={(event) => dispatch({ type: "SET_SELECTION", patch: { tileTabs: event.target.checked } })} /> Structural tabs</label></div>}</div>
      <div className="inspector-section"><h3>Output mode</h3><SegmentedControl label="Output mode" value={selection.outputMode} options={[{ value: "continuous", label: "Continuous volume" }, { value: "tiles", label: "Separate tiles" }]} onChange={(value) => dispatch({ type: "SET_SELECTION", patch: { outputMode: value as OutputMode } })} /></div>
      <Disclosure title="Crop dimensions" open={cropOpen} onToggle={() => setCropOpen((open) => !open)} action={<IconButton label="Reset crop bounds" icon="crop" size={16} onClick={() => dispatch({ type: "SET_SELECTION", patch: { crop: physicalBounds } })} />}><div className="crop-readout"><strong>{Math.abs(selection.crop.x[1] - selection.crop.x[0]).toFixed(1)} × {Math.abs(selection.crop.y[1] - selection.crop.y[0]).toFixed(1)} × {Math.abs(selection.crop.z[1] - selection.crop.z[0]).toFixed(1)} mm</strong><span>Patient-coordinate bounds · oriented source clamped</span></div><div className="crop-fields"><div><span>X bounds</span><NumberField label="X min" value={selection.crop.x[0]} min={physicalBounds.x[0]} max={selection.crop.x[1]} step={0.1} suffix="mm" onChange={(value) => updateCrop("x", 0, value)} /><NumberField label="X max" value={selection.crop.x[1]} min={selection.crop.x[0]} max={physicalBounds.x[1]} step={0.1} suffix="mm" onChange={(value) => updateCrop("x", 1, value)} /></div><div><span>Y bounds</span><NumberField label="Y min" value={selection.crop.y[0]} min={physicalBounds.y[0]} max={selection.crop.y[1]} step={0.1} suffix="mm" onChange={(value) => updateCrop("y", 0, value)} /><NumberField label="Y max" value={selection.crop.y[1]} min={selection.crop.y[0]} max={physicalBounds.y[1]} step={0.1} suffix="mm" onChange={(value) => updateCrop("y", 1, value)} /></div><div><span>Z bounds</span><NumberField label="Z min" value={selection.crop.z[0]} min={physicalBounds.z[0]} max={selection.crop.z[1]} step={0.1} suffix="mm" onChange={(value) => updateCrop("z", 0, value)} /><NumberField label="Z max" value={selection.crop.z[1]} min={selection.crop.z[0]} max={physicalBounds.z[1]} step={0.1} suffix="mm" onChange={(value) => updateCrop("z", 1, value)} /></div></div><FieldRowCompact label="Scale"><div className="number-field"><input aria-label="Scale" type="number" value={selection.scale.toFixed(2)} step="0.05" min="0.1" max="10" onChange={(event) => dispatch({ type: "SET_SELECTION", patch: { scale: Number(event.target.value) } })} /><span>×</span></div></FieldRowCompact><div className="crop-coordinates"><code>{selection.crop.x.join(" … ")} mm</code><code>{selection.crop.y.join(" … ")} mm</code><code>{selection.crop.z.join(" … ")} mm</code></div></Disclosure>
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
