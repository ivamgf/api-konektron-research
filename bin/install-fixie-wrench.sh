#!/usr/bin/env bash
# bin/install-fixie-wrench.sh — baixa o fixie-wrench no build do Heroku (heroku-postbuild).
# O binário não vai para o repositório (.gitignore); fica no slug em bin/fixie-wrench,
# que é o caminho usado pelo bin/db-connect.sh.
#
# Não usamos o install.sh oficial porque ele pergunta "Add to Git?" (não há terminal no build),
# baixa os binários de todas as plataformas e não marca o binário real como executável.
#
# Atualizar a versão: troque FIXIE_WRENCH_VERSION e FIXIE_WRENCH_SHA256
# (sha256sum do fixie-wrench-linux-amd64 da release em github.com/usefixie/fixie-wrench).
set -euo pipefail

VERSAO="${FIXIE_WRENCH_VERSION:-v1.0.0}"
SHA256="${FIXIE_WRENCH_SHA256:-067fc79f8bc1823d20ae3abcf2cec5334ca105f2581a7ffe61d247139eada060}"
DESTINO="${1:-bin/fixie-wrench}"

if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
  echo "fixie-wrench: $(uname -s)/$(uname -m) não é o ambiente do Heroku; instalação ignorada."
  exit 0
fi

if [ -x "$DESTINO" ] && echo "$SHA256  $DESTINO" | sha256sum -c --status - 2>/dev/null; then
  echo "fixie-wrench $VERSAO já instalado em $DESTINO"
  exit 0
fi

URL="https://github.com/usefixie/fixie-wrench/releases/download/${VERSAO}/fixie-wrench-linux-amd64"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

echo "Baixando fixie-wrench $VERSAO..."
curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 15 -o "$TMP" "$URL"

if ! echo "$SHA256  $TMP" | sha256sum -c --status -; then
  echo "fixie-wrench: SHA-256 não confere (esperado $SHA256, obtido $(sha256sum "$TMP" | cut -d' ' -f1))." >&2
  echo "Se a versão mudou de propósito, atualize FIXIE_WRENCH_SHA256." >&2
  exit 1
fi

mkdir -p "$(dirname "$DESTINO")"
install -m 0755 "$TMP" "$DESTINO"
echo "fixie-wrench $VERSAO instalado em $DESTINO"
