import { beforeEach, describe, expect, it, vi } from "vitest";
import { syntheticProjectDocument } from "../data/fixtures";
import { NativeSidecarClient } from "../services/sidecarClient";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/api/path", () => ({ appCacheDir: vi.fn(async () => "/Users/test/Library/Caches/com.voxelweave.designer"), appDataDir: vi.fn(async () => "/Users/test/Library/Application Support/com.voxelweave.designer") }));

describe("native sidecar bridge", () => {
  beforeEach(() => {
    invoke.mockReset();
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    invoke.mockImplementation(async (_command: string, args: { request: { operation: string } }) => {
      const operation = args.request.operation;
      if (operation === "inspect_dicom_source") return { ok: true, payload: { source_label: "selected CT", series: [{ series_uid: "series-local", modality: "CT", instance_count: 12, eligible: true }] } };
      if (operation === "select_dicom_series") return { ok: true, payload: { series_uid: "series-local", modality: "CT", instance_count: 12, eligible: true } };
      if (operation === "request_mpr_plane") return { ok: true, payload: { plane: { plane: "axial", shape_yx: [4, 4], coordinate_mm: 1, source_hash: "hash" }, artifact: { path: "mpr.bin" } } };
      if (operation === "generate_toolpath") return { ok: true, payload: { segment_count: 2, gcode_sha256: "abc", clipping_percent: 0, estimated: { printTime: "1 min", t0Grams: 1, t1Grams: 0, toolChanges: 0 } } };
      if (operation === "create_print_selection") return { ok: true, payload: { selection_id: "native-selection-1", print_size_mm: [8, 8, 2], source_to_print_transform: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]], transform_hash: "sha256:transform" } };
      if (operation === "validate_scene") return { ok: true, payload: { passed: true, errors: [], warnings: [] } };
      if (operation === "export_run_package") return { ok: true, payload: { package_name: "run-package-1", package_path: "/Users/test/CT/.voxelweave-cache/run-package-1", files: ["toolpath.gcode", "hashes.json"], hashes: { "hashes.json": "hashes" } } };
      if (operation === "verify_scan_back") return { ok: true, payload: { registration_method: "identity", registration_confidence: 1, translation_voxel_zyx: [0, 0, 0], source_hash: "source-hash", scan_back_hash: "scan-hash", mae_hu: 2, rmse_hu: 3, compared_voxel_count: 42, correlation: 0.98, hu_gamma_pass_percent: 97, hu_gamma_tolerance_hu: 40, physical_fidelity_status: "evidence_recorded_not_established", warnings: ["research only"], dose_gamma: "not_used_hu_gamma_is_not_dose_gamma" } };
      if (operation === "export_verification_report") return { ok: true, payload: { package_name: "verification-report.zip", package_path: "/Users/test/verification-report.zip", report_path: "/Users/test/verification-report.json", files: ["verification-report.json", "provenance.json", "hashes.json"], hashes: { "hashes.json": "verification-hashes" } } };
      return { ok: true, payload: {} };
    });
  });

  it("uses the user-selected source path and forwards physical selection values", async () => {
    const project = structuredClone(syntheticProjectDocument);
    project.source = { ...project.source, path: "/Users/test/CT", seriesUid: "series-local", sliceCount: 12 };
    project.selection = { ...project.selection, start: 2, end: 8, crop: { x: [-4, 4], y: [-5, 5], z: [1, 9] }, stride: 2, created: true };
    const client = new NativeSidecarClient();
    await client.requestMprPlane(project);
    const requests = invoke.mock.calls.map((call) => call[1]?.request).filter(Boolean);
    expect(requests.every((request: { payload: Record<string, unknown> }) => JSON.stringify(request).includes("synthetic://") === false)).toBe(true);
    const mpr = requests.find((request: { operation: string }) => request.operation === "request_mpr_plane");
    expect(mpr.payload).toMatchObject({ source: "/Users/test/CT", plane: "axial", index: 2, output_shape_yx: [512, 512] });
    project.toolpath.clippingAcknowledged = true;
    await client.generateToolpath(project);
    const generation = invoke.mock.calls.map((call) => call[1]?.request).find((request: { operation: string }) => request.operation === "generate_toolpath");
    expect(generation.payload).toMatchObject({ allow_calibration_clipping: true, acknowledge_calibration_clipping: true });
    expect(JSON.stringify(generation)).not.toContain("synthetic://");
  });

  it("fails closed when native mode has no selected source", async () => {
    const project = structuredClone(syntheticProjectDocument);
    project.source = { ...project.source, path: undefined };
    await expect(new NativeSidecarClient().requestVolumePreview(project)).rejects.toThrow(/Choose a local DICOM folder/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("emits exact physical selection, canonical scene, calibration, and export contracts", async () => {
    const project = structuredClone(syntheticProjectDocument);
    project.source = { ...project.source, path: "/Users/test/CT", seriesUid: "series-local", sliceCount: 12 };
    project.selection = { ...project.selection, start: 2, end: 8, tileLabels: ["A", "B"], tilePlateColumns: 2, tilePlateRows: 1, tileThicknessMm: 0.4, created: true };
    project.scene = [...project.scene, { id: "mesh-1", name: "Imported mesh", kind: "fixture", region: "measurement", tool: "T1", sourcePath: "/Users/test/mesh.stl", transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 2, y: 2, z: 2 } }, dimensionsMm: { x: 2, y: 2, z: 2 }, vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], faces: [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]], visible: true }];
    const client = new NativeSidecarClient();
    const selection = await client.createPrintSelection(project);
    expect(selection.selectionId).toBe("native-selection-1");
    const requests = invoke.mock.calls.map((call) => call[1]?.request).filter(Boolean) as Array<{ operation: string; payload: Record<string, unknown> }>;
    const created = requests.find((request) => request.operation === "create_print_selection");
    expect(created?.payload).toMatchObject({ plane: "axial", start_index: 2, end_index: 8, labels: ["A", "B"] });
    expect(created?.payload.thickness_mm).toBeUndefined();
    expect(created?.payload.print_size_mm).toEqual([180.7, 180.7, 7]);
    expect(created?.payload).not.toHaveProperty("source");
    expect(created?.payload.structural_regions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "scene-reference-box", owner: "T1:fixture", structural: true, marker_type: "anchor" }),
      expect.objectContaining({ id: "scene-airway-support", owner: "T1:support", structural: true, marker_type: "tab" }),
    ]));
    const validated = await client.validateScene(project);
    expect(validated.valid).toBe(true);
    const sceneRequest = (invoke.mock.calls.map((call) => call[1]?.request).find((request: { operation: string }) => request.operation === "validate_scene") as { payload: { scene: { regions: Array<{ source_path?: string; geometry: { dimensions: { x: number; y: number; z: number }; vertices?: number[][]; faces?: number[][] } }> } } });
    const importedRegion = sceneRequest.payload.scene.regions.find((region) => region.source_path?.endsWith("mesh.stl"));
    expect(importedRegion).toMatchObject({ source_path: "/Users/test/mesh.stl" });
    expect(importedRegion?.geometry.vertices).toBeUndefined();
    expect(importedRegion?.geometry.faces).toBeUndefined();
    expect(JSON.stringify(sceneRequest).length).toBeLessThan(256 * 1024);
    await client.generateToolpath(project);
    const generation = invoke.mock.calls.map((call) => call[1]?.request).find((request: { operation: string }) => request.operation === "generate_toolpath") as { payload: { tool?: string; calibration: Array<{ binding: { tool: string; pitch_mm: number; layer_height_mm: number; flow_mm3_s: number } }>; scene: { regions: Array<{ bounds_mm: { x: number[]; y: number[] } }> } } };
    expect(generation.payload.tool).toBeUndefined();
    expect(generation.payload.calibration.map((profile) => profile.binding.tool)).toEqual(["T0", "T1"]);
    expect(generation.payload.calibration[0].binding).toMatchObject({ pitch_mm: 0.4, layer_height_mm: 0.2, flow_mm3_s: 1.2 });
    expect(generation.payload.scene.regions[0].bounds_mm).toEqual(expect.objectContaining({ x: expect.any(Array), y: expect.any(Array) }));
    const exported = await client.exportRunPackage(project);
    expect(exported).toMatchObject({ packageName: "run-package-1", packageDirectory: "/Users/test/CT/.voxelweave-cache/run-package-1", files: ["toolpath.gcode", "hashes.json"] });
  });

  it("preserves an explicitly selected DICOM file group and caches beside it", async () => {
    const project = structuredClone(syntheticProjectDocument);
    project.source = {
      ...project.source,
      path: "/Users/test/CT/one.dcm",
      inputPaths: ["/Users/test/CT/one.dcm", "/Users/test/CT/two.dcm"],
      seriesUid: "series-local",
      sliceCount: 2,
    };
    const client = new NativeSidecarClient();
    await client.inspectDicomSource(project);
    await client.exportRunPackage(project);
    const requests = invoke.mock.calls.map((call) => call[1]?.request).filter(Boolean) as Array<{ operation: string; payload: Record<string, unknown> }>;
    expect(requests.find((request) => request.operation === "inspect_dicom_source")?.payload).toMatchObject({
      source: "/Users/test/CT/one.dcm",
      sources: ["/Users/test/CT/one.dcm", "/Users/test/CT/two.dcm"],
    });
    expect(requests.find((request) => request.operation === "export_run_package")?.payload.directory).toBe("/Users/test/Library/Application Support/com.voxelweave.designer/exports/vw-demo-lung-2026-08/run-package");
  });

  it("preserves scan-back provenance and uses the dedicated verification export operation", async () => {
    const project = structuredClone(syntheticProjectDocument);
    project.source = { ...project.source, path: "/Users/test/CT", seriesUid: "series-local", sourceHash: "source-hash" };
    project.verify = { ...project.verify, sourcePath: "/Users/test/scan-back", registrationMethod: "landmark rigid", confidence: "high", evidenceImported: true };
    const client = new NativeSidecarClient();
    const verified = await client.verifyScanBack(project);
    expect(verified.provenance).toMatchObject({ sourceHash: "source-hash", scanBackHash: "scan-hash", huGammaPassPercent: 97, doseGamma: "not_used_hu_gamma_is_not_dose_gamma" });
    const exported = await client.exportVerificationReport(project);
    expect(exported).toMatchObject({ packageName: "verification-report.zip", reportPath: "/Users/test/verification-report.json" });
    const requests = invoke.mock.calls.map((call) => call[1]?.request).filter(Boolean) as Array<{ operation: string; payload: Record<string, unknown> }>;
    expect(requests.find((request) => request.operation === "export_verification_report")?.payload).toMatchObject({ run_id: project.toolpath.runId });
  });
});
