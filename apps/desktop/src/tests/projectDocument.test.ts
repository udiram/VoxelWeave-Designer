import { clearProjectStorage, migrateProject, parseProject, recoverProject, serializeProject } from "../services/projectDocument";
import { syntheticProjectDocument } from "../data/fixtures";

describe("versioned project documents", () => {
  it("serializes and parses the v1 document without losing physical selection", () => {
    const parsed = parseProject(serializeProject(syntheticProjectDocument));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.selection.crop.x).toEqual([-90, 90]);
    expect(parsed.source.cache.scientificSource).toBe("full-resolution signed-HU cache");
  });

  it("fails closed for an unknown schema or missing identity", () => {
    expect(() => migrateProject({ schemaVersion: 2 })).toThrow(/Unsupported project schema/);
    expect(() => migrateProject({ schemaVersion: 1, projectId: "id" })).toThrow(/missing required/);
  });

  it("writes and recovers a local snapshot", () => {
    const storage = window.localStorage;
    clearProjectStorage(storage);
    storage.setItem("voxelweave.project.recovery.v1", serializeProject(syntheticProjectDocument));
    expect(recoverProject(storage)?.projectId).toBe(syntheticProjectDocument.projectId);
    clearProjectStorage(storage);
    expect(recoverProject(storage)).toBeNull();
  });
});
