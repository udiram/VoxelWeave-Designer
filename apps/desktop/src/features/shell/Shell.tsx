import type { PropsWithChildren } from "react";
import { useProject } from "../../state/ProjectContext";
import type { WorkspaceId } from "../../types";
import { Icon, type IconName } from "../../components/icons";
import { IconButton } from "../../components/ui";

export const WORKSPACES: Array<{ id: WorkspaceId; label: string; icon: IconName }> = [
  { id: "design", label: "Design", icon: "design" },
  { id: "dicom", label: "DICOM", icon: "dicom" },
  { id: "calibrate", label: "Calibrate", icon: "calibrate" },
  { id: "prepare", label: "Prepare", icon: "prepare" },
  { id: "send", label: "Send", icon: "send" },
  { id: "verify", label: "Verify", icon: "verify" },
];

export function Shell({ children }: PropsWithChildren) {
  const { state, dispatch } = useProject();
  const workspace = WORKSPACES.find((item) => item.id === state.ui.workspace) ?? WORKSPACES[0];

  return <div className="app-frame">
    <header className="app-header">
      <div className="titlebar">
        <div className="traffic-lights" aria-hidden="true"><span className="traffic red" /><span className="traffic yellow" /><span className="traffic green" /></div>
        <span className="product-title">VoxelWeave Designer</span>
        <span className="title-divider" aria-hidden="true" />
        <span className="document-title">{state.name}</span>
        <span className="demo-label">SYNTHETIC / RESEARCH</span>
      </div>
      <div className="workspace-toolbar">
        <button className="project-trigger" type="button" onClick={() => dispatch({ type: "OPEN_SYNTHETIC_PROJECT" })} aria-label="Open synthetic project" data-testid="open-synthetic-project">
          <Icon name="folder" size={18} /><span>{state.name}</span><Icon name="chevronDown" size={15} />
        </button>
        <nav className="workspace-nav" aria-label="Workspaces">
          {WORKSPACES.map((item) => <button key={item.id} type="button" className={`workspace-tab ${state.ui.workspace === item.id ? "active" : ""}`} aria-current={state.ui.workspace === item.id ? "page" : undefined} onClick={() => dispatch({ type: "SET_WORKSPACE", workspace: item.id })}>
            <Icon name={item.icon} size={18} /><span>{item.label}</span>
          </button>)}
        </nav>
        <div className="toolbar-actions"><IconButton label="Project information" icon="info" onClick={() => dispatch({ type: "SET_TOAST", message: "Research-only project · no patient identifiers stored" })} /><IconButton label="Settings" icon="settings" onClick={() => dispatch({ type: "SET_TOAST", message: "Desktop settings are local to this project" })} /><IconButton label="Open command menu" icon="more" onClick={() => dispatch({ type: "SET_TOAST", message: "Command menu: use the six workspace tabs to move through the run" })} /></div>
      </div>
      <div className="mobile-workspace-context"><Icon name={workspace.icon} size={16} /><span>{workspace.label}</span><span className="mobile-context-note">{state.name}</span><button className="mobile-project-action" type="button" onClick={() => dispatch({ type: "OPEN_SYNTHETIC_PROJECT" })} aria-label="Open synthetic project" data-testid="open-synthetic-project-mobile"><Icon name="folder" size={14} /></button></div>
    </header>
    <main className={`app-main workspace-${state.ui.workspace}`} aria-label={`${workspace.label} workspace`}>{children}</main>
    <div className="toast-region" aria-live="polite" aria-atomic="true">{state.ui.toast && <div className="toast-message"><Icon name="info" size={15} /><span>{state.ui.toast}</span><button type="button" onClick={() => dispatch({ type: "CLEAR_TOAST" })} aria-label="Dismiss notification">×</button></div>}</div>
  </div>;
}

export function AppStatusBar({ crosshair = "24.6, −112.4, 38.0 mm · −782 HU", warning = false }: { crosshair?: string; warning?: boolean }) {
  const { state } = useProject();
  return <footer className="status-bar" aria-label="Project evidence status">
    <div className="status-item"><Icon name="database" size={16} /><span>Scientific source: <strong>full-resolution HU cache</strong></span></div>
    <div className="status-item"><Icon name="cube" size={16} /><span>Preview: <strong>{state.source.cache.preview}</strong></span></div>
    <div className="status-item status-crosshair" aria-live="polite"><Icon name="crosshair" size={16} /><span>Crosshair: <strong>{crosshair}</strong></span></div>
    <div className={`status-item status-boundary ${warning ? "is-warning" : ""}`} aria-live="polite">{warning ? <Icon name="warning" size={16} /> : <Icon name="checkCircle" size={16} />}<span>{warning ? "1 review item" : "No automatic print start"}</span></div>
  </footer>;
}

export function RailHeader({ title, action, onAction, actionLabel }: { title: string; action?: IconName; onAction?: () => void; actionLabel?: string }) {
  return <div className="rail-header"><h2>{title}</h2>{action && onAction && <IconButton label={actionLabel ?? `Add ${title.toLowerCase()}`} icon={action} onClick={onAction} />}</div>;
}
