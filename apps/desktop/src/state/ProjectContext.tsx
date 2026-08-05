import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type PropsWithChildren } from "react";
import { syntheticProjectDocument } from "../data/fixtures";
import { createSidecarClient, type SidecarClient } from "../services/sidecarClient";
import { recoverProject, saveProject } from "../services/projectDocument";
import type { ProjectAction, ProjectDocument, ProjectState } from "../types";
import { createInitialProjectState, projectReducer } from "./projectState";

interface ProjectContextValue {
  state: ProjectState;
  dispatch: (action: ProjectAction) => void;
  sidecar: SidecarClient;
  runOperation: <T>(operation: () => Promise<T>, successMessage?: string) => Promise<T>;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

function documentFromState(state: ProjectState): ProjectDocument {
  const { ui: _ui, ...document } = state;
  return document;
}

export function ProjectProvider({ children }: PropsWithChildren) {
  const recovered = typeof window !== "undefined" ? recoverProject() : null;
  const initialState = recovered ? { ...recovered, ui: createInitialProjectState(true).ui } : createInitialProjectState();
  const [state, rawDispatch] = useReducer(projectReducer, initialState);
  const sidecar = useMemo(() => createSidecarClient(), []);

  const dispatch = useCallback((action: ProjectAction) => {
    rawDispatch(action);
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        saveProject(documentFromState(state));
        rawDispatch({ type: "SET_TOAST", message: state.ui.toast });
      } catch {
        rawDispatch({ type: "SET_TOAST", message: "Autosave unavailable in this browser context" });
      }
    }, 260);
    return () => window.clearTimeout(timeout);
  }, [state.source, state.selection, state.scene, state.toolpath, state.send, state.verify]);

  const runOperation = useCallback(async <T,>(operation: () => Promise<T>, successMessage?: string) => {
    const result = await operation();
    if (successMessage) rawDispatch({ type: "SET_TOAST", message: successMessage });
    return result;
  }, []);

  const value = useMemo(() => ({ state, dispatch, sidecar, runOperation }), [dispatch, runOperation, sidecar, state]);
  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProject(): ProjectContextValue {
  const value = useContext(ProjectContext);
  if (!value) throw new Error("useProject must be used inside ProjectProvider");
  return value;
}

export { syntheticProjectDocument };
