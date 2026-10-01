@echo off
chcp 65001 >nul
title Estudo AI - Atualizar
cd /d "%~dp0"

echo ============================================
echo        ESTUDO AI - Verificando atualizacoes
echo ============================================
echo.

REM --- 1. Precisa do Git para atualizar localmente ---
where git >nul 2>nul
if %errorlevel% neq 0 (
    echo [!] Git NAO encontrado. Ele e necessario para atualizar o app.
    echo     Baixe e instale em: https://git-scm.com/download/win
    echo     Depois rode este arquivo de novo.
    echo.
    echo     Alternativa: baixe a versao mais recente em
    echo     https://github.com/EnzoMarquesBotelho/estudo-ai
    echo.
    pause
    exit /b 1
)

REM --- 2. Confirma que esta pasta e um repositorio git ---
if not exist ".git" (
    echo [!] Esta pasta nao e um repositorio git ^(.git ausente^).
    echo     A atualizacao automatica so funciona na versao instalada via Git.
    echo     Baixe a versao mais recente em:
    echo     https://github.com/EnzoMarquesBotelho/estudo-ai
    echo.
    pause
    exit /b 1
)

REM --- 3. Busca as novidades do GitHub ---
echo Buscando novidades no GitHub...
git fetch --quiet
if %errorlevel% neq 0 (
    echo [!] Nao consegui falar com o GitHub. Verifique sua conexao.
    pause
    exit /b 1
)

REM --- 4. Descobre a branch atual e compara com o remoto ---
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set BRANCH=%%b
for /f "delims=" %%l in ('git rev-parse HEAD') do set LOCAL=%%l
for /f "delims=" %%r in ('git rev-parse origin/%BRANCH% 2^>nul') do set REMOTE=%%r

if "%REMOTE%"=="" (
    echo [!] Nao achei a branch remota origin/%BRANCH%.
    pause
    exit /b 1
)

if "%LOCAL%"=="%REMOTE%" (
    echo.
    echo [ok] Voce ja esta na versao mais recente. Nada a atualizar.
    echo.
    pause
    exit /b 0
)

REM --- 5. Protege alteracoes locais nao salvas ---
git diff --quiet
if %errorlevel% neq 0 (
    echo.
    echo [aviso] Ha alteracoes locais nao salvas nesta pasta.
    echo         Elas serao guardadas temporariamente ^(git stash^) antes de atualizar.
    git stash push -u -m "estudo-ai-auto-update" >nul 2>nul
    set STASHED=1
)

REM --- 6. Aplica a atualizacao ---
echo.
echo Atualizando o app ^(git pull^)...
git pull --ff-only
if %errorlevel% neq 0 (
    echo.
    echo [!] Falha ao atualizar. Pode haver conflito com alteracoes locais.
    if defined STASHED git stash pop >nul 2>nul
    pause
    exit /b 1
)

REM --- 7. Reinstala dependencias se o package.json mudou ---
echo.
echo Atualizando dependencias ^(npm install^)...
call npm install
if %errorlevel% neq 0 (
    echo [!] Falha no npm install. Verifique sua conexao e tente de novo.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Atualizado com sucesso!
echo   Abra o app com "ABRIR ESTUDO AI.bat".
echo ============================================
echo.
pause
