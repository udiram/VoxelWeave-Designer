import { useEffect, type PropsWithChildren } from "react";
import { useProject } from "../../state/ProjectContext";
import type { WorkspaceId } from "../../types";
import { Icon, type IconName } from "../../components/icons";
import { IconButton } from "../../components/ui";
import { open, save } from "@tauri-apps/plugin-dialog";
import { isNativeRuntime } from "../../services/projectDocument";

export const WORKSPACES: Array<{ id: WorkspaceId; label: string; icon: IconName }> = [
  { id: "design", label: "Design", icon: "design" },
  { id: "dicom", label: "DICOM", icon: "dicom" },
  { id: "calibrate", label: "Calibrate", icon: "calibrate" },
  { id: "prepare", label: "Prepare", icon: "prepare" },
  { id: "send", label: "Send", icon: "send" },
  { id: "verify", label: "Verify", icon: "verify" },
];

export function Shell({ children }: PropsWithChildren) {
  const { state, dispatch, openProjectFile, saveProjectFile, undoSceneEdit, redoSceneEdit } = useProject();
  const workspace = WORKSPACES.find((item) => item.id === state.ui.workspace) ?? WORKSPACES[0];
  const native = isNativeRuntime();

  useEffect(() => {
    const handleHistoryShortcut = (event: KeyboardEvent) => {
      if (state.ui.workspace !== "design" || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      if (event.shiftKey) redoSceneEdit(); else undoSceneEdit();
    };
    window.addEventListener("keydown", handleHistoryShortcut);
    return () => window.removeEventListener("keydown", handleHistoryShortcut);
  }, [redoSceneEdit, state.ui.workspace, undoSceneEdit]);

  const handleOpenProject = async () => {
    if (!native) {
      dispatch({ type: "OPEN_SYNTHETIC_PROJECT" });
      return;
    }
    try {
      const selected = await open({ directory: false, multiple: false, title: "Open VoxelWeave project", filters: [{ name: "VoxelWeave project", extensions: ["voxelweave"] }] });
      if (typeof selected === "string") await openProjectFile(selected);
    } catch (error) {
      dispatch({ type: "SET_TOAST", message: error instanceof Error ? error.message : "Unable to open project" });
    }
  };

  const handleSaveProject = async (saveAs = false) => {
    try {
      let path = saveAs ? undefined : state.ui.filePath;
      if (native && !path) path = undefined;
      if (!path && native) {
        const selected = await save({ title: "Save VoxelWeave project", defaultPath: `${state.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.voxelweave`, filters: [{ name: "VoxelWeave project", extensions: ["voxelweave"] }] });
        if (typeof selected === "string") path = selected.endsWith(".voxelweave") ? selected : `${selected}.voxelweave`;
      }
      if (path) await saveProjectFile(path);
    } catch (error) {
      dispatch({ type: "SET_TOAST", message: error instanceof Error ? error.message : "Unable to save project" });
    }
  };

  return <div className="app-frame">
    <header className="app-header">
      <div className={`titlebar ${native ? "native-titlebar" : "browser-titlebar"}`}>
        {!native && <div className="traffic-lights" aria-hidden="true"><span className="traffic red" /><span className="traffic yellow" /><span className="traffic green" /></div>}
        <span className="product-title">VoxelWeave Designer</span>
        <span className="title-divider" aria-hidden="true" />
        <span className="document-title">{state.name}</span>
        <span className="demo-label">{native ? "LOCAL / RESEARCH" : "TEST ADAPTER / RESEARCH"}</span>
      </div>
      <div className="workspace-toolbar">
        <button className="project-trigger" type="button" onClick={handleOpenProject} aria-label={native ? "Open project" : "Open synthetic project"} data-testid={native ? "open-project" : "open-synthetic-project"}>
          <Icon name="folder" size={18} /><span>{state.name}</span><Icon name="chevronDown" size={15} />
        </button>
        <div className="project-actions" aria-label="Project file actions"><IconButton label="Save project" icon="download" onClick={() => void handleSaveProject(false)} data-testid="save-project" /><IconButton label="Save project as" icon="file" onClick={() => void handleSaveProject(true)} data-testid="save-project-as" /></div>
        <nav className="workspace-nav" aria-label="Workspaces">
          {WORKSPACES.map((item) => <button key={item.id} type="button" className={`workspace-tab ${state.ui.workspace === item.id ? "active" : ""}`} aria-current={state.ui.workspace === item.id ? "page" : undefined} onClick={() => dispatch({ type: "SET_WORKSPACE", workspace: item.id })}>
            <Icon name={item.icon} size={18} /><span>{item.label}</span>
          </button>)}
        </nav>
        <div className="toolbar-actions"><IconButton label="Project information" icon="info" onClick={() => dispatch({ type: "SET_TOAST", message: "Research-only project · no patient identifiers stored" })} /><IconButton label="Settings" icon="settings" onClick={() => dispatch({ type: "SET_TOAST", message: "Desktop settings are local to this project" })} /><IconButton label="Open command menu" icon="more" onClick={() => dispatch({ type: "SET_TOAST", message: "Command menu: use the six workspace tabs to move through the run" })} /></div>
      </div>
      <div className="mobile-workspace-context"><Icon name={workspace.icon} size={16} /><label className="mobile-workspace-switch"><span className="sr-only">Switch workspace</span><select aria-label="Switch workspace" value={state.ui.workspace} onChange={(event) => dispatch({ type: "SET_WORKSPACE", workspace: event.target.value as WorkspaceId })}>{WORKSPACES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><span className="mobile-context-note">{state.name}</span><button className="mobile-project-action" type="button" onClick={() => void handleOpenProject()} aria-label={native ? "Open project" : "Open synthetic project"} data-testid={native ? "open-project-mobile" : "open-synthetic-project-mobile"}><Icon name="folder" size={14} /></button></div>
    </header>
    <main className={`app-main workspace-${state.ui.workspace}`} aria-label={`${workspace.label} workspace`}>{children}</main>
    <div className="toast-region" aria-live="polite" aria-atomic="true">{state.ui.toast && <div className="toast-message"><Icon name="info" size={15} /><span>{state.ui.toast}</span><button type="button" onClick={() => dispatch({ type: "CLEAR_TOAST" })} aria-label="Dismiss notification">×</button></div>}</div>
  </div>;
}

export function AppStatusBar({ crosshair = "24.6, −112.4, 38.0 mm · −782 HU", warning = false }: { crosshair?: string; warning?: boolean }) {
  const { state } = useProject();
  return <footer className="status-bar" aria-label="Project evidence status">
    <div className="status-item"><Icon name="database" size={16} /><span>Scientific source: <strong title="full-resolution HU cache">full-resolution HU cache</strong></span></div>
    <div className="status-item"><Icon name="cube" size={16} /><span>Preview: <strong title={state.source.cache.preview}>{state.source.cache.preview}</strong></span></div>
    <div className="status-item status-crosshair" aria-live="polite"><Icon name="crosshair" size={16} /><span>Crosshair: <strong title={crosshair}>{crosshair}</strong></span></div>
    <div className={`status-item status-boundary ${warning ? "is-warning" : ""}`} aria-live="polite">{warning ? <Icon name="warning" size={16} /> : <Icon name="checkCircle" size={16} />}<span>{warning ? "1 review item" : "No automatic print start"}</span></div>
  </footer>;
}

export function RailHeader({ title, action, onAction, actionLabel }: { title: string; action?: IconName; onAction?: () => void; actionLabel?: string }) {
  return <div className="rail-header"><h2>{title}</h2>{action && onAction && <IconButton label={actionLabel ?? `Add ${title.toLowerCase()}`} icon={action} onClick={onAction} />}</div>;
}
