#!/usr/bin/env bash
set -euo pipefail

command -v pnpm >/dev/null 2>&1 || {
  echo "error: pnpm is required; enable the version in package.json with Corepack" >&2
  exit 1
}

install_one() {
  local directory="$1"
  [[ -f "$directory/package.json" ]] || return 0
  local frozen_flag="--no-frozen-lockfile"
  if [[ -f "$directory/pnpm-lock.yaml" ]]; then
    frozen_flag="--frozen-lockfile"
  fi
  echo "[setup] installing $directory ($frozen_flag)"
  pnpm --dir "$directory" install --ignore-scripts "$frozen_flag"
}

install_one "."
for workspace in apps/desktop apps/site packages/contracts services/release-api; do
  if [[ -f "$workspace/package.json" ]]; then
    install_one "$workspace"
  else
    echo "[setup] skip $workspace (workspace not present yet)"
  fi
done
