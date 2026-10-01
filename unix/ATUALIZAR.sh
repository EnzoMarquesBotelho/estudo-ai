#!/usr/bin/env bash
# Estudo AI - Atualizador local (macOS / Linux)
# Verifica o GitHub e, se houver atualizacao, aplica com git pull + npm install.
set -e
cd "$(dirname "$0")/.."

echo "============================================"
echo "       ESTUDO AI - Verificando atualizacoes"
echo "============================================"
echo

REPO_URL="https://github.com/EnzoMarquesBotelho/estudo-ai"

# 1. Precisa do Git.
if ! command -v git >/dev/null 2>&1; then
  echo "[!] Git nao encontrado. Ele e necessario para atualizar o app."
  echo "    Instale com o gerenciador do seu sistema (ex.: brew install git,"
  echo "    sudo apt install git) e rode este arquivo de novo."
  echo
  echo "    Alternativa: baixe a versao mais recente em: $REPO_URL"
  exit 1
fi

# 2. Confirma que e um repositorio git.
if [ ! -d ".git" ]; then
  echo "[!] Esta pasta nao e um repositorio git (.git ausente)."
  echo "    A atualizacao automatica so funciona na versao instalada via Git."
  echo "    Baixe a versao mais recente em: $REPO_URL"
  exit 1
fi

# 3. Busca novidades.
echo "Buscando novidades no GitHub..."
if ! git fetch --quiet; then
  echo "[!] Nao consegui falar com o GitHub. Verifique sua conexao."
  exit 1
fi

# 4. Compara local x remoto.
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH" 2>/dev/null || true)"

if [ -z "$REMOTE" ]; then
  echo "[!] Nao achei a branch remota origin/$BRANCH."
  exit 1
fi

if [ "$LOCAL" = "$REMOTE" ]; then
  echo
  echo "[ok] Voce ja esta na versao mais recente. Nada a atualizar."
  exit 0
fi

# 5. Protege alteracoes locais.
STASHED=0
if ! git diff --quiet; then
  echo
  echo "[aviso] Ha alteracoes locais nao salvas. Guardando temporariamente (git stash)..."
  git stash push -u -m "estudo-ai-auto-update" >/dev/null 2>&1 || true
  STASHED=1
fi

# 6. Guarda o estado do lockfile antes do pull.
lock_antes=""
[ -f package-lock.json ] && lock_antes="$(cksum package-lock.json)"

# 7. Aplica a atualizacao.
echo
echo "Atualizando o app (git pull)..."
if ! git pull --ff-only; then
  echo
  echo "[!] Falha ao atualizar. Pode haver conflito com alteracoes locais."
  [ "$STASHED" = "1" ] && git stash pop >/dev/null 2>&1 || true
  exit 1
fi

# 8. Reinstala dependencias SO SE o package-lock.json mudou.
lock_depois=""
[ -f package-lock.json ] && lock_depois="$(cksum package-lock.json)"

if [ "$lock_antes" != "$lock_depois" ]; then
  echo
  echo "As dependencias mudaram. Atualizando (npm install)..."
  if ! npm install --no-audit --no-fund; then
    echo "[!] Falha no npm install. Verifique sua conexao e tente de novo."
    exit 1
  fi
else
  echo "Dependencias sem mudancas; nao precisa reinstalar."
fi

echo
echo "============================================"
echo "  Atualizado com sucesso!"
echo "  Abra o app com: bash ABRIR.sh"
echo "============================================"
