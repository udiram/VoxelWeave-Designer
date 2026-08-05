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

The build helper refuses a missing desktop workspace, missing Tauri configuration, a non-macOS host, an unexpected target, an existing non-empty output directory, or an ambiguous bundle result. It does not add a compatibility build for another architecture.

## Signing lanes

Stable release signing uses a temporary CI keychain, Developer ID Application signing, a freshly rebuilt DMG containing the signed app, App Store Connect notarization, stapling, and local validation. Missing credentials or failed Apple validation stops the stable path.

Development prereleases are explicitly recorded as not notarized. They must not be described as notarized, validated for clinical use, or physically validated. See [release operations](../RELEASE.md) for the credential names and evidence flow.

## Runtime assumptions

The installed app must launch without Homebrew, system Python, Node.js, or Rosetta installed. The packaged sidecar owns canonical scientific data and bounded operations; the UI must not generate G-code, treat preview data as slicing input, or expose arbitrary shell execution. See the [engine ADR](ADR-001-ENGINE_STACK.md) and [desktop product contract](PRODUCT_CONTRACT.md).
