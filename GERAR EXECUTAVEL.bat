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

echo Gerando o INSTALADOR e a versao PORTATIL para Windows...
echo ^(o resultado vai para a pasta "dist"^)
echo.
call npm run build:win
if %errorlevel% neq 0 (
    echo.
    echo [!] Falha ao gerar o executavel. Veja a mensagem acima.
    echo.
    echo     Causa comum no Windows 11: o "Controle de Aplicativo Inteligente"
    echo     ^(Smart App Control^) bloqueia ferramentas que o empacotador baixa.
    echo     Se foi o caso, voce pode:
    echo       1^) Rodar o app sem gerar .exe, usando "ABRIR ESTUDO AI.bat"; ou
    echo       2^) Gerar so a versao PORTATIL com "GERAR PORTATIL.bat"; ou
    echo       3^) Ajustar o Smart App Control em Configuracoes ^> Privacidade e
    echo          seguranca ^> Seguranca do Windows ^> Controle de aplicativo.
    echo.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Pronto! Os arquivos estao na pasta "dist".
echo   - Instalador:  "Estudo AI Setup ...exe"
echo   - Portatil:    "Estudo AI ...portable.exe"
echo.
echo   Para passar a amigos: o PORTATIL e o mais simples
echo   ^(um arquivo so, nao precisa instalar^).
echo ============================================
echo.
explorer "%~dp0dist"
pause
