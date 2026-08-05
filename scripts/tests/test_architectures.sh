#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/voxelweave-arch.XXXXXX")"
trap 'rm -rf "$fixture_root"' EXIT

mkdir -p "$fixture_root/arm64" "$fixture_root/x86" "$fixture_root/universal" "$fixture_root/bin"
touch "$fixture_root/arm64/arm64.bin" "$fixture_root/x86/x86.bin" "$fixture_root/universal/universal.bin"

python3 - "$fixture_root/bin/file" "$fixture_root/bin/lipo" <<'PY'
from pathlib import Path
import sys

file_path, lipo_path = map(Path, sys.argv[1:])
file_path.write_text(
    """#!/usr/bin/env bash
set -euo pipefail
candidate="${@: -1}"
case "$(basename "$candidate")" in
  arm64.bin) echo 'Mach-O 64-bit executable arm64' ;;
  x86.bin) echo 'Mach-O 64-bit executable x86_64' ;;
  universal.bin) echo 'Mach-O universal binary' ;;
  *) echo 'ASCII text' ;;
esac
""",
    encoding="utf-8",
)
lipo_path.write_text(
    """#!/usr/bin/env bash
set -euo pipefail
candidate="${@: -1}"
case "$(basename "$candidate")" in
  arm64.bin) echo arm64 ;;
  x86.bin) echo x86_64 ;;
  universal.bin) echo 'arm64 x86_64' ;;
  *) exit 1 ;;
esac
""",
    encoding="utf-8",
)
file_path.chmod(0o755)
lipo_path.chmod(0o755)
PY

export VOXELWEAVE_ARCH_FILE_BIN="$fixture_root/bin/file"
export VOXELWEAVE_ARCH_LIPO_BIN="$fixture_root/bin/lipo"

"$repo_root/scripts/inspect-architectures.sh" --require-mach-o "$fixture_root/arm64"
if "$repo_root/scripts/inspect-architectures.sh" --require-mach-o "$fixture_root/x86"; then
  echo "error: x86_64 fixture was accepted" >&2
  exit 1
fi
if "$repo_root/scripts/inspect-architectures.sh" --require-mach-o "$fixture_root/universal"; then
  echo "error: universal fixture was accepted" >&2
  exit 1
fi

echo "architecture fixtures: arm64 accepted; x86_64 and universal rejected"
