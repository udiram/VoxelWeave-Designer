# ADR-001: Desktop Engine Stack and Runtime Ownership

Status: Accepted

## Decision

- Tauri 2 owns the macOS application lifecycle, filesystem scopes, document registration, Keychain access, native dialogs, permissions, and sidecar lifecycle.
- React 19 and TypeScript own product UI composition and interaction state.
- Three.js through React Three Fiber owns visual rendering and picking.
- WebGL2 is the v1 graphics baseline. Three.js `Data3DTexture` plus a custom shader provides interactive volume preview.
- `manifold-3d` WASM provides interactive CSG preview in a worker.
- Python `manifold3d` performs canonical geometry validation.
- The existing Python VoxelWeave engine owns full-resolution DICOM decode/resampling, rail-field generation, G-code compilation, reverse audit, and scan-back metrics.
- A versioned JSON-lines protocol carries bounded control messages. Large HU volumes, MPR planes, meshes, toolpaths, and preview streams use scoped binary files or binary streams with typed headers and hashes.

## Prohibitions

- React does not generate G-code.
- Three.js does not generate scientific HU values.
- Preview meshes and GPU preview volumes are not slicing inputs.
- Complete voxel arrays and toolpaths are not transported as JSON or base64.
- The sidecar does not expose arbitrary shell execution.
- No Intel sidecar, universal package, Rosetta workflow, or WebGPU requirement is introduced in v1.

## Sidecar Operations

The initial protocol includes `inspect_dicom_source`, `select_dicom_series`, `build_volume_cache`, `request_mpr_plane`, `request_volume_preview`, `sample_voxel`, `calculate_histogram`, `create_print_selection`, `validate_scene`, `generate_toolpath`, `reverse_audit_gcode`, `export_run_package`, and `verify_scan_back`. Every long operation accepts a request ID, emits named progress stages, and supports cancellation.

## Consequences

The UI remains responsive and preview resolution can adapt to GPU memory without changing scientific output. The cost is a versioned cross-runtime contract, explicit binary lifecycle management, architecture inspection, and parity tests between interactive and canonical geometry.

