#!/usr/bin/env bash
set -euo pipefail

scripts/check-python-contracts.sh
scripts/run-workspace-suite.sh --label desktop --scripts lint typecheck test build --playwright --paths apps/desktop
scripts/run-workspace-suite.sh --label site-service --scripts lint typecheck test build --playwright --paths apps/site services/release-api
scripts/run-architecture-check.sh
scripts/check-release-evidence.sh
python3 scripts/check-local-links.py
python3 scripts/check-workflow-yaml.py
python3 -m unittest discover -s scripts/tests -p 'test_*.py'
