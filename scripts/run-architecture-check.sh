#!/usr/bin/env bash
set -euo pipefail

paths=()
if (($# > 0)); then
  paths=("$@")
else
  for candidate in \
    apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos \
    apps/desktop/src-tauri/target/release/bundle/macos \
    release-output; do
    if [[ -e "$candidate" ]]; then
      paths+=("$candidate")
    fi
  done
fi

if ((${#paths[@]} == 0)); then
  echo "[architecture] skip (no built macOS artifact is present)"
  exit 0
fi

scripts/inspect-architectures.sh "${paths[@]}"
