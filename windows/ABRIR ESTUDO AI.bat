@echo off
chcp 65001 >nul
title Estudo AI
cd /d "%~dp0.."

REM Verifica se as dependencias ja foram instaladas.
if not exist "node_modules" (
    echo [!] As dependencias ainda nao foram instaladas.
    echo     Rode primeiro o "INSTALAR.bat".
    echo.
    pause
    exit /b 1
)

REM Avisa se o Ollama nao estiver rodando (IA local).
where ollama >nul 2>nul
if %errorlevel% equ 0 (
    tasklist /fi "imagename eq ollama.exe" | find /i "ollama.exe" >nul
    if errorlevel 1 (
        echo Iniciando o Ollama em segundo plano...
        start "" ollama serve
        timeout /t 2 >nul
    )
) else (
    echo [aviso] Ollama nao encontrado. O app abre, mas a IA ficara offline
    echo         ate voce instalar o Ollama ^(https://ollama.com^).
    echo.
)

echo Abrindo o Estudo AI...
call npm start
