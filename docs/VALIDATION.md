# Validation and evidence boundaries

VoxelWeave separates software evidence from physical evidence. The release process can prove what was built and what the software commanded; it cannot by itself prove what a printer deposited or what HU a scanned part contains.

## Software validation layers

1. **Contract checks** — versioned desktop/engine messages, DICOM geometry rules, tool/material ownership, and release boundaries.
2. **Engine checks** — canonical full-resolution DICOM, geometry, rail-field, G-code, reverse-audit, and scan-back calculations.
3. **Desktop checks** — cache lifecycle, MPR synchronization, selection, preview/source separation, accessibility, and Tauri packaging.
4. **Site/service checks** — release metadata, checksum presentation, health, responsive behavior, and Playwright flows.
5. **Native release checks** — every Mach-O in the app, sidecar, native extension, and framework is exactly `arm64`; the Rust target is `aarch64-apple-darwin` on `macos-14`.
6. **Evidence checks** — release assets are hashed, the manifest is schema-valid, signing lane status is explicit, and post-generation tampering is rejected.

Run the repository checks with:

```sh
pnpm run check
pnpm run test:release-evidence
scripts/tests/test_architectures.sh
```

## Physical validation still required

Before making a physical or scientific claim, the responsible lab must use an approved protocol to confirm the actual tool, material, lot, nozzle, flow, layer height, printer, scanner, reconstruction, and environmental conditions. The run record should retain the source series identity, calibration provenance, transforms, generated G-code hash, reverse-audit result, print record, scan-back data, registration method and confidence, and any exceptions.

The following are not sufficient on their own:

- a clean software audit;
- an exact toolpath preview;
- a successful local G-code/run-package export;
- a synthetic scan-back;
- a low-resolution display or MPR screenshot;
- a model's confidence or a release test pass.

HU gamma is not dose gamma. A scan-back comparison is evidence about the measured artifact and registration method used; it is not a universal validation of future prints or other materials.

## Product boundary

The application is research-only and non-diagnostic. It must not be used for clinical interpretation, automatic patient-specific decisions, or unattended printer start. Warnings and unresolved calibration or geometry mismatches should block or require explicit documented acknowledgment at the decision point.
