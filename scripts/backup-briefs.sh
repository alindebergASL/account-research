#!/usr/bin/env bash
set -euo pipefail

SRC="${BRIEF_DB_PATH:-$HOME/account-research/web/data/briefs.sqlite}"
DEST_DIR="${BRIEF_BACKUP_DIR:-$HOME/account-research-backups}"
KEEP_DAYS="${BRIEF_BACKUP_KEEP_DAYS:-14}"

mkdir -p "$DEST_DIR"

if [[ ! -f "$SRC" ]]; then
  echo "[backup-briefs] source not found: $SRC" >&2
  exit 0
fi

ts="$(date -u +%Y%m%dT%H%M%SZ)"
out="$DEST_DIR/briefs-$ts.sqlite"

sqlite3 "$SRC" ".backup '$out'"
gzip -9 "$out"

echo "[backup-briefs] wrote $out.gz ($(du -h "$out.gz" | cut -f1))"

find "$DEST_DIR" -maxdepth 1 -name 'briefs-*.sqlite.gz' -mtime "+$KEEP_DAYS" -delete
