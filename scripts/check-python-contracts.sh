#!/usr/bin/env bash
set -euo pipefail

strict="${VOXELWEAVE_REQUIRE_PYTHON_TOOLS:-0}"
failures=0

echo "[contracts/engine] protocol operation parity"
if ! python3 - <<'PY'
import re
from pathlib import Path

typescript = Path("packages/contracts/src/control.ts").read_text(encoding="utf-8")
python = Path("engine/src/voxelweave/protocol.py").read_text(encoding="utf-8")
ts_operations = set(re.findall(r'"([a-z_]+)"', typescript.split("export interface ControlEnvelope", 1)[0]))
py_operations = set(re.findall(r'^\s+[A-Z_]+ = "([a-z_]+)"$', python.split("PROTOCOL_VERSION", 1)[0], re.MULTILINE))
if ts_operations != py_operations:
    raise SystemExit(f"contract operation mismatch: TypeScript={sorted(ts_operations)} Python={sorted(py_operations)}")
print(f"protocol operation parity: {len(ts_operations)} operations")
PY
then
  ((failures += 1))
fi

run_optional_tool() {
  local label="$1"
  shift
  local module="$1"
  shift
  local python_bin="${VOXELWEAVE_PYTHON_BIN:-python3}"
  if [[ -x "engine/.venv/bin/python" ]]; then
    python_bin="engine/.venv/bin/python"
  fi
  if "$python_bin" -c "import ${module}" >/dev/null 2>&1; then
    echo "[contracts/engine] $label"
    if ! "$python_bin" -m "$module" "$@"; then
      ((failures += 1))
    fi
  elif [[ "$strict" == "1" ]]; then
    echo "error: Python module $module is required for contracts/engine checks" >&2
    ((failures += 1))
  else
    echo "[contracts/engine] skip $label (Python module $module is not installed)"
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
  run_optional_tool "Python type check" mypy --config-file engine/pyproject.toml engine/src
  if [[ -d engine/tests ]]; then
    run_optional_tool "Python tests" pytest engine/tests
  else
    echo "[contracts/engine] skip Python tests (engine/tests not present yet)"
  fi
else
  echo "[contracts/engine] skip engine (directory not present yet)"
fi

if ((failures > 0)); then
  echo "error: contracts/engine checks failed ($failures failure(s))" >&2
  exit 1
fi
echo "[contracts/engine] complete"
