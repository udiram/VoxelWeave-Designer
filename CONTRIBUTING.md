# Contributing to VoxelWeave Designer

VoxelWeave Designer crosses a native desktop shell, a Python scientific engine, a public site, and a release service. Keep changes narrow, preserve the contracts, and make evidence limits visible in code and documentation.

## Before changing code

- Read [PRODUCT.md](PRODUCT.md), [DESIGN.md](DESIGN.md), and the relevant [desktop contracts](docs/desktop/PRODUCT_CONTRACT.md).
- Do not commit PHI, raw DICOM, patient identifiers, printer credentials, signing material, or local `.voxelweave` documents.
- Treat full-resolution signed HU data as scientific source data. Preview textures and rendered screenshots are not slicing inputs.
- Do not add Intel, non-macOS, Rosetta, or universal-binary release paths.

## Workspace boundaries

Keep the independently installable paths independent:

- `apps/desktop` owns Tauri and UI behavior.
- `engine` owns canonical DICOM, geometry, toolpath, reverse-audit, and scan-back calculations.
- `apps/site` owns the public presentation and download surface.
- `services/release-api` owns release metadata, checksums, health, and evidence delivery.
- `packages/contracts` owns versioned cross-runtime messages when present.

The root scripts in `scripts/` are integration glue. They detect declared package scripts before running them, so adding a new command requires adding it to the owning workspace first. Do not make root orchestration silently replace a missing product contract.

## Local checks

```sh
pnpm run setup
pnpm run check
pnpm run test:release-evidence
scripts/tests/test_architectures.sh
```

For a focused change, run the narrowest relevant gate and record any unavailable external dependency. A local software pass is not physical validation. If a result depends on a real printer, calibration coupon, scan-back, or third-party release service, name that dependency explicitly.

## Pull requests

Explain the affected contract, the validation run, and any remaining evidence gap. Include screenshots or generated artifacts only when they are safe to share and derived from synthetic or redacted data. Release changes must explain the signing lane and must not call a stable artifact notarized unless Apple acceptance and stapling were actually verified.

Do not push a release, deploy Railway, upload a printer job, or publish a GitHub release from a development change unless the task explicitly authorizes that external mutation.
