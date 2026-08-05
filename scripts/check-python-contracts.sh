#!/usr/bin/env bash
set -euo pipefail

strict="${VOXELWEAVE_REQUIRE_PYTHON_TOOLS:-0}"
failures=0

run_optional_tool() {
  local label="$1"
  shift
  local executable="$1"
  shift
  if command -v "$executable" >/dev/null 2>&1; then
    echo "[contracts/engine] $label"
    if ! "$executable" "$@"; then
      ((failures += 1))
    fi
  elif [[ "$strict" == "1" ]]; then
    echo "error: $executable is required for contracts/engine checks" >&2
    ((failures += 1))
  else
    echo "[contracts/engine] skip $label ($executable is not installed)"
  fi
}

if [[ -d packages/contracts && -f packages/contracts/package.json ]]; then
  if ! scripts/run-workspace-suite.sh \
    --label contracts \
    --scripts lint typecheck test \
    --paths packages/contracts; then
    ((failures += 1))
  fi
else
  echo "[contracts/engine] skip packages/contracts (workspace not present yet)"
fi

if [[ -d engine ]]; then
  run_optional_tool "Python lint" ruff check engine
  run_optional_tool "Python type check" mypy engine
  if command -v pytest >/dev/null 2>&1; then
    echo "[contracts/engine] Python tests"
    if [[ -d engine/tests ]]; then
      if ! pytest engine/tests; then
        ((failures += 1))
      fi
    else
      echo "[contracts/engine] skip Python tests (engine/tests not present yet)"
    fi
  elif [[ "$strict" == "1" ]]; then
    echo "error: pytest is required for contracts/engine checks" >&2
    ((failures += 1))
  else
    echo "[contracts/engine] skip Python tests (pytest is not installed)"
  fi
else
  echo "[contracts/engine] skip engine (directory not present yet)"
fi

if ((failures > 0)); then
  echo "error: contracts/engine checks failed ($failures failure(s))" >&2
  exit 1
fi
echo "[contracts/engine] complete"
