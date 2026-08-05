import ManifoldModule from "manifold-3d";
import manifoldWasmUrl from "manifold-3d/manifold.wasm?url";

type WorkerObject = {
  id: string;
  kind: string;
  dimensions?: { x: number; y: number; z: number };
  vertices?: number[][];
  faces?: number[][];
  boolean?: { operation: "union" | "subtract" | "intersect"; operands: string[] };
};

type PreviewRequest = { operation: "preview"; scene: WorkerObject[] };
let runtimePromise: ReturnType<typeof ManifoldModule> | undefined;

async function runtime() {
  runtimePromise ??= ManifoldModule({ locateFile: () => manifoldWasmUrl });
  const module = await runtimePromise;
  module.setup();
  return module;
}

async function validateScene(scene: WorkerObject[]) {
  const module = await runtime();
  const operands = new Map<string, InstanceType<typeof module.Manifold>>();
  const consumed = new Set<string>();
  const preservedOperands = scene.map((object) => object.id);
  for (const object of scene) {
    const dimensions = object.dimensions ?? { x: 1, y: 1, z: 1 };
    let solid: InstanceType<typeof module.Manifold>;
    if (object.vertices?.length && object.faces?.length) {
      const mesh = new module.Mesh({
        numProp: 3,
        triVerts: new Uint32Array(object.faces.flatMap((face) => [face[0] ?? 0, face[1] ?? 0, face[2] ?? 0])),
        vertProperties: new Float32Array(object.vertices.flatMap((vertex) => [vertex[0] ?? 0, vertex[1] ?? 0, vertex[2] ?? 0])),
      });
      solid = module.Manifold.ofMesh(mesh);
    } else if (object.kind === "cylinder" || object.kind === "polygon-prism") {
      solid = module.Manifold.cylinder(Math.max(0.1, dimensions.z), Math.max(0.1, dimensions.x / 2), -1, object.kind === "polygon-prism" ? 6 : 48, true);
    } else {
      solid = module.Manifold.cube([Math.max(0.1, dimensions.x), Math.max(0.1, dimensions.y), Math.max(0.1, dimensions.z)], true);
    }
    operands.set(object.id, solid);
  }
  for (const object of scene) {
    const graph = object.boolean;
    if (!graph || graph.operands.length < 2) continue;
    const solids = graph.operands.map((id) => operands.get(id)).filter((value): value is InstanceType<typeof module.Manifold> => Boolean(value));
    if (solids.length !== graph.operands.length) throw new Error(`Boolean ${object.id} references an unknown operand`);
    const combined = graph.operation === "union" ? module.Manifold.union(solids) : graph.operation === "subtract" ? module.Manifold.difference(solids) : module.Manifold.intersection(solids);
    operands.set(object.id, combined);
    graph.operands.forEach((id) => consumed.add(id));
  }
  const rootSolids = [...operands.entries()].filter(([id]) => !consumed.has(id)).map(([, solid]) => solid);
  const volume = rootSolids.reduce((sum, solid) => sum + solid.volume(), 0);
  [...new Set(operands.values())].forEach((solid) => solid.delete());
  return { operandIds: preservedOperands, volumeMm3: volume, booleanCount: scene.filter((object) => Boolean(object.boolean)).length };
}

self.addEventListener("message", (event: MessageEvent<PreviewRequest>) => {
  if (event.data?.operation !== "preview") return;
  void validateScene(event.data.scene).then((summary) => {
    self.postMessage({ ok: true, ...summary, message: `manifold3d WASM validated ${summary.operandIds.length} operands` });
  }).catch((error: unknown) => {
    self.postMessage({ ok: false, message: error instanceof Error ? error.message : "manifold3d WASM validation failed" });
  });
});
