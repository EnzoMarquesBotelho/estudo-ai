@echo off
chcp 65001 >nul
title CabulIA - Gerar versao portatil
cd /d "%~dp0.."

echo ============================================
echo    CABULIA - Gerando SO a versao PORTATIL
echo ============================================
echo.
echo A versao portatil e um unico .exe que NAO precisa ser instalado.
echo E a forma mais simples de passar o app para outras pessoas.
echo.

if not exist "node_modules" (
    echo [!] Rode o "INSTALAR.bat" primeiro.
    pause
    exit /b 1
)

echo Gerando o portatil ^(resultado na pasta "dist"^)...
echo.
call npm run build:portable
if %errorlevel% neq 0 (
    echo.
    echo [!] Falha ao gerar. Veja a mensagem acima.
    echo     Se o "Controle de Aplicativo Inteligente" bloqueou algo, use o app
    echo     direto com "ABRIR ESTUDO AI.bat" ou ajuste o Smart App Control nas
    echo     Configuracoes de Seguranca do Windows.
    echo.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Pronto! O portatil esta na pasta "dist":
echo   "CabulIA ...portable.exe"
echo ============================================
echo.
explorer "%~dp0..\dist"
pause
