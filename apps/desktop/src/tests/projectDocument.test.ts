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

  it("persists imported meshes by scoped source path rather than inline topology", () => {
    const project = structuredClone(syntheticProjectDocument);
    project.scene.push({ id: "mesh", name: "mesh", kind: "fixture", region: "fixture", tool: "T1", sourcePath: "/Users/test/model.stl", vertices: Array.from({ length: 5000 }, (_, index) => [index, 0, 0]), faces: [[0, 1, 2]], transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, visible: true });
    const serialized = serializeProject(project);
    expect(serialized).toContain("/Users/test/model.stl");
    expect(serialized.length).toBeLessThan(256 * 1024);
    expect(parseProject(serialized).scene.at(-1)?.vertices).toBeUndefined();
  });
});
