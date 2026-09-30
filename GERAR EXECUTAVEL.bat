@echo off
chcp 65001 >nul
title Estudo AI - Gerar executavel
cd /d "%~dp0"

echo ============================================
echo    ESTUDO AI - Gerando o executavel (.exe)
echo ============================================
echo.

if not exist "node_modules" (
    echo [!] Rode o "INSTALAR.bat" primeiro.
    pause
    exit /b 1
)

echo Gerando instalador e versao portatil...
echo ^(o resultado vai para a pasta "dist"^)
echo.
call npm run build
if %errorlevel% neq 0 (
    echo.
    echo [!] Falha ao gerar o executavel. Veja a mensagem acima.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Pronto! Os arquivos estao na pasta "dist".
echo   - Instalador:  "Estudo AI Setup ...exe"
echo   - Portatil:    "Estudo AI ...portable.exe"
echo ============================================
echo.
explorer "%~dp0dist"
pause
