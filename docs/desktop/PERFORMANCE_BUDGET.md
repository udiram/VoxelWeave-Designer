# Apple Silicon Performance Budget

These are measured release targets on the primary development Apple Silicon Mac, not unsupported guarantees.

| Interaction | Target |
| --- | --- |
| Cold launch to usable project window | approximately 2 seconds |
| DICOM import progress feedback | under 250 ms |
| Cached MPR scrolling | 60 frames per second |
| Uncached MPR request after cache build | under 100 ms |
| Cached crosshair synchronization | within one frame |
| Representative 3D volume orbit | at least 30 frames per second |
| Ordinary geometry transforms | 60 frames per second |
| Simple Boolean preview after interaction | under 250 ms |
| Main-thread task | no task over 100 ms |
| Active representative toolpath layer | 60 frames per second |

## Required Strategies

- Metadata, central MPR, low-resolution 3D, neighboring MPR cache, and refined volume load progressively.
- MPR uses per-plane LRU caches, direction-aware prefetch, and stale-request cancellation.
- Full-resolution HU remains in the sidecar/cache; React does not retain duplicate volumes.
- GPU preview resolution derives from a conservative memory budget and steps down on upload failure.
- Ray marching uses lower samples during interaction, refinement after idle, early termination, and empty-space skipping where practical.
- Typed arrays and transferable buffers replace JSON/base64 payloads.
- Workers own Manifold operations and toolpath-chunk preparation.
- Camera/pointer state stays outside persistent project state; UI subscriptions remain narrow.
- Three.js textures, geometries, materials, render targets, workers, file handles, and cache entries are explicitly disposed.
- Memory pressure drops refined volume and distant slices before current MPR planes or active scientific source cache.

Performance diagnostics remain local and user-exportable. Severe regressions against representative fixtures block release or require an explicit documented exception.

## Native qualification harness

The release CI job runs `scripts/benchmark-sidecar.py` against the exact
Apple-Silicon sidecar produced for the build. It creates a complete synthetic
12 × 32 × 40 CT series through the current engine, then measures the JSONL
operations used by the desktop adapter: DICOM inspection and selection, volume
cache construction, an uncached MPR request, a volume preview, print selection,
toolpath generation, reverse audit, and run-package export. One warmup and
three measured iterations are recorded in `native-performance.json` with p50,
p95, maximum, first-progress timing, and the host architecture.

The brief's measured targets remain the product qualification targets. The
harness reports whether the measurable proxies meet those targets, but only
the intentionally generous severe-regression gates in
`scripts/native-performance-budget.json` fail CI. The gates are not claims
that a UI target was achieved. In particular, WebKit MPR scrolling, Three.js
orbit FPS, geometry interaction FPS, and main-thread task duration are not
measured by this sidecar harness and still require built-app profiling or
Instruments evidence.

## Production browser UI gate

The desktop job also builds the production web bundle and runs
`scripts/benchmark-desktop-ui.mjs` in headless Chromium with WebGL2 enabled
through SwiftShader. The run uses one warmup and three measured iterations of
the deterministic browser adapter. It records:

- first meaningful Design workspace render;
- DICOM MPR and volume-pointer interaction frame intervals;
- Design geometry/transform interaction frame intervals (with the required R3F/WebGL2 marker);
- generated toolpath layer interaction frame intervals;
- Long Task API durations during those interactions; and
- Chromium WebGL2 capability and renderer information.

The gate budget is in `scripts/desktop-ui-performance-budget.json`. Targets
remain the product intent; only the deliberately generous `gate_ms` severe-
regression limits block CI. JSON evidence is written to
`ui-performance.json` and uploaded separately from native app evidence.

This is browser-adapter evidence, not native qualification. The gate requires
the Design and Toolpath roots to expose
`data-voxelweave-renderer="three-r3f"` and a child canvas that can create a
WebGL2 context. If either marker is absent, the run fails rather than
pretending that SVG/2D-canvas interaction is R3F orbit evidence. It does not
measure WKWebView frame pacing, native GPU memory, or Instruments traces.
Those remain a required follow-up for a packaged-app profiling pass before
making native WebKit or Three.js claims.

Run the browser UI gate locally after building the desktop bundle and
installing the desktop workspace dependencies:

```sh
pnpm --dir apps/desktop run build
pnpm --dir apps/desktop exec playwright install chromium
pnpm --dir apps/desktop exec node ../../scripts/benchmark-desktop-ui.mjs \
  --output-dir /tmp/voxelweave-desktop-ui-performance
```

The native adapter's exact TypeScript/Rust operation and envelope lists are
checked independently by `scripts/check-native-adapter-contract.py` and the
release-evidence unit tests. Cross-runtime and native-app smoke remain the
behavioral payload checks.

Run a local native qualification on an Apple Silicon macOS host with:

```sh
python3 scripts/benchmark-sidecar.py \
  --sidecar apps/desktop/src-tauri/resources/voxelweave-sidecar \
  --output-dir /tmp/voxelweave-native-performance
```

The resulting JSON is local diagnostic evidence only. Synthetic timing does
not establish performance for a clinical DICOM series, physical HU fidelity,
or deposited width.
