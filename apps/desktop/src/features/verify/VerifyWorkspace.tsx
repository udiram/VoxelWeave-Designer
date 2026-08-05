import { useState } from "react";
import { useProject } from "../../state/ProjectContext";
import { Button, Disclosure, SegmentedControl, SelectField, StatusBadge, Notice, IconButton } from "../../components/ui";
import { Icon } from "../../components/icons";
import { ComparisonViewport } from "../../components/visuals";
import { AppStatusBar, RailHeader } from "../shell/Shell";
import type { ComparisonMode, VerifyState } from "../../types";

export function VerifyWorkspace() {
  const { state, dispatch, sidecar } = useProject();
  const [evidenceOpen, setEvidenceOpen] = useState(true);
  const [registrationOpen, setRegistrationOpen] = useState(true);
  const [importing, setImporting] = useState(false);
  const verify = state.verify;

  const importEvidence = async () => {
    setImporting(true);
    const result = await sidecar.verifyScanBack(state, (event) => dispatch({ type: "SET_TOAST", message: `${event.stage} · ${Math.round(event.progress * 100)}%` }));
    dispatch({ type: "IMPORT_SCAN_BACK" });
    dispatch({ type: "SET_REGISTRATION", method: result.registrationMethod, confidence: result.confidence });
    dispatch({ type: "SET_TOAST", message: `Imported ${result.evidenceName} · registration confidence ${result.confidence}` });
    setImporting(false);
  };

  return <div className="workspace-layout verify-layout">
    <aside className="left-rail verify-rail" aria-label="Verify evidence rail">
      <RailHeader title="Evidence" action="plus" actionLabel="Import scan-back evidence" onAction={importEvidence} />
      <div className={`evidence-row ${verify.evidenceImported ? "selected" : ""}`}><Icon name="scan" size={18} /><div><strong>{verify.evidenceImported ? verify.evidenceName : "No scan-back selected"}</strong><span>{verify.evidenceImported ? "TIFF · 482,104 registered voxels" : "Import deterministic evidence to continue"}</span></div>{verify.evidenceImported && <StatusBadge tone="ready" icon="check">ready</StatusBadge>}</div>
      <div className="rail-divider" />
      <div className="verification-list"><span className="list-label">Evidence chain</span><div><Icon name="check" size={14} /><span>Source transform recorded</span></div><div><Icon name={verify.evidenceImported ? "check" : "lock"} size={14} /><span>Scan-back registered</span></div><div><Icon name={verify.reportExported ? "check" : "lock"} size={14} /><span>Report exported</span></div></div>
      <div className="rail-bottom"><Button variant="quiet" icon="file" disabled={!verify.reportExported} onClick={() => dispatch({ type: "SET_TOAST", message: "Report package is ready in the local export directory" })}>Open report package</Button></div>
    </aside>
    <section className="workspace-center verify-center" aria-labelledby="verify-heading">
      <div className="center-toolbar"><div><span className="workspace-kicker">SCAN-BACK / REGISTRATION / COMPARISON</span><h1 id="verify-heading">Verify</h1></div><div className="tool-group"><Button variant="quiet" icon="refresh" onClick={() => dispatch({ type: "SET_TOAST", message: "Comparison view refreshed from the registered evidence" })}>Refresh comparison</Button><IconButton label="Verify help" icon="help" onClick={() => dispatch({ type: "SET_TOAST", message: "HU comparison is distinct from dose gamma and is not diagnostic" })} /></div></div>
      <div className="verify-toolbar"><SegmentedControl label="Comparison mode" value={verify.comparisonMode} options={[{ value: "overlay", label: "Overlay" }, { value: "difference", label: "Difference" }, { value: "profile", label: "Profile" }]} onChange={(value) => dispatch({ type: "SET_COMPARISON_MODE", mode: value as ComparisonMode })} /><span className="mpr-toolbar-note"><Icon name="target" size={15} />{verify.evidenceImported ? "Registered to source coordinates" : "Waiting for registered scan-back"}</span></div>
      <ComparisonViewport mode={verify.comparisonMode} />
      <div className="verification-metrics"><div><span>Mean absolute HU</span><strong>{verify.evidenceImported ? verify.comparison.meanAbsoluteHu : "—"}</strong><small>{verify.evidenceImported ? "synthetic comparison" : "not available"}</small></div><div><span>95th percentile |HU|</span><strong>{verify.evidenceImported ? verify.comparison.p95AbsoluteHu : "—"}</strong><small>{verify.evidenceImported ? "registered voxels" : "import evidence"}</small></div><div><span>Registered voxels</span><strong>{verify.evidenceImported ? verify.comparison.registeredVoxels.toLocaleString() : "—"}</strong><small>source-to-scan transform</small></div><div><span>Confidence</span><StatusBadge tone={verify.evidenceImported ? "ready" : "neutral"} icon={verify.evidenceImported ? "checkCircle" : "lock"}>{verify.evidenceImported ? verify.confidence : "pending"}</StatusBadge><small>registration evidence</small></div></div>
      {!verify.evidenceImported && <Notice tone="info" title="Scan-back evidence required">Import a deterministic scan-back file, select a registration method, and record confidence before exporting the report.</Notice>}
      {verify.evidenceImported && <Notice tone="success" title="Comparison ready">The report records registration, raw and transformed evidence references, and the distinction between software comparison and physical fidelity.</Notice>}
    </section>
    <aside className="right-inspector verify-inspector" aria-label="Verify registration inspector">
      <div className="inspector-title"><div><span className="workspace-kicker">EVIDENCE CONTROL</span><h2>Registration</h2></div><IconButton label="Registration options" icon="more" size={17} onClick={() => dispatch({ type: "SET_TOAST", message: "Registration options preserve the raw evidence reference" })} /></div>
      <Disclosure title="Evidence" open={evidenceOpen} onToggle={() => setEvidenceOpen((open) => !open)}><div className="evidence-inspector"><div><span>File</span><strong>{verify.evidenceName ?? "Not imported"}</strong></div><div><span>Source run</span><strong>{state.toolpath.runId ?? "Not generated"}</strong></div><div><span>Evidence type</span><strong>Scan-back TIFF</strong></div></div><Button variant="secondary" icon={importing ? "refresh" : "upload"} disabled={importing} onClick={importEvidence} data-testid="import-scan-back">{importing ? "Importing…" : verify.evidenceImported ? "Re-import scan-back" : "Import scan-back evidence"}</Button></Disclosure>
      <Disclosure title="Registration method" open={registrationOpen} onToggle={() => setRegistrationOpen((open) => !open)}><SelectField label="Method" value={verify.registrationMethod} onChange={(event) => dispatch({ type: "SET_REGISTRATION", method: event.target.value as VerifyState["registrationMethod"], confidence: verify.confidence })}><option value="not registered">Not registered</option><option value="landmark rigid">Landmark rigid</option><option value="fiducial rigid">Fiducial rigid</option></SelectField><SelectField label="Confidence" value={verify.confidence} onChange={(event) => dispatch({ type: "SET_REGISTRATION", method: verify.registrationMethod, confidence: event.target.value as VerifyState["confidence"] })}><option value="high">High · landmarks agree</option><option value="medium">Medium · review needed</option><option value="low">Low · insufficient evidence</option></SelectField><div className="confidence-note"><Icon name={verify.confidence === "high" ? "checkCircle" : "warning"} size={16} /><span>{verify.confidence === "high" ? "Registration confidence is recorded for this evidence." : "Record why this confidence is appropriate before reporting."}</span></div></Disclosure>
      <div className="inspector-note"><Icon name="info" size={15} /><span>No software comparison can claim deposited width or physical HU fidelity without accepted calibration and scan-back evidence.</span></div>
      <div className="inspector-actions"><Button variant="primary" icon={verify.reportExported ? "check" : "download"} disabled={!verify.evidenceImported || verify.registrationMethod === "not registered"} onClick={() => dispatch({ type: "EXPORT_REPORT" })} data-testid="export-report">{verify.reportExported ? "Report exported" : "Export verification report"}</Button><Button variant="quiet" icon="arrowUpRight" onClick={() => dispatch({ type: "SET_WORKSPACE", workspace: "design" })}>Return to Design</Button></div>
    </aside>
    <AppStatusBar crosshair={verify.evidenceImported ? "registered source · ΔHU 38 mean" : "registration pending"} />
  </div>;
}
