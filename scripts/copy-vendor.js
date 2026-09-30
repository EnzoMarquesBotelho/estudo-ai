#!/usr/bin/env node
'use strict';

/**
 * Copia bibliotecas de terceiros (vendor) para dentro de src/renderer/vendor,
 * para poderem ser carregadas pela interface respeitando o CSP (script-src 'self').
 * Hoje: mermaid (diagramas nos exercícios).
 *
 * Roda no postinstall e antes de cada build.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const vendorDir = path.join(root, 'src', 'renderer', 'vendor');

fs.mkdirSync(vendorDir, { recursive: true });

// Possíveis caminhos do bundle standalone do mermaid.
const candidatos = [
  'node_modules/mermaid/dist/mermaid.min.js',
  'node_modules/mermaid/dist/mermaid.js',
];

let copiado = false;
for (const rel of candidatos) {
  const src = path.join(root, rel);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(vendorDir, 'mermaid.min.js'));
    console.log('[copy-vendor] mermaid copiado de', rel);
    copiado = true;
    break;
  }
}

if (!copiado) {
  // Não falha o build: apenas avisa. O app trata a ausência com fallback.
  console.warn('[copy-vendor] mermaid não encontrado em node_modules — os diagramas cairão no fallback de texto. Rode "npm install".');
  // Cria um stub vazio para o <script> não quebrar.
  const stub = path.join(vendorDir, 'mermaid.min.js');
  if (!fs.existsSync(stub)) fs.writeFileSync(stub, '/* mermaid ausente: rode npm install */', 'utf-8');
}
