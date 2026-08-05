import { beforeEach, describe, expect, it, vi } from "vitest";
import { syntheticProjectDocument } from "../data/fixtures";
import { NativeSidecarClient } from "../services/sidecarClient";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

describe("native sidecar bridge", () => {
  beforeEach(() => {
    invoke.mockReset();
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    invoke.mockImplementation(async (_command: string, args: { request: { operation: string } }) => {
      const operation = args.request.operation;
      if (operation === "inspect_dicom_source") return { ok: true, payload: { source_label: "selected CT", series: [{ series_uid: "series-local", modality: "CT", instance_count: 12, eligible: true }] } };
      if (operation === "select_dicom_series") return { ok: true, payload: { series_uid: "series-local", modality: "CT", instance_count: 12, eligible: true } };
      if (operation === "request_mpr_plane") return { ok: true, payload: { plane: { plane: "axial", shape_yx: [4, 4], coordinate_mm: 1, source_hash: "hash" }, artifact: { path: "mpr.bin" } } };
      return { ok: true, payload: {} };
    });
  });

  it("uses the user-selected source path and forwards physical selection values", async () => {
    const project = structuredClone(syntheticProjectDocument);
    project.source = { ...project.source, path: "/Users/test/CT", seriesUid: "series-local", sliceCount: 12 };
    project.selection = { ...project.selection, start: 2, end: 8, crop: { x: [-4, 4], y: [-5, 5], z: [1, 9] }, stride: 2 };
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
});
