#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: deploy-railway.sh --bundle-dir PATH --confirm

The explicit --confirm guard is required. Set RAILWAY_TOKEN, RAILWAY_PROJECT_ID,
RAILWAY_SERVICE, and RAILWAY_ENVIRONMENT before invoking this mutating command.
The repository task does not run it.
EOF
}

bundle_dir=""
confirmed=0
while (($# > 0)); do
  case "$1" in
    --bundle-dir)
      (($# >= 2)) || { usage; exit 2; }
      bundle_dir="$2"
      shift 2
      ;;
    --confirm)
      confirmed=1
      shift
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

((confirmed == 1)) || { echo "error: deployment requires explicit --confirm" >&2; exit 1; }
[[ -d "$bundle_dir" && -f "$bundle_dir/railway-bundle.json" ]] || {
  echo "error: bundle directory must contain railway-bundle.json: $bundle_dir" >&2
  exit 1
}
for variable in RAILWAY_TOKEN RAILWAY_PROJECT_ID RAILWAY_SERVICE RAILWAY_ENVIRONMENT; do
  [[ -n "${!variable:-}" ]] || { echo "error: missing $variable" >&2; exit 1; }
done
command -v railway >/dev/null 2>&1 || { echo "error: railway CLI is required" >&2; exit 1; }

echo "[railway] deploying service=$RAILWAY_SERVICE environment=$RAILWAY_ENVIRONMENT"
railway up "$bundle_dir" \
  --project "$RAILWAY_PROJECT_ID" \
  --service "$RAILWAY_SERVICE" \
  --environment "$RAILWAY_ENVIRONMENT" \
  --detach
