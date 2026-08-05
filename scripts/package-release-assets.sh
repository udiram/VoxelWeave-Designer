#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: package-release-assets.sh --app PATH --dmg PATH --output-dir PATH --version VERSION

Creates the uploadable .app.zip and DMG assets from a signed or explicitly
development-labeled Tauri build.
EOF
}

app=""
dmg=""
output_dir=""
version=""
while (($# > 0)); do
  case "$1" in
    --app|--dmg|--output-dir|--version)
      (($# >= 2)) || { usage; exit 2; }
      case "$1" in
        --app) app="$2" ;;
        --dmg) dmg="$2" ;;
        --output-dir) output_dir="$2" ;;
        --version) version="$2" ;;
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
[[ -n "$output_dir" && -n "$version" ]] || { echo "error: --output-dir and --version are required" >&2; usage; exit 2; }
command -v ditto >/dev/null 2>&1 || { echo "error: ditto is required for macOS release assets" >&2; exit 1; }

mkdir -p "$output_dir"
zip_path="$output_dir/VoxelWeave-Designer-${version}-macos-arm64.app.zip"
dmg_path="$output_dir/VoxelWeave-Designer-${version}-macos-arm64.dmg"
[[ ! -e "$zip_path" && ! -e "$dmg_path" ]] || {
  echo "error: release asset already exists in $output_dir; choose a fresh output directory" >&2
  exit 1
}

ditto -c -k --sequesterRsrc --keepParent "$app" "$zip_path"
ditto "$dmg" "$dmg_path"
echo "[release-assets] app archive=$zip_path"
echo "[release-assets] dmg=$dmg_path"
