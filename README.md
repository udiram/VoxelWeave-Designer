# VoxelWeave Designer

VoxelWeave Designer is a research-only desktop workspace for turning complete CT DICOM series or designer-created solids into calibrated, auditable, multi-tool Prusa XL G-code. A project is saved as a `.voxelweave` document. It is non-diagnostic software: a software audit, preview, or successful G-code generation does not establish deposited geometry or physical HU fidelity.

The product is a Tauri 2 application with a React and TypeScript interface, a Python scientific engine, and a public Railway site/release service. Version 1 supports Apple Silicon Macs running macOS 14 or newer. Intel, Windows, Linux, Rosetta, and universal-binary releases are outside the supported platform boundary.

## The six workspaces

1. **Design** — primitives, imported solids, transforms, regions, and Boolean CSG.
2. **DICOM** — complete-series import, synchronized axial/sagittal/coronal/3D viewing, crop, and print selection.
3. **Calibrate** — tool-, material-, scanner-, and reconstruction-specific rail-width-to-HU evidence.
4. **Prepare** — exact toolpath preview, clipping, flow, bed, runtime, and safety checks.
5. **Send** — local export and optional authenticated Prusa Connect upload; never automatic print start.
6. **Verify** — scan-back registration, HU comparison, provenance, reports, and research conclusions.

The source-of-truth contracts are [PRODUCT.md](PRODUCT.md), [DESIGN.md](DESIGN.md), and the [desktop product contract](docs/desktop/PRODUCT_CONTRACT.md).

## Repository shape

The repository is intentionally split into independently installable surfaces:

- `apps/desktop` — Tauri shell and desktop UI.
- `apps/site` — public product and release-download site.
- `engine` — Python scientific engine.
- `packages/contracts` — shared versioned contracts when present.
- `services/release-api` — release metadata, checksums, and health service.
- `scripts` — conditional workspace orchestration, native inspection, evidence verification, and Railway staging.

The root commands tolerate a workspace that has not been integrated yet. A skipped workspace is reported; once the workspace exists, its declared scripts are run without inventing a command name.

## Local setup

Use an Apple Silicon Mac with macOS 14 or newer for the desktop build. Install Node.js, Corepack, pnpm, Python 3.12 or newer, and the Rust toolchain required by Tauri.

```sh
corepack enable
pnpm run setup
pnpm run check
```

`pnpm run setup` installs each present workspace independently and does not run package lifecycle scripts. Use separate terminals for `pnpm run dev:desktop` and `pnpm run dev:site` when those workspaces are present. `pnpm run railway:bundle` builds and stages the site plus release API without editing their source directories.

## Quality gates

The root gates are conditional until the product stacks are present, but their intended contract is fixed:

- contracts and Python engine lint, type, and test checks;
- desktop lint, type, unit/integration tests, build, and Playwright;
- site and release API lint, type, unit/integration tests, build, and Playwright;
- Mach-O architecture inspection for every app, sidecar, native extension, and framework;
- release evidence schema, SHA-256, local-link, and workflow validation.

Run focused gates with `pnpm run check:contracts`, `pnpm run check:desktop`, `pnpm run check:site-service`, `pnpm run check:architecture`, `pnpm run test:release-evidence`, and `pnpm run check:links`.

## Release and downloads

The [release workflow](.github/workflows/release.yml) runs on `macos-14`, builds only the `aarch64-apple-darwin` Tauri target, inspects all Mach-O components, creates a `.app` archive and DMG, writes `SHA256SUMS`, and publishes a machine-readable `release-evidence.json` alongside the GitHub release assets. The public site is expected to consume those artifacts through `services/release-api` and expose the current checksums and evidence rather than a hard-coded or unverified download.

Stable releases are tag-driven and fail closed unless Developer ID signing and Apple notarization succeed. A manually selected `development-prerelease` is explicitly labeled as not notarized; its evidence cannot claim notarization. See [Release operations](docs/RELEASE.md), [installation](docs/INSTALLATION.md), and [desktop packaging](docs/desktop/PACKAGING.md).

## Scientific and physical boundary

Full-resolution signed HU data stays in the Python engine and binary cache. Preview pyramids, MPR textures, and WebGL textures are derived views and never slicing inputs. Raw identifiable DICOM is not embedded in a project by default, patient fields are redacted from normal logs, and the local-first application does not transmit telemetry. Read [privacy](docs/PRIVACY.md) and [validation](docs/VALIDATION.md) before handling real data.

Generated G-code and a reverse audit prove what the software commanded. They do not prove what a printer deposited. Accepted calibration, attended operation, scan-back registration, and physical measurement remain required for physical HU or geometry conclusions. The app never starts a printer automatically.

## Contribution and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing contracts or release automation. Security reports and supported boundaries are described in [SECURITY.md](SECURITY.md). This repository is licensed under the [MIT License](LICENSE).
