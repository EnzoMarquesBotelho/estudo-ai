@echo off
chcp 65001 >nul
title Estudo AI - Instalacao
cd /d "%~dp0.."

echo ============================================
echo        ESTUDO AI - Preparando o ambiente
echo ============================================
echo.

REM --- 1. Verifica Node.js ---
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [!] Node.js NAO encontrado.
    echo.
    echo     Baixe e instale a versao LTS em:
    echo     https://nodejs.org
    echo.
    echo     Depois de instalar, feche esta janela e rode o INSTALAR.bat de novo.
    echo.
    pause
    exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo [ok] Node.js %%v encontrado.

REM --- 2. Verifica Ollama (a IA local) ---
where ollama >nul 2>nul
if %errorlevel% neq 0 (
    echo.
    echo [!] Ollama NAO encontrado. Ele e a IA local que gera os resumos.
    echo     Baixe e instale em: https://ollama.com
    echo     ^(Voce pode continuar a instalacao do app e instalar o Ollama depois.^)
    echo.
) else (
    echo [ok] Ollama encontrado.
    echo.
    echo     Baixando o modelo de IA ^(llama3.1^). Isso pode demorar e baixar alguns GB...
    ollama pull llama3.1
)

REM --- 3. Instala dependencias do app ---
echo.
echo Instalando dependencias do app ^(npm install^)...
call npm install
if %errorlevel% neq 0 (
    echo.
    echo [!] Falha no npm install. Verifique sua conexao e tente de novo.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Tudo pronto! Agora use "ABRIR ESTUDO AI.bat"
echo ============================================
echo.
pause
