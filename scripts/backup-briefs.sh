#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${BRIEF_DB_PATH:-$REPO_ROOT/web/data/briefs.sqlite}"
DEST_DIR="${BRIEF_BACKUP_DIR:-$HOME/account-research-backups}"

if [[ ! -f "$SRC" ]]; then
  echo "[backup-briefs] configured source database is absent" >&2
  exit 1
fi

ts="$(date -u +%Y%m%dT%H%M%SZ)"
out="${1:-$DEST_DIR/web-data-$ts}"
exec "$REPO_ROOT/scripts/backup-web-data.sh" "$out"
