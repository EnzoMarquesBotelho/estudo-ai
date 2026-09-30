#!/usr/bin/env bash
# Abre o Estudo AI em macOS e Linux.
# Uso: bash ABRIR.sh
set -e
cd "$(dirname "$0")"

if [ ! -d "node_modules" ]; then
  echo "[!] As dependencias ainda nao foram instaladas."
  echo "    Rode primeiro:  bash INSTALAR.sh"
  exit 1
fi

# Garante que o Ollama esteja rodando (IA local).
if command -v ollama >/dev/null 2>&1; then
  if ! curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    echo "Iniciando o Ollama em segundo plano..."
    (ollama serve >/dev/null 2>&1 &)
    sleep 2
  fi
else
  echo "[aviso] Ollama nao encontrado. O app abre, mas a IA fica offline"
  echo "        ate voce instalar o Ollama (https://ollama.com/download)."
fi

echo "Abrindo o Estudo AI..."
npm start
