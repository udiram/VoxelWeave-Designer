import { useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useProject } from "../../state/ProjectContext";
import { authorizeNativePath, isNativeRuntime } from "../../services/projectDocument";
import { validateCalibrationProfile } from "../../state/projectState";
import { Button, Disclosure, Notice, NumberField, SegmentedControl, StatusBadge, IconButton, TextField } from "../../components/ui";
import { Icon } from "../../components/icons";
import { CalibrationPlot } from "../../components/visuals";
import { AppStatusBar, RailHeader } from "../shell/Shell";
import type { CalibrationProfile, ToolId } from "../../types";

function emptyCalibration(tool: ToolId, id = `cal-${tool.toLowerCase()}-${Date.now()}`): CalibrationProfile {
  return {
    id,
    name: "",
    tool,
    material: "",
    lot: "",
    printer: "",
    scanner: "",
    reconstruction: "",
    nozzleMm: 0,
    layerHeightMm: 0,
    accepted: false,
    widthRange: [0, 0],
    huSamples: [],
  };
}

export function CalibrateWorkspace() {
  const { state, dispatch, sidecar } = useProject();
  const [tool, setTool] = useState<ToolId>("T0");
  const [selectedProfileId, setSelectedProfileId] = useState<string>();
  const [evidenceOpen, setEvidenceOpen] = useState(true);
  const profile = useMemo(() => state.calibrations.find((candidate) => candidate.id === selectedProfileId) ?? state.calibrations.find((candidate) => candidate.tool === tool) ?? state.calibrations[0], [selectedProfileId, state.calibrations, tool]);
  const validationErrors = profile ? validateCalibrationProfile(profile) : [];
  const hasAcceptedProfile = state.calibrations.some((candidate) => candidate.accepted);
  const acceptanceNotice = profile ? (validationErrors.length > 0
    ? <Notice tone="warning" title="Profile cannot be accepted"><span>{validationErrors.join(" · ")}</span></Notice>
    : <Notice tone="success" title={profile.accepted ? "Profile accepted" : "Ready for acceptance"}><span>{profile.accepted ? "This binding is eligible for sidecar generation." : "Review the local evidence and accept this binding to enable generation."}</span></Notice>)
    : null;

  const createProfile = () => {
    const next = emptyCalibration(tool);
    dispatch({ type: "UPSERT_CALIBRATION_PROFILE", profile: next });
    setSelectedProfileId(next.id);
    setTool(next.tool);
  };

  const updateProfile = (patch: Partial<CalibrationProfile>) => {
    if (profile) dispatch({ type: "UPDATE_CALIBRATION_PROFILE", id: profile.id, patch });
  };

  const updateSample = (index: number, patch: Partial<CalibrationProfile["huSamples"][number]>) => {
    if (!profile) return;
    const huSamples = profile.huSamples.map((sample, sampleIndex) => sampleIndex === index ? { ...sample, ...patch } : sample);
    updateProfile({ huSamples });
  };

  const importProfile = async () => {
    if (!isNativeRuntime()) {
      dispatch({ type: "SET_TOAST", message: "Calibration profile import requires the native desktop runtime" });
      return;
    }
    try {
      const selected = await open({ directory: false, multiple: false, title: "Import calibration profile", filters: [{ name: "Calibration JSON", extensions: ["json", "calibration"] }] });
      if (typeof selected !== "string") return;
      await authorizeNativePath(selected);
      const raw = JSON.parse(await invoke<string>("read_authorized_text_file", { path: selected })) as Partial<CalibrationProfile>;
      const importedTool: ToolId = raw.tool === "T1" ? "T1" : "T0";
      const imported: CalibrationProfile = {
        ...emptyCalibration(importedTool, typeof raw.id === "string" && raw.id ? raw.id : undefined),
        ...raw,
        tool: importedTool,
        accepted: false,
        huSamples: Array.isArray(raw.huSamples) ? raw.huSamples : [],
      };
      dispatch({ type: "UPSERT_CALIBRATION_PROFILE", profile: imported });
      setSelectedProfileId(imported.id);
      setTool(imported.tool);
    } catch (error) {
      dispatch({ type: "SET_TOAST", message: error instanceof Error ? `Calibration import failed: ${error.message}` : "Calibration import failed" });
    }
  };

  return <div className="workspace-layout calibrate-layout">
    <aside className="left-rail calibrate-rail" aria-label="Calibration profiles rail">
      <RailHeader title="Profiles" action="plus" actionLabel="Create calibration profile" onAction={createProfile} />
      <div className="profile-list">{state.calibrations.length ? state.calibrations.map((candidate) => <button type="button" key={candidate.id} className={`profile-row ${candidate.id === profile?.id ? "selected" : ""}`} onClick={() => { setSelectedProfileId(candidate.id); setTool(candidate.tool); }}><span className={`tool-swatch ${candidate.tool.toLowerCase()}`} /><span className="profile-copy"><strong>{candidate.name || "Unnamed calibration"}</strong><small>{candidate.printer || "Printer not bound"}</small><small>{candidate.scanner || "Scanner not bound"}</small></span><StatusBadge tone={candidate.accepted ? "ready" : "warning"} icon={candidate.accepted ? "checkCircle" : "warning"}>{candidate.accepted ? "Accepted" : "Review"}</StatusBadge></button>) : <Notice tone="info" title="No calibration profiles"><span>Create a profile or import a local calibration JSON. Generation stays blocked until explicit acceptance.</span><Button variant="secondary" icon="plus" onClick={createProfile} data-testid="create-calibration-profile">Create profile</Button></Notice>}</div>
      <div className="rail-divider" />
      <div className="binding-summary"><div><Icon name="link" size={15} /><span>Bound fields</span></div><p>Tool · material · lot · printer · scanner · reconstruction</p><StatusBadge tone={profile && validationErrors.length === 0 ? "ready" : "warning"} icon={profile && validationErrors.length === 0 ? "check" : "warning"}>{profile && validationErrors.length === 0 ? "validated" : "needs review"}</StatusBadge></div>
      <div className="rail-bottom"><Button variant="secondary" icon="upload" onClick={() => void importProfile()} data-testid="import-calibration-profile">Import calibration JSON</Button><Button variant="quiet" icon="file" onClick={() => dispatch({ type: "SET_TOAST", message: "Calibration evidence manifest is available in the local run package" })}>Open evidence manifest</Button></div>
    </aside>
    <section className="workspace-center calibrate-center" aria-labelledby="calibrate-heading">
      <div className="center-toolbar"><div><span className="workspace-kicker">RAIL WIDTH → HU EVIDENCE</span><h1 id="calibrate-heading">Calibrate</h1></div><div className="tool-group"><Button variant="quiet" icon="refresh" onClick={() => dispatch({ type: "SET_TOAST", message: sidecar.mode === "native" ? "Calibration samples are read from the local evidence manifest" : "Calibration samples refreshed from the controlled test adapter" })}>Refresh samples</Button><IconButton label="Calibration help" icon="help" onClick={() => dispatch({ type: "SET_TOAST", message: "Commanded rail width is the independent variable; pitch and layer height stay locked" })} /></div></div>
      <div className="calibrate-toolbar"><SegmentedControl label="Tool profile" value={tool} options={[{ value: "T0", label: "T0" }, { value: "T1", label: "T1" }]} onChange={(value) => { setTool(value as ToolId); setSelectedProfileId(undefined); }} /><span className="mpr-toolbar-note"><Icon name="database" size={15} />Source: {sidecar.mode === "native" ? "local signed-HU calibration evidence" : "controlled browser calibration fixture"}</span></div>
      {profile ? <>
        <div className="calibration-summary"><div><span>Profile</span><strong>{profile.name || "Unnamed calibration"}</strong></div><div><span>Width boundary</span><strong>{profile.widthRange[0].toFixed(2)}–{profile.widthRange[1].toFixed(2)} mm</strong></div><div><span>Layer height</span><strong>{profile.layerHeightMm > 0 ? `${profile.layerHeightMm.toFixed(2)} mm` : "Not set"}</strong></div><div><span>Evidence state</span><StatusBadge tone={profile.accepted ? "ready" : "warning"} icon={profile.accepted ? "check" : "warning"}>{profile.accepted ? "accepted" : "review required"}</StatusBadge></div></div>
        <div className="calibration-main"><div className="plot-panel"><div className="plot-heading"><div><h2>Rail field fit</h2><p>Measured HU samples · interpolation stays inside the accepted width range.</p></div><StatusBadge tone={validationErrors.length ? "warning" : "ready"} icon={validationErrors.length ? "warning" : "check"}>{validationErrors.length ? "needs review" : "fit stable"}</StatusBadge></div><CalibrationPlot tool={tool} samples={profile.huSamples} /><div className="plot-legend"><span><i className="legend-line teal" />Measured samples</span><span><i className="legend-line sienna" />Requested width</span><span><i className="legend-range" />Accepted boundary</span></div></div><div className="sample-table" aria-label="Calibration HU samples"><div className="table-caption"><span>HU samples</span><span>{profile.huSamples.length} rows · edit before acceptance</span><Button variant="quiet" icon="plus" onClick={() => updateProfile({ huSamples: [...profile.huSamples, { widthMm: profile.widthRange[0] || 0.4, measuredHu: 0, targetHu: 0 }] })} data-testid="add-calibration-sample">Add sample</Button></div><table><thead><tr><th>Width</th><th>Measured HU</th><th>Target HU</th><th>Δ HU</th></tr></thead><tbody>{profile.huSamples.map((sample, index) => <tr key={`${profile.id}-${index}`}><td><input aria-label={`Sample ${index + 1} width`} type="number" step="0.01" value={sample.widthMm} onChange={(event) => updateSample(index, { widthMm: Number(event.target.value) })} /></td><td><input aria-label={`Sample ${index + 1} measured HU`} type="number" step="1" value={sample.measuredHu} onChange={(event) => updateSample(index, { measuredHu: Number(event.target.value) })} /></td><td><input aria-label={`Sample ${index + 1} target HU`} type="number" step="1" value={sample.targetHu} onChange={(event) => updateSample(index, { targetHu: Number(event.target.value) })} /></td><td className={Math.abs(sample.measuredHu - sample.targetHu) > 25 ? "warning-text" : ""}>{sample.measuredHu - sample.targetHu > 0 ? "+" : ""}{sample.measuredHu - sample.targetHu}</td></tr>)}</tbody></table><div className="table-foot"><Icon name="info" size={14} /><span>{sidecar.mode === "native" ? "Calibration evidence remains local and must be bound to the selected printer and scanner." : "Target values are controlled browser adapter fixtures, not clinical thresholds."}</span></div></div></div>
        <div className="calibration-actions"><Button variant="secondary" icon="ruler" onClick={() => dispatch({ type: "SET_TOAST", message: `Fit recomputed for ${profile.name || "calibration"}; review the acceptance boundary` })}>Fit rail field</Button>{profile.accepted ? <Button variant="danger" icon="warning" onClick={() => dispatch({ type: "REVOKE_CALIBRATION_PROFILE", id: profile.id })} data-testid="revoke-calibration">Revoke acceptance</Button> : <Button variant="primary" icon="check" onClick={() => dispatch({ type: "ACCEPT_CALIBRATION_PROFILE", id: profile.id })} disabled={validationErrors.length > 0} data-testid="accept-calibration">Accept calibration</Button>}<Button variant="quiet" icon="check" onClick={() => dispatch({ type: "REVIEW_CALIBRATION", profileId: profile.id })} disabled={!profile.accepted} data-testid="review-calibration">Review calibration</Button></div>
      </> : <div className="calibration-empty"><Notice tone="info" title="Create or import a calibration profile"><span>No calibration data is loaded in this native project. Add printer, scanner, material, width, and HU evidence, then explicitly accept it before generation.</span><Button variant="primary" icon="plus" onClick={createProfile} data-testid="create-calibration-profile">Create calibration profile</Button></Notice></div>}
    </section>
    <aside className="right-inspector calibration-inspector" aria-label="Calibration inspector">
      <div className="inspector-title"><div><span className="workspace-kicker">BOUND PROTOCOL</span><h2>{profile ? `${profile.tool} profile` : "No profile"}</h2></div><IconButton label="Profile options" icon="more" size={17} onClick={() => dispatch({ type: "SET_TOAST", message: "Profile options are local to this project" })} /></div>
      {profile ? <>
        <div className="inspector-section"><h3>Identity</h3><TextField label="Profile name" value={profile.name} placeholder="e.g. T0 Natural PLA / 0.25 mm" onChange={(event) => updateProfile({ name: event.target.value })} /><TextField label="Material" value={profile.material} placeholder="Material and blend" onChange={(event) => updateProfile({ material: event.target.value })} /><TextField label="Lot" value={profile.lot} placeholder="Lot or batch identifier" onChange={(event) => updateProfile({ lot: event.target.value })} /><TextField label="Printer" value={profile.printer} placeholder="Printer identity" onChange={(event) => updateProfile({ printer: event.target.value })} /><TextField label="Scanner" value={profile.scanner} placeholder="Scanner identity" onChange={(event) => updateProfile({ scanner: event.target.value })} /><TextField label="Reconstruction" value={profile.reconstruction} placeholder="Reconstruction kernel / protocol" onChange={(event) => updateProfile({ reconstruction: event.target.value })} /></div>
        <Disclosure title="Acceptance boundary" open={evidenceOpen} onToggle={() => setEvidenceOpen((open) => !open)}><div className="boundary-readout"><NumberField label="Nozzle" value={profile.nozzleMm} suffix="mm" min={0} step={0.01} onChange={(value) => updateProfile({ nozzleMm: value })} /><NumberField label="Layer height" value={profile.layerHeightMm} suffix="mm" min={0} step={0.01} onChange={(value) => updateProfile({ layerHeightMm: value })} /><NumberField label="Minimum width" value={profile.widthRange[0]} suffix="mm" min={0} step={0.01} onChange={(value) => updateProfile({ widthRange: [value, profile.widthRange[1]] })} /><NumberField label="Maximum width" value={profile.widthRange[1]} suffix="mm" min={0} step={0.01} onChange={(value) => updateProfile({ widthRange: [profile.widthRange[0], value] })} /></div></Disclosure>
        {acceptanceNotice}
      </> : <Notice tone="info" title="No calibration selected"><span>Create or import a profile to edit identity, acceptance bounds, and HU samples.</span></Notice>}
      <div className="inspector-note"><Icon name="warning" size={15} /><span>Out-of-range commanded widths fail closed. Silent extrapolation is not permitted.</span></div>
      <div className="inspector-actions"><Button variant="primary" icon="arrowUpRight" onClick={() => dispatch({ type: "SET_WORKSPACE", workspace: "prepare" })} disabled={!hasAcceptedProfile || !state.selection.created}>Continue to Prepare</Button>{profile?.accepted && <span className="gate-note">Calibration explicitly accepted for this project.</span>}</div>
    </aside>
    <AppStatusBar crosshair={profile ? `calibration ${profile.tool} · ${profile.widthRange[0].toFixed(2)}–${profile.widthRange[1].toFixed(2)} mm` : "no calibration profile accepted"} warning={!hasAcceptedProfile} />
  </div>;
}
