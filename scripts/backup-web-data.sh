#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DB="${BRIEF_DB_PATH:-$REPO_ROOT/web/data/briefs.sqlite}"

if [[ $# -ne 1 ]]; then
  echo "[backup-web-data] usage: backup-web-data.sh <new-backup-directory>" >&2
  exit 2
fi
if [[ ! -f "$SOURCE_DB" ]]; then
  echo "[backup-web-data] configured source database is absent" >&2
  exit 1
fi

cd "$REPO_ROOT/web"
exec node --import tsx scripts/endgameOperations.ts backup "$1"
