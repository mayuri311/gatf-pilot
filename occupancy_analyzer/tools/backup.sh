#!/usr/bin/env bash
#
# Nightly logical backup (Supabase Free has no backups — plan doc 12 §4).
#
#   DATABASE_URL=postgresql://...  ./tools/backup.sh [out_dir]
#
# Writes <out_dir>/oa-YYYYmmddTHHMMSSZ.sql.gz and prunes dumps older than
# BACKUP_KEEP_DAYS (default 14). Optionally encrypts with `age` when
# BACKUP_AGE_RECIPIENT is set. Used by .github/workflows/oa-nightly.yml and
# safe to run by hand.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
OUT_DIR="${1:-backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT_DIR"

FILE="$OUT_DIR/oa-$STAMP.sql.gz"
# public = our data; storage objects (crops) are short-lived and not backed up.
pg_dump "$DATABASE_URL" --no-owner --no-privileges --schema=public --schema=private \
  | gzip -9 > "$FILE"

if [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]]; then
  age -r "$BACKUP_AGE_RECIPIENT" -o "$FILE.age" "$FILE" && rm -f "$FILE"
  FILE="$FILE.age"
fi

find "$OUT_DIR" -name 'oa-*.sql.gz*' -mtime +"$KEEP_DAYS" -delete
echo "backup written: $FILE ($(du -h "$FILE" | cut -f1))"
