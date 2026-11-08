#!/usr/bin/env bash
# bin/db-connect.sh — no Heroku, encaminha 127.0.0.1:3306 até o MySQL da hospedagem
# pelo Fixie Socks (IPs fixos liberados no cPanel) e executa "$@" (ERS 11.3).
# Fora do Heroku (sem a variável DYNO) e sem FIXIE_SOCKS_HOST apenas executa o comando.
# Com DB_HOST remoto (não 127.0.0.1/localhost) conecta direto, sem túnel (cPanel liberando o host %).
set -euo pipefail

PORTA="${DB_PORT:-3306}"
log() { echo "db-connect: $*" >&2; }

if [ -z "${FIXIE_SOCKS_HOST:-}" ]; then
  # No Heroku com DB_HOST local, sem o túnel ninguém escuta em 127.0.0.1 (ECONNREFUSED)
  if [ -n "${DYNO:-}" ] && [[ "${DB_HOST:-}" =~ ^(127\.0\.0\.1|localhost)$ ]]; then
    log "FIXIE_SOCKS_HOST não definida, mas DB_HOST=${DB_HOST} depende do túnel do fixie-wrench."
    log "Instale o add-on (heroku addons:create fixie-socks) ou aponte DB_HOST direto para o servidor MySQL."
    exit 1
  fi
  exec "$@"
fi

if [[ ! "${DB_HOST:-}" =~ ^(127\.0\.0\.1|localhost)$ ]]; then
  # Conexão direta: não abre o túnel nem gasta a cota do Fixie. Para voltar ao túnel, DB_HOST=127.0.0.1.
  log "DB_HOST=${DB_HOST:-} é remoto: conectando direto, sem o túnel do Fixie."
  exec "$@"
fi

: "${DB_REMOTE_HOST:?defina DB_REMOTE_HOST com o IP ou domínio do servidor MySQL}"

if [ ! -x ./bin/fixie-wrench ]; then
  log "bin/fixie-wrench ausente ou sem permissão de execução: rode bash bin/install-fixie-wrench.sh"
  exit 1
fi

log "abrindo túnel 127.0.0.1:${PORTA} -> ${DB_REMOTE_HOST}:${DB_REMOTE_PORT:-3306} via Fixie Socks"
./bin/fixie-wrench "${PORTA}:${DB_REMOTE_HOST}:${DB_REMOTE_PORT:-3306}" &
WRENCH_PID=$!

PRONTO=
for _ in $(seq 1 "${DB_CONNECT_TIMEOUT:-60}"); do
  if ! kill -0 "$WRENCH_PID" 2>/dev/null; then
    wait "$WRENCH_PID" || true
    log "o fixie-wrench encerrou antes de abrir o túnel (confira FIXIE_SOCKS_HOST)."
    exit 1
  fi
  if (echo > "/dev/tcp/127.0.0.1/${PORTA}") 2>/dev/null; then
    PRONTO=1
    break
  fi
  sleep 0.5
done
if [ -z "$PRONTO" ]; then
  log "o túnel não respondeu em 127.0.0.1:${PORTA}."
  kill "$WRENCH_PID" 2>/dev/null || true
  exit 1
fi
log "túnel pronto"

"$@" &
APP_PID=$!
trap 'kill -TERM "$APP_PID" 2>/dev/null; wait "$APP_PID"; kill "$WRENCH_PID" 2>/dev/null; exit 0' TERM INT
STATUS=0
wait -n "$WRENCH_PID" "$APP_PID" || STATUS=$?
kill "$WRENCH_PID" "$APP_PID" 2>/dev/null || true
exit "$STATUS"
