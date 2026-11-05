#!/usr/bin/env bash
# bin/db-connect.sh — no Heroku, encaminha 127.0.0.1:3306 até o MySQL da hospedagem
# pelo Fixie Socks (IPs fixos liberados no cPanel) e executa "$@" (ERS 11.3).
# Sem FIXIE_SOCKS_HOST (desenvolvimento local) apenas executa o comando.
set -euo pipefail

if [ -z "${FIXIE_SOCKS_HOST:-}" ]; then
  exec "$@"
fi

: "${DB_REMOTE_HOST:?defina DB_REMOTE_HOST com o IP ou domínio do servidor MySQL}"

if [ ! -x ./bin/fixie-wrench ]; then
  echo "bin/fixie-wrench ausente ou sem permissão de execução: rode bash bin/install-fixie-wrench.sh" >&2
  exit 1
fi

./bin/fixie-wrench "${DB_PORT:-3306}:${DB_REMOTE_HOST}:${DB_REMOTE_PORT:-3306}" &
WRENCH_PID=$!

for _ in $(seq 1 40); do
  (echo > "/dev/tcp/127.0.0.1/${DB_PORT:-3306}") 2>/dev/null && break
  sleep 0.5
done

"$@" &
APP_PID=$!
trap 'kill -TERM "$APP_PID" 2>/dev/null; wait "$APP_PID"; kill "$WRENCH_PID" 2>/dev/null; exit 0' TERM INT
wait -n "$WRENCH_PID" "$APP_PID"
STATUS=$?
kill "$WRENCH_PID" "$APP_PID" 2>/dev/null || true
exit "$STATUS"
