# =====================================================================
#  Publicar uma nova versao do Estudo AI (com auto-update via GitHub)
# ---------------------------------------------------------------------
#  COMO USAR (no PowerShell, dentro de C:\dev\estudo-ai):
#
#    1. Defina o token SO NESTE terminal (ele NAO fica salvo em lugar nenhum):
#         $env:GH_TOKEN = "seu_token_do_github"
#
#    2. Rode este script:
#         .\publicar-release.ps1                # sobe a versao "patch" (1.0.1 -> 1.0.2)
#         .\publicar-release.ps1 -Tipo minor    # 1.0.1 -> 1.1.0
#         .\publicar-release.ps1 -Tipo major    # 1.0.1 -> 2.0.0
#         .\publicar-release.ps1 -SemVersion    # nao mexe na versao, so publica a atual
#
#  IMPORTANTE (seguranca): nunca escreva o token dentro deste arquivo,
#  nunca tire print mostrando o token, nunca cole o token em chat.
# =====================================================================

param(
  [ValidateSet('patch', 'minor', 'major')]
  [string]$Tipo = 'patch',
  [switch]$SemVersion
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Falhar($msg) { Write-Host "`n[ERRO] $msg" -ForegroundColor Red; exit 1 }
function Info($msg)   { Write-Host "[..] $msg" -ForegroundColor Cyan }
function Ok($msg)     { Write-Host "[ok] $msg" -ForegroundColor Green }

# 1. Verifica o token (sem exibi-lo).
if (-not $env:GH_TOKEN -or $env:GH_TOKEN.Trim() -eq '') {
  Falhar "GH_TOKEN nao definido. Rode antes:  `$env:GH_TOKEN = ""seu_token""  (o token nao deve ser colado em chat nem em arquivo)."
}
Ok "Token encontrado na variavel de ambiente (valor nao exibido)."

# 2. Verifica Node/npm.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Falhar "Node.js nao encontrado no PATH." }

# 3. Garante dependencias instaladas.
if (-not (Test-Path "node_modules")) {
  Info "Instalando dependencias (npm install)..."
  npm install
  if ($LASTEXITCODE -ne 0) { Falhar "npm install falhou." }
}

# 4. Copia o vendor (mermaid) para o renderer.
Info "Preparando arquivos (copy-vendor)..."
npm run copy:vendor
if ($LASTEXITCODE -ne 0) { Falhar "copy-vendor falhou." }

# 5. Sobe a versao, se pedido. Requer arvore git limpa.
if (-not $SemVersion) {
  $sujo = git status --porcelain
  if ($sujo) {
    Write-Host "`n[aviso] Ha alteracoes nao commitadas:" -ForegroundColor Yellow
    git status --short
    Falhar "Faca commit/push (ou use o GitHub Desktop) antes de subir a versao, ou rode com -SemVersion para publicar sem alterar a versao."
  }
  Info "Subindo versao ($Tipo)..."
  npm version $Tipo
  if ($LASTEXITCODE -ne 0) { Falhar "npm version falhou." }
  Ok "Versao atualizada. Lembre de dar PUSH das tags/commit depois (GitHub Desktop ou 'git push --follow-tags')."
}

$versao = (Get-Content package.json -Raw | ConvertFrom-Json).version
Info "Gerando e publicando a versao $versao no GitHub Releases..."

# 6. Build + publish. O electron-builder usa GH_TOKEN automaticamente.
npx electron-builder --win --publish always
if ($LASTEXITCODE -ne 0) {
  Falhar "O build/publish falhou. Erros comuns:
   - 'winCodeSign / symbolic link': rode o PowerShell como Administrador OU ative o Modo de Desenvolvedor do Windows.
   - '401/403': o token nao tem permissao 'repo'/'contents:write' ou expirou. Gere um novo.
   - arquivo travado: feche o app se estiver aberto e tente de novo."
}

Ok "Publicado! Versao $versao esta no GitHub Releases."
Write-Host "Os apps ja instalados vao detectar e baixar a atualizacao automaticamente." -ForegroundColor Green
Write-Host "Confira em: https://github.com/EnzoMarquesBotelho/estudo-ai/releases" -ForegroundColor Green
