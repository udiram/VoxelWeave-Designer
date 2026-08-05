#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: build-railway-bundle.sh [--output-dir PATH]

Builds and stages the public site plus release API from apps/site and
services/release-api without editing either workspace. Missing workspaces are
reported as pending integration; set VOXELWEAVE_REQUIRE_RAILWAY_WORKSPACES=1
to fail until both are present.
EOF
}

output_dir=".railway/bundle"
while (($# > 0)); do
  case "$1" in
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
      echo "error: unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

command -v pnpm >/dev/null 2>&1 || { echo "error: pnpm is required" >&2; exit 1; }
mkdir -p "$output_dir"
if [[ -n "$(ls -A "$output_dir" 2>/dev/null)" ]]; then
  echo "error: output directory is not empty: $output_dir" >&2
  exit 1
fi

strict="${VOXELWEAVE_REQUIRE_RAILWAY_WORKSPACES:-0}"
site_status="missing"
api_status="missing"
site_build=""
api_build=""

has_script() {
  python3 - "$1/package.json" "$2" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        package = json.load(handle)
except (OSError, json.JSONDecodeError):
    raise SystemExit(1)
raise SystemExit(0 if sys.argv[2] in package.get("scripts", {}) else 1)
PY
}

find_build_output() {
  local workspace="$1"
  for candidate in dist build out .next; do
    if [[ -d "$workspace/$candidate" ]]; then
      printf '%s\n' "$workspace/$candidate"
      return 0
    fi
  done
  return 1
}

if [[ -f apps/site/package.json ]]; then
  if has_script apps/site build; then
    echo "[railway] building apps/site"
    pnpm --dir apps/site run build
    if site_build="$(find_build_output apps/site)"; then
      site_status="built"
    else
      echo "error: apps/site build completed but no dist/build/out/.next directory was found" >&2
      exit 1
    fi
  else
    echo "[railway] skip apps/site (no build script)"
    site_status="no-build-script"
  fi
else
  echo "[railway] skip apps/site (workspace not present yet)"
fi

if [[ -f services/release-api/package.json ]]; then
  if has_script services/release-api build; then
    echo "[railway] building services/release-api"
    pnpm --dir services/release-api run build
    if api_build="$(find_build_output services/release-api)"; then
      api_status="built"
    else
      api_build="services/release-api"
      api_status="source-only"
    fi
  else
    echo "[railway] services/release-api has no build script; staging its source"
    api_build="services/release-api"
    api_status="source-only"
  fi
else
  echo "[railway] skip services/release-api (workspace not present yet)"
fi

if [[ "$strict" == "1" && ( ! -d apps/site || ! -d services/release-api ) ]]; then
  echo "error: strict Railway bundle mode requires apps/site and services/release-api" >&2
  exit 1
fi

python3 - "$output_dir" "$site_build" "$api_build" "$site_status" "$api_status" <<'PY'
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

output, site_build, api_build, site_status, api_status = sys.argv[1:]
output_path = Path(output).resolve()

def copy_source(source: str, destination: Path) -> None:
    if not source:
        return
    source_path = Path(source).resolve()
    if not source_path.exists():
        raise SystemExit(f"error: Railway staging source does not exist: {source_path}")
    if source_path.is_dir():
        shutil.copytree(source_path, destination, dirs_exist_ok=True, ignore=shutil.ignore_patterns("node_modules", ".git"))
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path, destination)

if site_build:
    copy_source(site_build, output_path / "site")
if api_build:
    copy_source(api_build, output_path / "release-api")

manifest = {
    "schemaVersion": "voxelweave.railway-bundle.v1",
    "generatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "site": {"source": "apps/site", "status": site_status, "stagedPath": "site" if site_build else None},
    "releaseApi": {
        "source": "services/release-api",
        "status": api_status,
        "stagedPath": "release-api" if api_build else None,
    },
    "deploymentContract": {
        "service": "combined-site-release-api",
        "healthPath": "/health",
        "releaseDownloadPath": "/releases",
        "note": "Railway configuration and external deployment remain operator-owned.",
    },
}
(output_path / "railway-bundle.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

echo "[railway] bundle=$output_dir"
echo "[railway] site=$site_status release-api=$api_status"
