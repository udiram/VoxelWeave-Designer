#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VOXELWEAVE_ALLOW_NON_MACOS=1 python3 "$repo_root/scripts/tests/test_native_release_qa.py"
