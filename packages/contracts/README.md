# VoxelWeave cross-runtime contracts

`control-envelope.v1.schema.json` and `src/control.ts` define bounded JSON-lines
messages between the Tauri/TypeScript shell and the Python engine. Arrays of HU,
MPR pixels, meshes, toolpaths, and preview segments are never embedded in these
messages. They travel through a scoped binary artifact whose header records the
artifact type, dtype, shape, physical metadata, and SHA-256 payload digest.

The protocol is intentionally small and fail-closed. Every request has a stable
request ID; long operations emit progress events and accept `cancel` requests.
