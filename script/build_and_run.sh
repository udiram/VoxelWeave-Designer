#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="voxelweave-designer"
BUNDLE_ID="com.voxelweave.designer"
TARGET="aarch64-apple-darwin"
APP_BUNDLE="$ROOT_DIR/apps/desktop/src-tauri/target/$TARGET/release/bundle/macos/VoxelWeave Designer.app"
APP_BINARY="$APP_BUNDLE/Contents/MacOS/$APP_NAME"

pkill -x "$APP_NAME" >/dev/null 2>&1 || true

cd "$ROOT_DIR"
scripts/build-sidecar.sh --output apps/desktop/src-tauri/resources/voxelweave-sidecar
pnpm --dir apps/desktop exec tauri build --target "$TARGET" --bundles app
[[ -x "$APP_BINARY" ]] || { echo "error: packaged app binary not found: $APP_BINARY" >&2; exit 1; }

open_app() {
  /usr/bin/open -n "$APP_BUNDLE"
}

case "$MODE" in
  run)
    open_app
    ;;
  --debug|debug)
    lldb -- "$APP_BINARY"
    ;;
  --logs|logs)
    open_app
    /usr/bin/log stream --info --style compact --predicate "process == \"$APP_NAME\""
    ;;
  --telemetry|telemetry)
    open_app
    /usr/bin/log stream --info --style compact --predicate "subsystem == \"$BUNDLE_ID\""
    ;;
  --verify|verify)
    open_app
    for _ in {1..20}; do
      pgrep -x "$APP_NAME" >/dev/null && exit 0
      sleep 0.25
    done
    echo "error: $APP_NAME did not launch" >&2
    exit 1
    ;;
  *)
    echo "usage: $0 [run|--debug|--logs|--telemetry|--verify]" >&2
    exit 2
    ;;
esac
