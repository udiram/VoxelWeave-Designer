#!/usr/bin/env bash
set -euo pipefail

if (($# == 0)); then
  echo "Usage: dev-workspace.sh WORKSPACE [WORKSPACE ...]" >&2
  exit 2
fi

for workspace in "$@"; do
  if [[ ! -f "$workspace/package.json" ]]; then
    echo "[dev] skip $workspace (workspace not present yet)"
    continue
  fi
  script="$(python3 - "$workspace/package.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    scripts = json.load(handle).get("scripts", {})
for candidate in ("dev", "start"):
    if candidate in scripts:
        print(candidate)
        break
PY
)"
  if [[ -z "$script" ]]; then
    echo "[dev] skip $workspace (no dev or start script)"
    continue
  fi
  echo "[dev] starting $workspace :: $script"
  exec pnpm --dir "$workspace" run "$script"
done

echo "error: none of the requested workspaces has a dev or start script" >&2
exit 1
