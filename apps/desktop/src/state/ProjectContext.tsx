import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type PropsWithChildren } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { emptyProjectDocument, syntheticProjectDocument } from "../data/fixtures";
import { createSidecarClient, type SidecarClient } from "../services/sidecarClient";
import { authorizeNativePath, isNativeRuntime, openNativeProject, recoverProject, saveNativeProject, saveProject } from "../services/projectDocument";
import type { ProjectAction, ProjectDocument, ProjectState } from "../types";
import { createInitialProjectState, projectReducer } from "./projectState";

interface ProjectContextValue {
  state: ProjectState;
  dispatch: (action: ProjectAction) => void;
  sidecar: SidecarClient;
  runOperation: <T>(operation: () => Promise<T>, successMessage?: string) => Promise<T>;
  openProjectFile: (path: string) => Promise<void>;
  saveProjectFile: (path?: string) => Promise<void>;
  undoSceneEdit: () => void;
  redoSceneEdit: () => void;
  canUndoSceneEdit: boolean;
  canRedoSceneEdit: boolean;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

type SceneSnapshot = Pick<ProjectState, "scene"> & { selectedSceneId: string; selectedSceneIds: string[] };
type ProjectHistory = { present: ProjectState; past: SceneSnapshot[]; future: SceneSnapshot[] };
type ProjectHistoryAction = { type: "project"; action: ProjectAction } | { type: "undo" } | { type: "redo" };

const sceneHistoryActions = new Set<ProjectAction["type"]>([
  "SET_SCENE_TRANSFORM",
  "SET_SCENE_TRANSFORMS",
  "SET_SCENE_DIMENSIONS",
  "SET_SCENE_OWNERSHIP",
  "SET_SCENE_TARGET_HU",
  "TOGGLE_SCENE_VISIBILITY",
  "DELETE_SCENE_OBJECTS",
  "DUPLICATE_SCENE_OBJECTS",
  "INSERT_SCENE_OBJECTS",
  "GROUP_SCENE_OBJECTS",
  "UNGROUP_SCENE_OBJECTS",
  "SET_SCENE_LOCKED",
  "RENAME_SCENE_OBJECT",
  "ALIGN_SCENE_OBJECTS",
  "ADD_PRIMITIVE",
  "BOOLEAN_SCENE",
  "IMPORT_SOLID",
  "SET_IMPORTED_SOLID",
]);

function sceneSnapshot(state: ProjectState): SceneSnapshot {
  return { scene: state.scene, selectedSceneId: state.ui.selectedSceneId, selectedSceneIds: state.ui.selectedSceneIds ?? [state.ui.selectedSceneId].filter(Boolean) };
}

function projectHistoryReducer(history: ProjectHistory, action: ProjectHistoryAction): ProjectHistory {
  if (action.type === "undo") {
    const previous = history.past.at(-1);
    if (!previous) return history;
    return {
      past: history.past.slice(0, -1),
      present: projectReducer(history.present, { type: "RESTORE_SCENE_SNAPSHOT", ...previous, message: "Undid scene edit" }),
      future: [sceneSnapshot(history.present), ...history.future].slice(0, 100),
    };
  }
  if (action.type === "redo") {
    const next = history.future[0];
    if (!next) return history;
    return {
      past: [...history.past, sceneSnapshot(history.present)].slice(-100),
      present: projectReducer(history.present, { type: "RESTORE_SCENE_SNAPSHOT", ...next, message: "Redid scene edit" }),
      future: history.future.slice(1),
    };
  }
  const present = projectReducer(history.present, action.action);
  if (action.action.type === "OPEN_PROJECT" || action.action.type === "OPEN_SYNTHETIC_PROJECT") return { present, past: [], future: [] };
  if (!sceneHistoryActions.has(action.action.type) || present.scene === history.present.scene) return { ...history, present };
  return { present, past: [...history.past, sceneSnapshot(history.present)].slice(-100), future: [] };
}

function documentFromState(state: ProjectState): ProjectDocument {
  const { ui: _ui, ...document } = state;
  return document;
}

export function ProjectProvider({ children }: PropsWithChildren) {
  const native = isNativeRuntime();
  const recovered = typeof window !== "undefined" ? recoverProject() : null;
  const initialState = recovered && !native ? { ...recovered, ui: createInitialProjectState(true).ui } : native ? { ...emptyProjectDocument, ui: { ...createInitialProjectState().ui, toast: "Create or open a .voxelweave project" } } : createInitialProjectState();
  const [history, historyDispatch] = useReducer(projectHistoryReducer, { present: initialState, past: [], future: [] });
  const state = history.present;
  const sidecar = useMemo(() => createSidecarClient(), []);

  const dispatch = useCallback((action: ProjectAction) => {
    historyDispatch({ type: "project", action });
  }, []);
  const undoSceneEdit = useCallback(() => historyDispatch({ type: "undo" }), []);
  const redoSceneEdit = useCallback(() => historyDispatch({ type: "redo" }), []);

  useEffect(() => {
    if (native) return;
    const timeout = window.setTimeout(() => {
      try {
        saveProject(documentFromState(state));
        historyDispatch({ type: "project", action: { type: "SET_TOAST", message: state.ui.toast } });
      } catch {
        historyDispatch({ type: "project", action: { type: "SET_TOAST", message: "Autosave unavailable in this browser context" } });
      }
    }, 260);
    return () => window.clearTimeout(timeout);
  }, [native, state.source, state.selection, state.scene, state.toolpath, state.send, state.verify]);

  const openProjectFile = useCallback(async (path: string) => {
    if (!native) {
      historyDispatch({ type: "project", action: { type: "SET_PROJECT_PATH", path } });
      return;
    }
    const project = await openNativeProject(path);
    const linkedPaths = [...new Set([
      ...(project.source.inputPaths ?? []),
      project.source.path,
      ...project.scene.map((object) => object.sourcePath),
      project.verify.sourcePath,
    ].filter((value): value is string => Boolean(value) && !value!.startsWith("synthetic://")))];
    if (linkedPaths.length) {
      const approved = await confirm(
        `This project references ${linkedPaths.length} local source${linkedPaths.length === 1 ? "" : "s"}. Reauthorize those DICOM/mesh paths for this session?`,
        { title: "Reauthorize linked research sources", kind: "warning", okLabel: "Reauthorize", cancelLabel: "Cancel open" },
      );
      if (!approved) throw new Error("Project open canceled before linked source authorization.");
      await Promise.all(linkedPaths.map((linkedPath) => authorizeNativePath(linkedPath)));
    }
    historyDispatch({ type: "project", action: { type: "OPEN_PROJECT", project, path } });
  }, [native]);

  const saveProjectFile = useCallback(async (path = state.ui.filePath) => {
    if (!path) throw new Error("Choose a .voxelweave destination before saving.");
    if (native) await saveNativeProject(path, documentFromState(state));
    else saveProject(documentFromState(state));
    historyDispatch({ type: "project", action: { type: "SET_PROJECT_PATH", path } });
    historyDispatch({ type: "project", action: { type: "SET_TOAST", message: `Saved ${path.split(/[\\/]/).pop()}` } });
  }, [native, state]);

  const runOperation = useCallback(async <T,>(operation: () => Promise<T>, successMessage?: string) => {
    const result = await operation();
    if (successMessage) historyDispatch({ type: "project", action: { type: "SET_TOAST", message: successMessage } });
    return result;
  }, []);

  const value = useMemo(() => ({ state, dispatch, sidecar, runOperation, openProjectFile, saveProjectFile, undoSceneEdit, redoSceneEdit, canUndoSceneEdit: history.past.length > 0, canRedoSceneEdit: history.future.length > 0 }), [dispatch, history.future.length, history.past.length, openProjectFile, redoSceneEdit, runOperation, saveProjectFile, sidecar, state, undoSceneEdit]);
  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProject(): ProjectContextValue {
  const value = useContext(ProjectContext);
  if (!value) throw new Error("useProject must be used inside ProjectProvider");
  return value;
}

export { syntheticProjectDocument };
