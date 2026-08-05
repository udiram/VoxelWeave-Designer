#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: build-sidecar.sh [--output PATH]

Builds the Python engine into one self-contained Apple Silicon executable for
the Tauri resource bundle. The build is intentionally arm64-only.
EOF
}

output="apps/desktop/src-tauri/resources/voxelweave-sidecar"
while (($# > 0)); do
  case "$1" in
    --output)
      (($# >= 2)) || { usage; exit 2; }
      output="$2"
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

[[ "$(uname -s)" == "Darwin" ]] || { echo "error: sidecar packaging requires macOS" >&2; exit 1; }
[[ "$(uname -m)" == "arm64" ]] || { echo "error: sidecar packaging requires an arm64 host; Rosetta is unsupported" >&2; exit 1; }
command -v lipo >/dev/null 2>&1 || { echo "error: lipo is required to verify the sidecar architecture" >&2; exit 1; }
command -v file >/dev/null 2>&1 || { echo "error: file is required to verify the sidecar architecture" >&2; exit 1; }

python_bin="${VOXELWEAVE_PYTHON:-python3}"
command -v "$python_bin" >/dev/null 2>&1 || { echo "error: Python executable not found: $python_bin" >&2; exit 1; }
"$python_bin" - <<'PY'
import platform
import sys

if sys.version_info < (3, 11):
    raise SystemExit("error: Python 3.11 or newer is required to package the sidecar")
if platform.machine() != "arm64":
    raise SystemExit("error: the Python packaging runtime must be arm64")
PY

build_root="$(mktemp -d "${TMPDIR:-/tmp}/voxelweave-sidecar.XXXXXX")"
cleanup() { rm -rf "$build_root"; }
trap cleanup EXIT

venv="$build_root/venv"
"$python_bin" -m venv "$venv"
venv_python="$venv/bin/python"
"$venv_python" -m pip install --disable-pip-version-check --upgrade pip >/dev/null
"$venv_python" -m pip install --disable-pip-version-check -e 'engine[release]' >/dev/null

"$venv_python" -m PyInstaller \
  --noconfirm \
  --clean \
  --onefile \
  --name voxelweave-sidecar \
  --distpath "$build_root/dist" \
  --workpath "$build_root/build" \
  --specpath "$build_root" \
  --paths engine/src \
  --collect-submodules voxelweave \
  engine/sidecar_entry.py

mkdir -p "$(dirname "$output")"
install -m 0755 "$build_root/dist/voxelweave-sidecar" "$output"
description="$(file -Lb "$output")"
architectures="$(lipo -archs "$output")"
[[ "$description" == *Mach-O* ]] || { echo "error: sidecar is not a Mach-O executable: $description" >&2; exit 1; }
[[ "$architectures" == "arm64" ]] || { echo "error: sidecar architectures=$architectures; expected exactly arm64" >&2; exit 1; }
echo "[sidecar] path=$output"
echo "[sidecar] $description"
echo "[sidecar] architectures=$architectures"
