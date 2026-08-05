# Desktop packaging

VoxelWeave Designer is packaged as a Tauri 2 macOS application for Apple Silicon only. The supported release target is `aarch64-apple-darwin` on `macos-14`, with macOS 14 as the minimum supported operating system.

## Bundle contents

The Tauri bundle contains the React/TypeScript UI, the native macOS shell, the bounded Python engine sidecar, and any native extensions or frameworks required by the existing desktop stack. The sidecar is launched through the Tauri lifecycle and versioned protocol; it is not an arbitrary command runner.

The release helper builds one `.app` and one DMG, scans every Mach-O file below the app, and rejects any component whose architecture is not exactly `arm64`. This includes sidecars, embedded native extensions, dynamic libraries, and frameworks. A successful scan is an architecture fact, not a claim of scientific or physical validity.

## Build path

On an Apple Silicon macOS 14 machine with the desktop workspace integrated:

```sh
pnpm run setup
scripts/build-tauri-release.sh \
  --target aarch64-apple-darwin \
  --output-dir /tmp/voxelweave-bundle
scripts/inspect-architectures.sh \
  --require-mach-o \
  "$(cat /tmp/voxelweave-bundle/app-path.txt)"
```

`build-tauri-release.sh` first runs `scripts/build-sidecar.sh`. That helper
creates a PyInstaller one-file executable from `engine[release]`, using the
package-aware `engine/sidecar_entry.py` launcher, and places it at
`apps/desktop/src-tauri/resources/voxelweave-sidecar` for Tauri to embed. It
requires an arm64 macOS host and verifies both the Mach-O file type and an
exact `lipo -archs` result of `arm64`; it does not fall back to system Python,
Rosetta, or a universal binary. To select a supported Python 3.12 runtime,
set `VOXELWEAVE_PYTHON` before running the helper.

The sidecar smoke and cross-runtime proof can be run independently:

```sh
scripts/build-sidecar.sh --output apps/desktop/src-tauri/resources/voxelweave-sidecar
python3 scripts/cross-runtime-e2e.py \
  --sidecar apps/desktop/src-tauri/resources/voxelweave-sidecar \
  --output-dir /tmp/voxelweave-cross-runtime
```

The proof creates and reopens a `.voxelweave` document, exercises the bundled
JSONL sidecar and correlated errors, emits a deterministic package, and checks
that changing preview resolution leaves the G-code SHA-256 unchanged. Its
physical-fidelity field is deliberately `not_established_by_software`.

The build helper refuses a missing desktop workspace, missing Tauri configuration, a non-macOS host, an unexpected target, an existing non-empty output directory, or an ambiguous bundle result. It does not add a compatibility build for another architecture.

## Signing lanes

Stable release signing uses a temporary CI keychain, Developer ID Application signing, a freshly rebuilt DMG containing the signed app, App Store Connect notarization, stapling, and local validation. Missing credentials or failed Apple validation stops the stable path.

Development prereleases receive a verified ad-hoc bundle seal so their nested code and resources pass strict integrity verification. They are explicitly recorded as not Developer ID-signed or notarized and must not be described as Gatekeeper-trusted, validated for clinical use, or physically validated. See [release operations](../RELEASE.md) for the credential names and evidence flow.

## Runtime assumptions

The installed app must launch without Homebrew, system Python, Node.js, or Rosetta installed. The packaged sidecar owns canonical scientific data and bounded operations; the UI must not generate G-code, treat preview data as slicing input, or expose arbitrary shell execution. See the [engine ADR](ADR-001-ENGINE_STACK.md) and [desktop product contract](PRODUCT_CONTRACT.md).
