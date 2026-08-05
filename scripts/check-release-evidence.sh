#!/usr/bin/env bash
set -euo pipefail

manifest="${VOXELWEAVE_RELEASE_MANIFEST:-.release/release-evidence.json}"
if [[ ! -f "$manifest" ]]; then
  if [[ "${VOXELWEAVE_REQUIRE_RELEASE_EVIDENCE:-0}" == "1" ]]; then
    echo "error: release evidence manifest not found at $manifest" >&2
    exit 1
  fi
  echo "[release-evidence] skip (no manifest at $manifest)"
  exit 0
fi

schema="${VOXELWEAVE_RELEASE_SCHEMA:-scripts/release-evidence.schema.json}"
artifact_root="${VOXELWEAVE_RELEASE_ARTIFACT_ROOT:-$(dirname "$manifest")}"
python3 scripts/verify-release-evidence.py \
  --schema "$schema" \
  --manifest "$manifest" \
  --artifact-root "$artifact_root"
