import { useState } from "react";
import { useProject } from "../../state/ProjectContext";
import { Button, Disclosure, Notice, StatusBadge, IconButton } from "../../components/ui";
import { Icon } from "../../components/icons";
import { AppStatusBar, RailHeader } from "../shell/Shell";

export function SendWorkspace() {
  const { state, dispatch, sidecar } = useProject();
  const [manifestOpen, setManifestOpen] = useState(true);
  const [exporting, setExporting] = useState(false);
  const files = state.send.files ?? ["toolpath.gcode", "toolpath_preview.bin", "toolpath_trace.bin", "selection_manifest.json", "coordinate_transforms.json", "run_report.json", "hashes.json"];

  const exportPackage = async () => {
    setExporting(true);
    try {
      const result = await sidecar.exportRunPackage(state, (event) => dispatch({ type: "SET_TOAST", message: `${event.stage} · ${Math.round(event.progress * 100)}%` }));
      dispatch({ type: "EXPORT_RUN_PACKAGE", packageName: result.packageName, packageDirectory: result.packageDirectory, exportHash: result.exportHash, files: result.files });
      dispatch({ type: "SET_TOAST", message: `Exported ${result.packageName} · ${result.exportHash}` });
    } catch (error) { dispatch({ type: "SET_TOAST", message: error instanceof Error ? error.message : "Run package export failed" }); }
    finally { setExporting(false); }
  };

  return <div className="workspace-layout send-layout">
    <aside className="left-rail send-rail" aria-label="Send package rail">
      <RailHeader title="Run package" action="refresh" actionLabel="Refresh package state" onAction={() => dispatch({ type: "SET_TOAST", message: state.send.packageExported ? "Package is current with the audited run" : "Package will be created after audit" })} />
      <div className="package-identity"><Icon name="file" size={20} /><strong>{state.send.packageExported ? state.send.packageName : "Not exported"}</strong><span>Run ID · {state.toolpath.runId ?? "pending"}</span></div>
      <div className="rail-divider" />
      <div className="package-file-list"><span className="list-label">Included artifacts</span>{files.map((file) => <div key={file}><Icon name="check" size={14} /><span>{file}</span></div>)}</div>
      <div className="rail-bottom"><Button variant="quiet" icon="download" disabled={!state.send.packageExported} onClick={() => dispatch({ type: "SET_TOAST", message: "The browser adapter records export intent; Tauri writes the file to the selected folder" })}>Save copy</Button></div>
    </aside>
    <section className="workspace-center send-center" aria-labelledby="send-heading">
      <div className="center-toolbar"><div><span className="workspace-kicker">LOCAL EXPORT / ATTENDED HANDOFF</span><h1 id="send-heading">Send</h1></div><div className="tool-group"><IconButton label="Inspect package manifest" icon="file" onClick={() => setManifestOpen(true)} /><IconButton label="Send help" icon="help" onClick={() => dispatch({ type: "SET_TOAST", message: "Send never starts a printer automatically" })} /></div></div>
      <div className="send-hero"><div className="send-hero-copy"><span className="workspace-kicker">LOCAL EXPORT / ATTENDED HANDOFF</span><h2>{state.send.packageExported ? "Package ready for handoff" : "Export the audited run package"}</h2><p>{state.send.packageExported ? "The exact artifacts are ready for local inspection and an attended external printer workflow." : "The package contains plaintext G-code, manifests, transforms, exact preview data, and hashes."}</p><div className="send-actions"><Button variant="primary" icon={state.send.packageExported ? "check" : "download"} disabled={!state.toolpath.audited || exporting} onClick={exportPackage} data-testid="export-run-package">{exporting ? "Exporting…" : state.send.packageExported ? "Package exported" : "Export run package"}</Button></div></div><div className="receipt-block"><div className="receipt-line"><Icon name={state.toolpath.audited ? "checkCircle" : "lock"} size={19} /><span>Reverse audit</span><strong>{state.toolpath.audited ? "passed" : "blocked"}</strong></div><div className="receipt-line"><Icon name="database" size={19} /><span>Scientific source</span><strong>full-resolution HU cache</strong></div><div className="receipt-line"><Icon name="external" size={19} /><span>Printer action</span><strong>attended only · local export</strong></div></div></div>
      {state.send.packageExported ? <Notice tone="success" title="Local export complete">The run package is deterministic and inspectable. Software export does not prove deposited geometry or physical HU fidelity.</Notice> : <Notice tone="info" title="Export boundary">A successful preview or G-code generation never starts the printer. Physical validation remains a separate evidence step.</Notice>}
      <div className="package-table"><div className="table-caption"><span>Package contents</span><span>{files.length} artifacts</span></div><table><thead><tr><th>Artifact</th><th>Purpose</th><th>State</th></tr></thead><tbody>{files.map((file) => <tr key={file}><td><code>{file}</code></td><td>{artifactPurpose(file)}</td><td><StatusBadge tone={state.send.packageExported ? "ready" : "neutral"} icon={state.send.packageExported ? "check" : "lock"}>{state.send.packageExported ? "included" : "pending"}</StatusBadge></td></tr>)}</tbody></table></div>
    </section>
    <aside className="right-inspector send-inspector" aria-label="Send connection inspector">
      <div className="inspector-title"><div><span className="workspace-kicker">HANDOFF</span><h2>Local package</h2></div><IconButton label="Export details" icon="more" size={17} onClick={() => dispatch({ type: "SET_TOAST", message: "Exports remain local, inspectable, and operator-controlled" })} /></div>
      <div className="connection-state"><Icon name="checkCircle" size={16} /><div><strong>{state.send.connection}</strong><span>{sidecar.mode === "native" ? "Native Tauri sidecar · app-owned export directory" : "Controlled browser/test adapter · no external transfer"}</span></div></div>
      <Disclosure title="Manifest" open={manifestOpen} onToggle={() => setManifestOpen((open) => !open)}><div className="manifest-list"><div><span>Project</span><strong>{state.name}</strong></div><div><span>Run</span><strong>{state.toolpath.runId ?? "pending"}</strong></div><div><span>Hash</span><code>{state.send.exportHash ?? "—"}</code></div><div><span>Files</span><strong>{files.length}</strong></div></div></Disclosure>
      <div className="inspector-note"><Icon name="info" size={15} /><span>This release performs no printer-service upload and never starts a printer.</span></div>
      <div className="inspector-actions"><Button variant="quiet" icon="arrowUpRight" onClick={() => dispatch({ type: "SET_WORKSPACE", workspace: "verify" })}>Continue to Verify</Button><Button variant="quiet" icon="help" onClick={() => dispatch({ type: "SET_TOAST", message: "Verify imports scan-back evidence and exports a separate report" })}>What comes next?</Button></div>
    </aside>
    <AppStatusBar />
  </div>;
}

function artifactPurpose(file: string): string {
  if (file === "toolpath.gcode") return "Audited machine instructions";
  if (file === "toolpath_preview.bin") return "Exact generated segment preview";
  if (file === "toolpath_trace.bin") return "Audited multi-tool trace";
  if (file === "selection_manifest.json") return "Physical source selection";
  if (file === "coordinate_transforms.json") return "Bidirectional coordinate transforms";
  if (file === "run_report.json") return "Run report and reverse audit";
  if (file === "hashes.json") return "SHA-256 artifact index";
  return "Sidecar-returned run artifact";
}
