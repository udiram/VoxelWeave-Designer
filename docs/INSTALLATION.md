# Installation

VoxelWeave Designer v1 is distributed for Apple Silicon Macs running macOS 14 or newer. There is no supported Intel, Windows, Linux, Rosetta, or universal-binary package.

## Download

Use the current release shown by the VoxelWeave public site or the repository's GitHub Releases page. Download the `.app.zip`, the matching `.dmg`, and `SHA256SUMS` from the same release. Keep `release-evidence.json` with the artifact when recording a research run.

From the directory containing the downloaded files:

```sh
shasum -a 256 -c SHA256SUMS
```

The command must report a match for each listed asset. If it does not, stop and download the files again; do not use a mismatched app and DMG.

## Stable release

Open the DMG, copy `VoxelWeave Designer.app` to Applications, eject the volume, and launch the app. A stable release is expected to have a valid Developer ID signature and a stapled Apple notarization ticket. If macOS reports that the artifact is damaged or the signature cannot be verified, stop and report the exact release version and message.

## Development prerelease

A `development-prerelease` is explicitly not notarized. It is useful for controlled development testing only and may be blocked by local or organizational Gatekeeper policy. Do not disable macOS security controls to force it open; use a stable artifact or follow the lab's approved local testing procedure.

## Data handling before first import

Use synthetic or redacted data for setup checks. Raw identifiable DICOM is not embedded in a `.voxelweave` document by default, but source paths, derived cache identities, transforms, calibrations, and evidence references can still be sensitive. Read [Privacy](PRIVACY.md) and [Validation](VALIDATION.md) before importing a real series.
