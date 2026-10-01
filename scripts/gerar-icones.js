'use strict';

/**
 * Gera os ícones do app a partir de src/renderer/assets/icon.svg.
 *
 * Saídas (em src/renderer/assets/):
 *   - icon.png   (1024x1024, usado pelo Linux e como base)
 *   - icon.ico   (Windows)
 *   - icon.icns  (macOS)
 *
 * Uso:  node scripts/gerar-icones.js
 * Requer as devDependencies: sharp, png2icons.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const png2icons = require('png2icons');

const ASSETS = path.join(__dirname, '..', 'src', 'renderer', 'assets');
const SVG = path.join(ASSETS, 'icon.svg');
const PNG = path.join(ASSETS, 'icon.png');
const ICO = path.join(ASSETS, 'icon.ico');
const ICNS = path.join(ASSETS, 'icon.icns');

async function main() {
  if (!fs.existsSync(SVG)) {
    console.error('[!] Não encontrei o SVG base em', SVG);
    process.exit(1);
  }

  // 1) SVG -> PNG 1024x1024 (base de alta resolução).
  const svg = fs.readFileSync(SVG);
  await sharp(svg, { density: 384 })
    .resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(PNG);
  console.log('[ok] icon.png (1024x1024)');

  const pngBuf = fs.readFileSync(PNG);

  // 2) PNG -> ICO (Windows). BILINEAR é um bom equilíbrio de qualidade.
  const ico = png2icons.createICO(pngBuf, png2icons.BILINEAR, 0, false);
  if (!ico) throw new Error('Falha ao gerar o .ico');
  fs.writeFileSync(ICO, ico);
  console.log('[ok] icon.ico');

  // 3) PNG -> ICNS (macOS).
  const icns = png2icons.createICNS(pngBuf, png2icons.BILINEAR, 0);
  if (!icns) throw new Error('Falha ao gerar o .icns');
  fs.writeFileSync(ICNS, icns);
  console.log('[ok] icon.icns');

  console.log('\nÍcones gerados em', ASSETS);
}

main().catch((e) => {
  console.error('[!] Erro ao gerar ícones:', e.message);
  process.exit(1);
});
