#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: build-tauri-release.sh --output-dir PATH [--target aarch64-apple-darwin]

Builds the existing Tauri desktop workspace into one .app and one DMG. The
output directory must be empty or absent. This command is intended for macOS.
EOF
}

target="aarch64-apple-darwin"
output_dir=""
while (($# > 0)); do
  case "$1" in
    --target)
      (($# >= 2)) || { usage; exit 2; }
      target="$2"
      shift 2
      ;;
    --output-dir)
      (($# >= 2)) || { usage; exit 2; }
      output_dir="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown or misplaced argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

[[ "$target" == "aarch64-apple-darwin" ]] || {
  echo "error: only aarch64-apple-darwin is supported" >&2
  exit 1
}
[[ -n "$output_dir" ]] || { echo "error: --output-dir is required" >&2; usage; exit 2; }
[[ "$(uname -s)" == "Darwin" ]] || {
  echo "error: Tauri packaging is restricted to macOS; run this on a macos-14 runner" >&2
  exit 1
}
command -v pnpm >/dev/null 2>&1 || { echo "error: pnpm is required" >&2; exit 1; }
[[ -f apps/desktop/package.json ]] || {
  echo "error: apps/desktop/package.json is not present; integrate the desktop workspace before releasing" >&2
  exit 1
}

tauri_config=""
for candidate in apps/desktop/src-tauri/tauri.conf.json apps/desktop/src-tauri/tauri.conf.json5 apps/desktop/src-tauri/tauri.conf.toml; do
  if [[ -f "$candidate" ]]; then
    tauri_config="$candidate"
    break
  fi
done
[[ -n "$tauri_config" ]] || {
  echo "error: no Tauri configuration found below apps/desktop/src-tauri" >&2
  exit 1
}

mkdir -p "$output_dir"
if [[ -n "$(ls -A "$output_dir" 2>/dev/null)" ]]; then
  echo "error: output directory is not empty: $output_dir" >&2
  exit 1
fi

echo "[tauri] building target=$target from apps/desktop"
scripts/build-sidecar.sh --output apps/desktop/src-tauri/resources/voxelweave-sidecar
pnpm --dir apps/desktop exec tauri build --target "$target" --bundles app,dmg

bundle_roots=(
  "apps/desktop/src-tauri/target/$target/release/bundle"
  "apps/desktop/target/$target/release/bundle"
)
bundle_root=""
for candidate in "${bundle_roots[@]}"; do
  if [[ -d "$candidate" ]]; then
    bundle_root="$candidate"
    break
  fi
done
[[ -n "$bundle_root" ]] || {
  echo "error: Tauri did not produce a bundle directory for $target" >&2
  exit 1
}

apps=()
while IFS= read -r -d '' candidate; do
  apps+=("$candidate")
done < <(find "$bundle_root" -type d -name '*.app' -print0)
dmgs=()
while IFS= read -r -d '' candidate; do
  dmgs+=("$candidate")
done < <(find "$bundle_root" -type f -name '*.dmg' -print0)

if ((${#apps[@]} != 1)); then
  echo "error: expected exactly one Tauri .app, found ${#apps[@]} below $bundle_root" >&2
  exit 1
fi
if ((${#dmgs[@]} != 1)); then
  echo "error: expected exactly one Tauri DMG, found ${#dmgs[@]} below $bundle_root" >&2
  exit 1
fi

app_output="$output_dir/$(basename "${apps[0]}")"
dmg_output="$output_dir/$(basename "${dmgs[0]}")"
ditto "${apps[0]}" "$app_output"
ditto "${dmgs[0]}" "$dmg_output"
printf '%s\n' "$app_output" > "$output_dir/app-path.txt"
printf '%s\n' "$dmg_output" > "$output_dir/dmg-path.txt"
printf '%s\n' "$target" > "$output_dir/target.txt"
echo "[tauri] app=$app_output"
echo "[tauri] dmg=$dmg_output"
