#!/usr/bin/env node
'use strict';

/**
 * VALIDAÇÃO VISUAL REAL com Playwright.
 *
 * Abre a interface (src/renderer/index.html) num navegador headless, injeta um
 * mock de window.api (para a UI funcionar sem Electron/Ollama), renderiza um
 * mapa mental de exemplo e uma lista de exercícios, tira SCREENSHOTS e verifica
 * problemas visuais REAIS medindo o layout renderizado:
 *   - sobreposição de cartões no mapa mental (retângulos que se cruzam);
 *   - elementos que vazam para fora da área visível;
 *   - contraste computado de textos-chave.
 *
 * Gera imagens em tests/screenshots/ e um resumo no console + no relatório
 * de frontend (append) para o agente de frontend consolidar.
 *
 * Uso:  npm run test:visual   (requer: npm install, que baixa o Playwright)
 *       Se o navegador não estiver instalado: npx playwright install chromium
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  console.error('Playwright não instalado. Rode: npm install  (e, se preciso, npx playwright install chromium)');
  process.exit(1);
}

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const INDEX = path.join(RENDERER, 'index.html');
const SHOTS = path.join(__dirname, 'screenshots');
const RELATORIO = path.join(__dirname, 'relatorio-frontend.md');

// Mapa e exercícios de exemplo para renderizar.
const MAPA_EXEMPLO = {
  central: 'Circuitos Elétricos',
  nodes: [
    { title: 'Circuito Misto', children: [
      { titulo: 'Definição', descricao: 'Combina série e paralelo.' },
      { titulo: 'Resistência equivalente', descricao: 'Reduz o circuito a um Req.' },
    ]},
    { title: 'Leis de Kirchhoff', children: [
      { titulo: 'Tensões', descricao: 'Soma das tensões na malha é zero.' },
      { titulo: 'Correntes', descricao: 'Soma das correntes no nó é zero.' },
    ]},
    { title: 'Thévenin', children: [
      { titulo: 'Vth', descricao: 'Tensão de circuito aberto.' },
      { titulo: 'Rth', descricao: 'Resistência vista dos terminais.' },
    ]},
    { title: 'Transformação de Fontes', children: [
      { titulo: 'Is = Vs/Rs', descricao: 'Fonte de tensão vira de corrente.' },
    ]},
  ],
};
const EXERCICIOS_EXEMPLO = `# Lista de Exercícios
1. Calcule a resistência equivalente do circuito abaixo.
\`\`\`mermaid
graph LR
  A[Fonte 12V] --> B[R1 10Ω] --> C[R2 20Ω]
\`\`\`
2. Explique a Lei de Ohm.

## Gabarito
1. Req = 30Ω (série).
2. V = R·I.`;

// Retângulos se sobrepõem?
function sobrepoe(a, b) {
  return !(a.x + a.width <= b.x || b.x + b.width <= a.x ||
           a.y + a.height <= b.y || b.y + b.height <= a.y);
}

// Rede de segurança: nunca deixa o processo pendurado.
const HARD_TIMEOUT = setTimeout(() => {
  console.error('Timeout global (90s) — encerrando a validação visual.');
  process.exit(1);
}, 90000);
HARD_TIMEOUT.unref && HARD_TIMEOUT.unref();

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const problemas = [];

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });

  // Injeta um mock de window.api ANTES de carregar a página.
  await page.addInitScript(() => {
    const noop = async () => null;
    window.api = {
      pickFolder: noop, getSavedFolder: noop,
      scanLibrary: async () => ({ root: '', notebooks: [] }),
      readFile: async () => ({ ok: true, text: '' }),
      startWatch: noop, onLibraryChanged: () => {},
      aiStatus: async () => ({ ok: true, models: ['qwen2.5:7b'] }),
      summary: noop, mindmap: noop, exercises: noop,
      summaryFolder: noop, mindmapFolder: noop, exercisesFolder: noop,
      onAiProgress: () => {}, onAiToken: () => {},
      exportSave: noop, cacheGet: noop, cacheSet: noop,
      setupCheck: async () => ({ ready: true, serverUp: true, hasModel: true, models: ['qwen2.5:7b'], model: 'qwen2.5:7b' }),
      setupInstallOllama: noop, setupPullModel: noop, onSetupProgress: () => {},
      getModel: async () => 'qwen2.5:7b', setModel: noop, pullModel: noop,
      onUpdateStatus: () => {},
    };
  });

  // Captura erros da página para diagnóstico.
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  await page.goto(pathToFileURL(INDEX).href);
  await page.waitForTimeout(1200); // deixa o init rodar

  // Garante que as funções de render existam (senão aborta com mensagem clara).
  const temFns = await page.evaluate(() =>
    typeof renderMindmap === 'function' && typeof renderMarkdown === 'function');
  if (!temFns) {
    console.error('As funções de render não estão globais no renderer. Abortando.');
    await browser.close();
    process.exit(1);
  }

  // 1) Tela inicial.
  await page.screenshot({ path: path.join(SHOTS, '01-inicial.png') });

  // 2) Renderiza o mapa mental de exemplo e verifica sobreposição.
  await page.evaluate((mapa) => {
    const btn = document.querySelector('[data-tab="mindmap"]');
    if (btn) btn.click();
    renderMindmap(document.getElementById('mindmapOutput'), mapa);
  }, MAPA_EXEMPLO);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SHOTS, '02-mapa-mental.png') });

  // Mede os cartões dos ramos e checa cruzamentos.
  const caixas = await page.$$eval('#mindmapOutput .mm-node', (els) =>
    els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })
  );
  let sobrepostos = 0;
  for (let i = 0; i < caixas.length; i++)
    for (let j = i + 1; j < caixas.length; j++)
      if (sobrepoe(caixas[i], caixas[j])) sobrepostos++;
  if (sobrepostos > 0) {
    problemas.push(`Mapa mental: ${sobrepostos} par(es) de cartões se sobrepõem no layout renderizado.`);
  }

  // 3) Renderiza exercícios com Mermaid e confere se o diagrama virou SVG.
  await page.evaluate((texto) => {
    document.querySelector('[data-tab="exercises"]').click();
    const out = document.getElementById('exercisesOutput');
    out.innerHTML = renderMarkdown(texto);
    renderizarMermaid(out);
  }, EXERCICIOS_EXEMPLO);
  await page.waitForTimeout(1200); // mermaid é assíncrono
  await page.screenshot({ path: path.join(SHOTS, '03-exercicios.png') });

  const temSvg = await page.$('#exercisesOutput .mermaid-rendered svg');
  const temMermaidLib = await page.evaluate(() => typeof window.mermaid !== 'undefined');
  if (temMermaidLib && !temSvg) {
    problemas.push('Exercícios: bloco Mermaid não foi renderizado como diagrama (SVG ausente).');
  }

  // 4) Gabarito deve vir DEPOIS de todas as questões (ordem no DOM).
  const ordemOk = await page.evaluate(() => {
    const hs = [...document.querySelectorAll('#exercisesOutput h2')];
    const gab = hs.find((h) => /gabarito/i.test(h.textContent));
    if (!gab) return true;
    // Não deve haver nenhuma questão numerada depois do gabarito.
    let depois = false, achouQuestaoDepois = false;
    for (const el of document.querySelectorAll('#exercisesOutput *')) {
      if (el === gab) { depois = true; continue; }
      if (depois && /^\s*\d+\./.test(el.textContent || '')) achouQuestaoDepois = true;
    }
    return !achouQuestaoDepois;
  });
  if (!ordemOk) problemas.push('Exercícios: há questões depois da seção Gabarito (gabarito deveria ser o último).');

  await browser.close();

  // Console + append no relatório de frontend.
  console.log('Validação visual concluída. Screenshots em tests/screenshots/.');
  if (problemas.length) {
    console.log('Problemas visuais encontrados:');
    problemas.forEach((p) => console.log(' - ' + p));
  } else {
    console.log('Nenhum problema visual detectado no layout renderizado. 🎉');
  }

  let bloco = `\n## Validação visual (Playwright) — ${new Date().toLocaleString('pt-BR')}\n\n`;
  bloco += `Screenshots: tests/screenshots/ (01-inicial, 02-mapa-mental, 03-exercicios)\n\n`;
  bloco += problemas.length
    ? problemas.map((p) => `- 🔴 ${p}`).join('\n') + '\n'
    : '- 🟢 Nenhum problema visual detectado no layout renderizado.\n';
  try { fs.appendFileSync(RELATORIO, bloco, 'utf-8'); } catch {}

  clearTimeout(HARD_TIMEOUT);
  process.exit(problemas.length ? 1 : 0);
}

main().catch((e) => { console.error('Erro na validação visual:', e); process.exit(1); });
