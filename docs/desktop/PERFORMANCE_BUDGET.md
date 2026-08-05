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

