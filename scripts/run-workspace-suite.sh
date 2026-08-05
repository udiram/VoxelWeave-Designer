#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: run-workspace-suite.sh --label NAME --paths PATH [PATH ...] --scripts SCRIPT [SCRIPT ...] [--playwright]

Runs scripts only when the workspace and that script exist. Set
VOXELWEAVE_STRICT_WORKSPACES=1 to turn skipped workspaces/scripts into failures.
EOF
}

label="workspace"
strict="${VOXELWEAVE_STRICT_WORKSPACES:-0}"
playwright=0
paths=()
scripts=()
mode=""

while (($# > 0)); do
  case "$1" in
    --label)
      (($# >= 2)) || { usage; exit 2; }
      label="$2"
      shift 2
      ;;
    --paths)
      mode="paths"
      shift
      ;;
    --scripts)
      mode="scripts"
      shift
      ;;
    --playwright)
      playwright=1
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
      if [[ "$mode" == "paths" ]]; then
        paths+=("$1")
      elif [[ "$mode" == "scripts" ]]; then
        scripts+=("$1")
      else
        echo "error: values must follow --paths or --scripts: $1" >&2
        usage
        exit 2
      fi
      shift
      ;;
  esac
done

((${#paths[@]} > 0)) || { echo "error: at least one workspace path is required" >&2; usage; exit 2; }
((${#scripts[@]} > 0 || playwright == 1)) || { echo "error: at least one script or --playwright is required" >&2; usage; exit 2; }

manifest_has_script() {
  local manifest="$1"
  local script="$2"
  python3 - "$manifest" "$script" <<'PY'
import json
import sys

manifest_path, script_name = sys.argv[1:]
try:
    with open(manifest_path, encoding="utf-8") as handle:
        package = json.load(handle)
except (OSError, json.JSONDecodeError):
    raise SystemExit(2)
raise SystemExit(0 if script_name in package.get("scripts", {}) else 1)
PY
}

run_script() {
  local workspace="$1"
  local script="$2"
  echo "[$label] $workspace :: $script"
  if ! pnpm --dir "$workspace" run "$script"; then
    echo "error: $label failed in $workspace ($script)" >&2
    return 1
  fi
}

failures=0
executed=0
skipped=0

for workspace in "${paths[@]}"; do
  if [[ ! -d "$workspace" || ! -f "$workspace/package.json" ]]; then
    echo "[$label] skip $workspace (workspace not present yet)"
    ((skipped += 1))
    if [[ "$strict" == "1" ]]; then
      echo "error: strict mode requires workspace $workspace" >&2
      ((failures += 1))
    fi
    continue
  fi

  manifest="$workspace/package.json"
  for script in "${scripts[@]}"; do
    if ! manifest_has_script "$manifest" "$script"; then
      echo "[$label] skip $workspace :: $script (script not declared)"
      ((skipped += 1))
      if [[ "$strict" == "1" ]]; then
        echo "error: strict mode requires $workspace/$script" >&2
        ((failures += 1))
      fi
      continue
    fi
    ((executed += 1))
    if ! run_script "$workspace" "$script"; then
      ((failures += 1))
    fi
  done

  if ((playwright == 1)); then
    playwright_script=""
    for candidate in test:e2e playwright:test test:playwright e2e; do
      if manifest_has_script "$manifest" "$candidate"; then
        playwright_script="$candidate"
        break
      fi
    done
    if [[ -z "$playwright_script" ]]; then
      echo "[$label] skip $workspace :: Playwright (no test:e2e, playwright:test, test:playwright, or e2e script)"
      ((skipped += 1))
      if [[ "$strict" == "1" ]]; then
        echo "error: strict mode requires a Playwright script in $workspace" >&2
        ((failures += 1))
      fi
    else
      ((executed += 1))
      if ! run_script "$workspace" "$playwright_script"; then
        ((failures += 1))
      fi
    fi
  fi
done

echo "[$label] complete: executed=$executed skipped=$skipped failures=$failures"
((failures == 0))
