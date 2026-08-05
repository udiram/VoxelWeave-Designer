#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: sign-and-notarize.sh --app PATH --dmg PATH --channel stable|development-prerelease --status-file PATH

Stable releases require Apple signing and notarization credentials. The
development-prerelease lane records that notarization was not performed and
does not imply a Gatekeeper-approved artifact.
EOF
}

app=""
dmg=""
channel=""
status_file=""
while (($# > 0)); do
  case "$1" in
    --app|--dmg|--channel|--status-file)
      (($# >= 2)) || { usage; exit 2; }
      case "$1" in
        --app) app="$2" ;;
        --dmg) dmg="$2" ;;
        --channel) channel="$2" ;;
        --status-file) status_file="$2" ;;
      esac
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

[[ -d "$app" && "$app" == *.app ]] || { echo "error: --app must be an existing .app directory" >&2; exit 1; }
[[ -f "$dmg" && "$dmg" == *.dmg ]] || { echo "error: --dmg must be an existing .dmg file" >&2; exit 1; }
[[ "$channel" == "stable" || "$channel" == "development-prerelease" ]] || {
  echo "error: channel must be stable or development-prerelease" >&2
  exit 1
}
[[ -n "$status_file" ]] || { echo "error: --status-file is required" >&2; exit 2; }

mkdir -p "$(dirname "$status_file")"
write_status() {
  local status="$1"
  local signed="$2"
  local notarized="$3"
  local notarization_status="$4"
  python3 - "$status_file" "$status" "$signed" "$notarized" "$notarization_status" <<'PY'
import json
import sys
from pathlib import Path

path, status, signed, notarized, notarization_status = sys.argv[1:]
payload = {
    "status": status,
    "signed": signed == "true",
    "notarized": notarized == "true",
    "notarizationStatus": notarization_status,
}
Path(path).write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
}

if [[ "$channel" == "development-prerelease" ]]; then
  write_status "development-prerelease-not-notarized" false false not-performed
  echo "[signing] development-prerelease: signing/notarization not performed"
  exit 0
fi

required_secrets=(
  APPLE_CERTIFICATE_BASE64
  APPLE_CERTIFICATE_PASSWORD
  APPLE_SIGNING_IDENTITY
  APPLE_API_KEY_BASE64
  APPLE_API_KEY_ID
  APPLE_API_ISSUER
)
missing=()
for secret_name in "${required_secrets[@]}"; do
  if [[ -z "${!secret_name:-}" ]]; then
    missing+=("$secret_name")
  fi
done
if ((${#missing[@]} > 0)); then
  echo "error: stable release is fail-closed; missing Apple secret(s): ${missing[*]}" >&2
  exit 1
fi

for command_name in security codesign xcrun hdiutil spctl ditto python3; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "error: stable release requires macOS command: $command_name" >&2
    exit 1
  }
done

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/voxelweave-signing.XXXXXX")"
keychain="$work_dir/voxelweave-signing.keychain-db"
certificate="$work_dir/certificate.p12"
api_key="$work_dir/AuthKey.p8"
cleanup() {
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$work_dir"
}
trap cleanup EXIT

keychain_password="$(python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(32))
PY
)"
python3 - "$certificate" "$APPLE_CERTIFICATE_BASE64" <<'PY'
import base64
import sys
from pathlib import Path

Path(sys.argv[1]).write_bytes(base64.b64decode(sys.argv[2]))
PY
python3 - "$api_key" "$APPLE_API_KEY_BASE64" <<'PY'
import base64
import sys
from pathlib import Path

Path(sys.argv[1]).write_bytes(base64.b64decode(sys.argv[2]))
PY

security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$certificate" -k "$keychain" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security
security list-keychain -d user -s "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"

echo "[signing] signing app with the configured Developer ID identity"
codesign --force --deep --options runtime --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$app"
codesign --verify --deep --strict --verbose=2 "$app"

signed_dmg="$work_dir/signed.dmg"
echo "[signing] rebuilding DMG from the signed app"
hdiutil create -volname "VoxelWeave Designer" -srcfolder "$app" -ov -format UDZO "$signed_dmg" >/dev/null
unsigned_dmg="$dmg.unsigned-before-signing"
mv "$dmg" "$unsigned_dmg"
mv "$signed_dmg" "$dmg"

echo "[notarization] submitting DMG and waiting for Apple acceptance"
xcrun notarytool submit "$dmg" --key "$api_key" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait
xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
spctl --assess --type open --context context:primary-signature --verbose=2 "$app"

write_status "signed-and-notarized" true true accepted
echo "[signing] stable app signed and DMG notarized/stapled"
