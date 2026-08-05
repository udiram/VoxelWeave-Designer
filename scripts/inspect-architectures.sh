#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: inspect-architectures.sh [--require-mach-o] PATH [PATH ...]

Inspect every Mach-O file below each path. A passing native artifact contains
only one architecture: arm64. Set VOXELWEAVE_ARCH_FILE_BIN and
VOXELWEAVE_ARCH_LIPO_BIN to controlled command doubles for fixture tests.
EOF
}

require_macho=0
paths=()
while (($# > 0)); do
  case "$1" in
    --require-mach-o)
      require_macho=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --*)
      echo "error: unknown option: $1" >&2
      usage
      exit 2
      ;;
    *)
      paths+=("$1")
      shift
      ;;
  esac
done

((${#paths[@]} > 0)) || { usage; exit 2; }

file_bin="${VOXELWEAVE_ARCH_FILE_BIN:-file}"
lipo_bin="${VOXELWEAVE_ARCH_LIPO_BIN:-lipo}"
command -v "$file_bin" >/dev/null 2>&1 || {
  echo "error: file command not found at $file_bin" >&2
  exit 1
}

if ! command -v "$lipo_bin" >/dev/null 2>&1; then
  lipo_bin=""
fi

files=()
for input in "${paths[@]}"; do
  if [[ ! -e "$input" ]]; then
    echo "error: architecture input does not exist: $input" >&2
    exit 1
  fi
  if [[ -f "$input" ]]; then
    files+=("$input")
  elif [[ -d "$input" ]]; then
    while IFS= read -r -d '' candidate; do
      files+=("$candidate")
    done < <(find -H "$input" -type f -print0)
  else
    echo "error: architecture input is not a regular file or directory: $input" >&2
    exit 1
  fi
done

macho_count=0
failures=0
seen=()

already_seen() {
  local candidate="$1"
  local existing
  ((${#seen[@]} > 0)) || return 1
  for existing in "${seen[@]}"; do
    [[ "$existing" == "$candidate" ]] && return 0
  done
  return 1
}

for candidate in "${files[@]}"; do
  if already_seen "$candidate"; then
    continue
  fi
  seen+=("$candidate")
  description="$($file_bin -Lb "$candidate" 2>/dev/null || true)"
  if [[ "$description" != *Mach-O* ]]; then
    continue
  fi
  ((macho_count += 1))
  if [[ -z "$lipo_bin" ]]; then
    echo "error: Mach-O found but lipo is unavailable; cannot verify $candidate" >&2
    ((failures += 1))
    continue
  fi
  architectures="$($lipo_bin -archs "$candidate" 2>/dev/null || true)"
  if [[ "$architectures" != "arm64" ]]; then
    echo "FAIL $candidate :: architectures=${architectures:-unreadable} (expected exactly arm64)" >&2
    ((failures += 1))
  else
    echo "PASS $candidate :: architectures=arm64"
  fi
done

if ((macho_count == 0)); then
  if ((require_macho == 1)); then
    echo "error: no Mach-O files found in the requested artifact paths" >&2
    exit 1
  fi
  echo "[architecture] no Mach-O files found; nothing native to inspect"
fi

if ((failures > 0)); then
  echo "error: architecture inspection rejected $failures Mach-O file(s)" >&2
  exit 1
fi
echo "[architecture] complete: inspected=$macho_count native file(s), target=arm64"
