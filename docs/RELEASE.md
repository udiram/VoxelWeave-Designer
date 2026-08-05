# Release operations

VoxelWeave releases are Apple Silicon macOS artifacts with evidence attached. A release is not complete because a Tauri command returned successfully: the native scan, checksums, package evidence, and signing lane must agree.

## Release lanes

| Lane | Trigger | Signing contract | Public meaning |
| --- | --- | --- | --- |
| `stable` | `v*.*.*` tag | Developer ID signing, Apple notarization, stapler validation, and `spctl` must pass | Public release candidate for supported Apple Silicon macOS 14+ users |
| `development-prerelease` | Manual workflow dispatch | Signing/notarization is recorded as not performed | Development artifact; not notarized and not a clinical or physical-validation claim |

The workflow does not convert a failed stable signing attempt into a development artifact. Stable is fail-closed when credentials or Apple validation are unavailable.

## Stable credentials

Configure these as GitHub Actions secrets before authorizing a stable tag:

- `APPLE_CERTIFICATE_BASE64` — Developer ID Application `.p12`, base64 encoded.
- `APPLE_CERTIFICATE_PASSWORD` — password for that certificate.
- `APPLE_SIGNING_IDENTITY` — exact Developer ID Application identity.
- `APPLE_API_KEY_BASE64` — App Store Connect API key, base64 encoded.
- `APPLE_API_KEY_ID` — App Store Connect key ID.
- `APPLE_API_ISSUER` — App Store Connect issuer UUID.

The signing helper creates a temporary keychain, signs the app, rebuilds the DMG from the signed app, submits it to Apple, staples the ticket, and validates the result. Temporary keychain and API-key files are removed on exit. The evidence manifest records only booleans and statuses, never credentials.

## Local release path

The complete packaging path is intended for an Apple Silicon macOS 14 runner and requires the desktop workspace to be integrated:

```sh
pnpm run setup
mkdir -p /tmp/voxelweave-release
scripts/build-tauri-release.sh \
  --target aarch64-apple-darwin \
  --output-dir /tmp/voxelweave-release/bundle
scripts/sign-and-notarize.sh \
  --app "$(cat /tmp/voxelweave-release/bundle/app-path.txt)" \
  --dmg "$(cat /tmp/voxelweave-release/bundle/dmg-path.txt)" \
  --channel development-prerelease \
  --status-file /tmp/voxelweave-release/signing.json
scripts/inspect-architectures.sh \
  --require-mach-o \
  "$(cat /tmp/voxelweave-release/bundle/app-path.txt)" \
  > /tmp/voxelweave-release/architecture-report.txt
scripts/package-release-assets.sh \
  --app "$(cat /tmp/voxelweave-release/bundle/app-path.txt)" \
  --dmg "$(cat /tmp/voxelweave-release/bundle/dmg-path.txt)" \
  --output-dir /tmp/voxelweave-release/assets \
  --version development-local
python3 scripts/create-release-evidence.py \
  --artifact-dir /tmp/voxelweave-release/assets \
  --output-dir /tmp/voxelweave-release \
  --version development-local \
  --git-sha "$(git rev-parse HEAD)" \
  --channel development-prerelease \
  --signing-status-file /tmp/voxelweave-release/signing.json \
  --architecture-report /tmp/voxelweave-release/architecture-report.txt
python3 scripts/verify-release-evidence.py \
  --schema scripts/release-evidence.schema.json \
  --manifest /tmp/voxelweave-release/release-evidence.json \
  --artifact-root /tmp/voxelweave-release
```

The GitHub workflow runs this same sequence and uploads the `.app.zip`, DMG,
`SHA256SUMS`, `architecture-report.txt`, and `release-evidence.json` to the
GitHub release. The public Railway site should read those release records
through `services/release-api` and present the current artifact hashes; it
must not invent a version or test count.

## Evidence contract

`[scripts/release-evidence.schema.json](../scripts/release-evidence.schema.json)` requires:

- the exact `macos-14` runner and `aarch64-apple-darwin` Rust target;
- an `arm64` app archive and a DMG with byte size and SHA-256;
- passed architecture, checksum, and packaging checks;
- explicit signing and notarization status for the selected lane.

The verifier also re-hashes every asset and checks that `SHA256SUMS` exactly matches the manifest. Editing an asset after evidence generation is therefore a release failure, not a cosmetic mismatch.

## Railway release service

`pnpm run railway:bundle` conditionally builds `apps/site` and `services/release-api` into a reviewable staging directory and writes `railway-bundle.json`. It does not edit either workspace. The manual [Railway workflow](../.github/workflows/railway.yml) uploads that bundle and has a separate explicit deployment input. Railway project, service, environment, and token values remain operator-owned; this repository does not deploy them automatically.
