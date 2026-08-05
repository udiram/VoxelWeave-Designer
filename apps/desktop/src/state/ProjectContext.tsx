import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type PropsWithChildren } from "react";
import { emptyProjectDocument, syntheticProjectDocument } from "../data/fixtures";
import { createSidecarClient, type SidecarClient } from "../services/sidecarClient";
import { isNativeRuntime, openNativeProject, recoverProject, saveNativeProject, saveProject } from "../services/projectDocument";
import type { ProjectAction, ProjectDocument, ProjectState } from "../types";
import { createInitialProjectState, projectReducer } from "./projectState";

interface ProjectContextValue {
  state: ProjectState;
  dispatch: (action: ProjectAction) => void;
  sidecar: SidecarClient;
  runOperation: <T>(operation: () => Promise<T>, successMessage?: string) => Promise<T>;
  openProjectFile: (path: string) => Promise<void>;
  saveProjectFile: (path?: string) => Promise<void>;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

function documentFromState(state: ProjectState): ProjectDocument {
  const { ui: _ui, ...document } = state;
  return document;
}

export function ProjectProvider({ children }: PropsWithChildren) {
  const native = isNativeRuntime();
  const recovered = typeof window !== "undefined" ? recoverProject() : null;
  const initialState = recovered && !native ? { ...recovered, ui: createInitialProjectState(true).ui } : native ? { ...emptyProjectDocument, ui: { ...createInitialProjectState().ui, toast: "Create or open a .voxelweave project" } } : createInitialProjectState();
  const [state, rawDispatch] = useReducer(projectReducer, initialState);
  const sidecar = useMemo(() => createSidecarClient(), []);

  const dispatch = useCallback((action: ProjectAction) => {
    rawDispatch(action);
  }, []);

  useEffect(() => {
    if (native) return;
    const timeout = window.setTimeout(() => {
      try {
        saveProject(documentFromState(state));
        rawDispatch({ type: "SET_TOAST", message: state.ui.toast });
      } catch {
        rawDispatch({ type: "SET_TOAST", message: "Autosave unavailable in this browser context" });
      }
    }, 260);
    return () => window.clearTimeout(timeout);
  }, [native, state.source, state.selection, state.scene, state.toolpath, state.send, state.verify]);

  const openProjectFile = useCallback(async (path: string) => {
    if (!native) {
      rawDispatch({ type: "SET_PROJECT_PATH", path });
      return;
    }
    const project = await openNativeProject(path);
    rawDispatch({ type: "OPEN_PROJECT", project, path });
  }, [native]);

  const saveProjectFile = useCallback(async (path = state.ui.filePath) => {
    if (!path) throw new Error("Choose a .voxelweave destination before saving.");
    if (native) await saveNativeProject(path, documentFromState(state));
    else saveProject(documentFromState(state));
    rawDispatch({ type: "SET_PROJECT_PATH", path });
    rawDispatch({ type: "SET_TOAST", message: `Saved ${path.split(/[\\/]/).pop()}` });
  }, [native, state]);

  const runOperation = useCallback(async <T,>(operation: () => Promise<T>, successMessage?: string) => {
    const result = await operation();
    if (successMessage) rawDispatch({ type: "SET_TOAST", message: successMessage });
    return result;
  }, []);

  const value = useMemo(() => ({ state, dispatch, sidecar, runOperation, openProjectFile, saveProjectFile }), [dispatch, openProjectFile, runOperation, saveProjectFile, sidecar, state]);
  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProject(): ProjectContextValue {
  const value = useContext(ProjectContext);
  if (!value) throw new Error("useProject must be used inside ProjectProvider");
  return value;
}

export { syntheticProjectDocument };
