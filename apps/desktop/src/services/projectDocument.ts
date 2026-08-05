import { invoke } from "@tauri-apps/api/core";
import { PROJECT_SCHEMA_VERSION, type ProjectDocument } from "../types";

const PROJECT_STORAGE_KEY = "voxelweave.project.v1";
const RECOVERY_STORAGE_KEY = "voxelweave.project.recovery.v1";

export function isNativeRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function authorizeNativePath(path: string): Promise<void> {
  if (!isNativeRuntime()) return;
  await invoke("authorize_path", { path });
}

export function serializeProject(project: ProjectDocument): string {
  const scene = project.scene.map((object) => object.sourcePath && !object.sourcePath.startsWith("synthetic://")
    ? { ...object, vertices: undefined, faces: undefined }
    : object);
  return JSON.stringify({ ...project, scene, schemaVersion: PROJECT_SCHEMA_VERSION });
}

export function migrateProject(input: unknown): ProjectDocument {
  if (!input || typeof input !== "object") {
    throw new Error("Project document is not an object");
  }

  const candidate = input as Partial<ProjectDocument> & { schemaVersion?: number };
  if (candidate.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    throw new Error(`Unsupported project schema ${candidate.schemaVersion ?? "unknown"}`);
  }
  if (!candidate.projectId || !candidate.name || !candidate.source || !candidate.selection) {
    throw new Error("Project document is missing required identity or selection fields");
  }
  return { ...(candidate as ProjectDocument), schemaVersion: PROJECT_SCHEMA_VERSION };
}

export function parseProject(serialized: string): ProjectDocument {
  return migrateProject(JSON.parse(serialized) as unknown);
}

export function saveProject(project: ProjectDocument, storage: Storage = window.localStorage): void {
  const serialized = serializeProject(project);
  storage.setItem(PROJECT_STORAGE_KEY, serialized);
  storage.setItem(RECOVERY_STORAGE_KEY, serialized);
}

export function recoverProject(storage: Storage = window.localStorage): ProjectDocument | null {
  const serialized = storage.getItem(RECOVERY_STORAGE_KEY) ?? storage.getItem(PROJECT_STORAGE_KEY);
  if (!serialized) return null;
  try {
    return parseProject(serialized);
  } catch {
    return null;
  }
}

export function clearProjectStorage(storage: Storage = window.localStorage): void {
  storage.removeItem(PROJECT_STORAGE_KEY);
  storage.removeItem(RECOVERY_STORAGE_KEY);
}

export async function saveNativeProject(path: string, project: ProjectDocument): Promise<void> {
  await authorizeNativePath(path);
  await invoke("save_voxelweave_document", { path, document: JSON.parse(serializeProject(project)) as ProjectDocument });
}

export async function openNativeProject(path: string): Promise<ProjectDocument> {
  await authorizeNativePath(path);
  const document = await invoke<unknown>("open_voxelweave_document", { path });
  return migrateProject(document);
}
