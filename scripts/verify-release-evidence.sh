#!/usr/bin/env bash
set -euo pipefail

if (($# == 0)); then
  echo "Usage: verify-release-evidence.sh --schema PATH --manifest PATH --artifact-root PATH" >&2
  exit 2
fi

python3 scripts/verify-release-evidence.py "$@"
