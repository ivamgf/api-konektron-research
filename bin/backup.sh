#!/usr/bin/env bash
# bin/backup.sh — dump diário do MySQL para o Google Cloud Storage (RNF09).
# Heroku Scheduler (06:00 UTC): bash bin/db-connect.sh bash bin/backup.sh
set -euo pipefail

ARQ="/tmp/${DB_NAME}-$(date -u +%Y%m%d-%H%M%S).sql.gz"
mysqldump --host="${DB_HOST}" --port="${DB_PORT:-3306}" \
  --user="${DB_MIGRATION_USER:-$DB_USER}" --password="${DB_MIGRATION_PASSWORD:-$DB_PASSWORD}" \
  --single-transaction --routines --triggers --default-character-set=utf8mb4 \
  --set-gtid-purged=OFF --column-statistics=0 --no-tablespaces \
  "${DB_NAME}" | gzip > "$ARQ"

node scripts/upload-backup.js "$ARQ"
rm -f "$ARQ"
