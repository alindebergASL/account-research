#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $# -ne 2 ]]; then
  echo "[restore-web-data] usage: restore-web-data.sh <backup-directory> <new-target-data-directory>" >&2
  exit 2
fi
cd "$REPO_ROOT/web"
exec node --import tsx scripts/endgameOperations.ts restore "$1" "$2"
