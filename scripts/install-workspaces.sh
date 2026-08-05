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
  pnpm --dir "$directory" install "$frozen_flag"
}

install_one "."
for workspace in apps/desktop apps/site packages/contracts services/release-api; do
  if [[ -f "$workspace/package.json" ]]; then
    install_one "$workspace"
  else
    echo "[setup] skip $workspace (workspace not present yet)"
  fi
done

if [[ "${VOXELWEAVE_SKIP_PYTHON_SETUP:-0}" != "1" && -f engine/pyproject.toml ]]; then
  python_bin="${VOXELWEAVE_PYTHON:-python3}"
  command -v "$python_bin" >/dev/null 2>&1 || { echo "error: Python executable not found: $python_bin" >&2; exit 1; }
  if [[ ! -x engine/.venv/bin/python ]]; then
    echo "[setup] creating engine/.venv with $python_bin"
    "$python_bin" -m venv engine/.venv
  fi
  echo "[setup] installing engine test dependencies"
  engine/.venv/bin/python -m pip install --disable-pip-version-check --upgrade pip >/dev/null
  engine/.venv/bin/python -m pip install --disable-pip-version-check -e 'engine[test]' >/dev/null
else
  echo "[setup] skip Python engine setup"
fi
