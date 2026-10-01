#!/usr/bin/env bash
# Instalação do Estudo AI para macOS e Linux.
# Uso: abra um terminal nesta pasta e rode:  bash INSTALAR.sh
set -e
cd "$(dirname "$0")/.."

echo "============================================"
echo "       ESTUDO AI - Preparando o ambiente"
echo "============================================"
echo

# --- 1. Node.js ---
if ! command -v node >/dev/null 2>&1; then
  echo "[!] Node.js NAO encontrado."
  echo "    Instale a versao LTS em: https://nodejs.org"
  echo "    (No Linux, tambem pode usar o gerenciador de pacotes da sua distro.)"
  echo "    Depois rode o INSTALAR.sh de novo."
  exit 1
fi
echo "[ok] Node.js $(node -v) encontrado."

# --- 2. Ollama (IA local) ---
if ! command -v ollama >/dev/null 2>&1; then
  echo
  echo "[!] Ollama NAO encontrado (a IA local que gera os resumos)."
  case "$(uname -s)" in
    Linux)
      echo "    Instalando o Ollama pelo script oficial..."
      curl -fsSL https://ollama.com/install.sh | sh || \
        echo "    [!] Falha ao instalar. Rode manualmente: curl -fsSL https://ollama.com/install.sh | sh"
      ;;
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        echo "    Instalando via Homebrew..."
        brew install ollama || echo "    [!] Falha. Baixe manualmente em https://ollama.com/download"
      else
        echo "    Baixe o Ollama em https://ollama.com/download, arraste para Aplicativos e abra uma vez."
      fi
      ;;
  esac
else
  echo "[ok] Ollama encontrado."
fi

# Baixa o modelo recomendado, se o ollama estiver disponivel.
if command -v ollama >/dev/null 2>&1; then
  echo
  echo "    Baixando o modelo de IA (qwen2.5:7b). Pode demorar e baixar alguns GB..."
  ollama pull qwen2.5:7b || echo "    [!] Nao consegui baixar agora; o app tentara depois."
fi

# --- 3. Dependencias do app ---
echo
echo "Instalando dependencias do app (npm install)..."
npm install

echo
echo "============================================"
echo "  Tudo pronto! Agora rode:  bash ABRIR.sh"
echo "============================================"
