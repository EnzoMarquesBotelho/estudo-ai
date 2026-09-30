#!/usr/bin/env node
'use strict';

/**
 * AGENTE DE FRONTEND do Estudo AI.
 *
 * Analisa estaticamente o HTML/CSS/JS da interface (src/renderer) em busca de
 * bugs visuais e pontos de melhoria, e CRUZA com o bugs.json do agente de teste
 * (tests/testar-modelos.js) para detectar problemas visuais causados pela IA
 * (ex.: mapa mental sem descrições vira só rótulos; resposta vazia deixa a tela
 * em branco). Gera um relatório em tests/relatorio-frontend.md.
 *
 * Importante: um agente de linha de comando não "enxerga" a tela renderizada.
 * Por isso a análise é baseada em regras sobre o código (contraste aproximado,
 * responsividade, acessibilidade, overflow) e na correlação com o agente de teste.
 *
 * Uso:  node tests/analise-frontend.js
 */

const fs = require('fs');
const path = require('path');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const CSS = path.join(RENDERER, 'styles.css');
const HTML = path.join(RENDERER, 'index.html');
const BUGS_JSON = path.join(__dirname, 'bugs.json');
const RELATORIO = path.join(__dirname, 'relatorio-frontend.md');

const achados = []; // { severidade, area, problema, sugestao }
function add(severidade, area, problema, sugestao) {
  achados.push({ severidade, area, problema, sugestao });
}

// ---------- utilidades de cor / contraste (WCAG aproximado) ----------
function hexToRgb(hex) {
  const m = hex.replace('#', '');
  const n = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
}
function luminancia([r, g, b]) {
  const a = [r, g, b].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}
function contraste(hex1, hex2) {
  const l1 = luminancia(hexToRgb(hex1));
  const l2 = luminancia(hexToRgb(hex2));
  const [claro, escuro] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (claro + 0.05) / (escuro + 0.05);
}

// Extrai as variáveis de cor do :root.
function extrairVars(css) {
  const vars = {};
  const bloco = (css.match(/:root\s*{([^}]*)}/) || [])[1] || '';
  for (const m of bloco.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,6})/g)) {
    vars[m[1]] = m[2];
  }
  return vars;
}

// ---------- análise do CSS ----------
function analisarCss(css) {
  const vars = extrairVars(css);

  // 1. Contraste texto normal x fundo (WCAG AA pede >= 4.5).
  const pares = [
    ['text', 'bg', 'texto principal sobre o fundo'],
    ['text-dim', 'bg', 'texto secundário sobre o fundo'],
    ['text-dim', 'bg-2', 'texto secundário sobre a barra lateral'],
    ['text-dim', 'bg-3', 'texto secundário sobre superfícies escuras'],
  ];
  for (const [fg, bg, desc] of pares) {
    if (vars[fg] && vars[bg]) {
      const c = contraste(vars[fg], vars[bg]);
      if (c < 4.5) {
        add(c < 3 ? 'alta' : 'média', 'Contraste',
          `Contraste baixo (${c.toFixed(2)}:1) — ${desc}. WCAG AA pede 4.5:1.`,
          `Clarear --${fg} ou escurecer --${bg}.`);
      }
    }
  }

  // 2. Estados de foco visíveis (acessibilidade por teclado).
  if (!/:focus-visible/.test(css) && !/:focus\b/.test(css)) {
    add('alta', 'Acessibilidade',
      'Nenhum estilo de foco (:focus-visible) — usuários de teclado não veem o elemento focado.',
      'Adicionar outline visível em botões, selects e itens focáveis via :focus-visible.');
  }

  // 3. Suporte a movimento reduzido (spinner sempre anima).
  if (/@keyframes/.test(css) && !/prefers-reduced-motion/.test(css)) {
    add('média', 'Acessibilidade',
      'Há animações mas nenhum @media (prefers-reduced-motion) — pode incomodar quem tem sensibilidade a movimento.',
      'Reduzir/parar animações quando prefers-reduced-motion: reduce.');
  }

  // 4. Altura fixa muito grande no palco do mapa mental (risco de overflow).
  //    Só alerta se for exagerada (>= 700px); o container pai rola (overflow-y),
  //    e o JS reposiciona os ramos no resize, o que já mitiga valores moderados.
  const mm = (css.match(/\.mm-stage\s*{([^}]*)}/) || [])[1] || '';
  const mh = (mm.match(/min-height:\s*(\d{3,})px/) || [])[1];
  if (mh && Number(mh) >= 700) {
    add('média', 'Layout / Responsividade',
      `O mapa mental usa min-height fixo alto (${mh}px); em janelas baixas os ramos podem cortar.`,
      'Reduzir o min-height e confiar no reposicionamento por JS + rolagem do container.');
  }

  // 5. Sidebar largura fixa sem colapso responsivo.
  if (/#sidebar\s*{[^}]*min-width:\s*300px/.test(css) && !/@media/.test(css)) {
    add('baixa', 'Responsividade',
      'A barra lateral tem largura fixa (300px) e não há @media queries — em janelas estreitas o conteúdo aperta.',
      'Adicionar um breakpoint que estreita/colapsa a sidebar em telas pequenas.');
  }

  // 6. Cores hardcoded fora das variáveis (consistência de tema).
  const hardcoded = (css.match(/#[0-9a-fA-F]{6}/g) || []).filter((h, i, arr) => {
    // ignora as definições dentro do :root
    return true;
  });
  const foraDoRoot = css.replace(/:root\s*{[^}]*}/, '');
  if (/#[0-9a-fA-F]{6}/.test(foraDoRoot.replace(/rgba?\([^)]*\)/g, ''))) {
    add('baixa', 'Consistência de tema',
      'Há cores hexadecimais fixas fora do :root (ex.: .mm-node-title usa #11111b).',
      'Trocar por variáveis (var(--bg-3)) para manter o tema consistente.');
  }

  return vars;
}

// ---------- análise do HTML ----------
function analisarHtml(html) {
  // 1. selects sem rótulo acessível.
  const selects = [...html.matchAll(/<select[^>]*id="([^"]+)"[^>]*>/g)].map((m) => ({ id: m[1], tag: m[0] }));
  for (const s of selects) {
    const temAria = /aria-label=/.test(s.tag);
    const temLabelFor = new RegExp(`<label[^>]*for="${s.id}"`).test(html);
    if (!temAria && !temLabelFor) {
      add('média', 'Acessibilidade',
        `O <select id="${s.id}"> não tem rótulo acessível (aria-label ou <label for>).`,
        `Adicionar aria-label descritivo ao <select id="${s.id}">.`);
    }
  }

  // 2. Abas sem semântica ARIA.
  if (/class="tab[ "]/.test(html) && !/role="tab"/.test(html)) {
    add('baixa', 'Acessibilidade',
      'As abas são <button> sem role="tab"/aria-selected — leitores de tela não anunciam como abas.',
      'Adicionar role="tablist"/role="tab" e aria-selected nas abas.');
  }

  // 3. lang definido?
  if (!/<html[^>]*lang=/.test(html)) {
    add('média', 'Acessibilidade', 'Falta o atributo lang no <html>.', 'Definir <html lang="pt-br">.');
  }
}

// ---------- correlação com o agente de teste ----------
function analisarBugsDaIA() {
  if (!fs.existsSync(BUGS_JSON)) {
    add('info', 'Integração',
      'Não encontrei tests/bugs.json — rode o agente de teste (npm run test:models) para eu cruzar bugs visuais causados pela IA.',
      'Executar o agente de teste antes deste.');
    return;
  }
  let dados;
  try { dados = JSON.parse(fs.readFileSync(BUGS_JSON, 'utf-8')); } catch { return; }
  const res = dados.resultados || [];

  // Mapa mental sem descrição -> vira só rótulos (bug visual reportado pelo usuário).
  const mapasRuins = res.filter((r) => (r.bugs || []).some((b) => /descri/i.test(b)));
  if (mapasRuins.length) {
    add('alta', 'Mapa mental (dados→visual)',
      `Em ${mapasRuins.length} teste(s) o mapa veio com subtópicos sem descrição — na tela vira só uma lista de rótulos, sem valor de estudo.`,
      'Garantir no renderMindmap um fallback visual e reforçar o prompt para sempre trazer descrição.');
  }

  // Respostas vazias -> tela em branco.
  const vazias = res.filter((r) => (r.bugs || []).some((b) => /vazia/i.test(b)));
  if (vazias.length) {
    add('média', 'Estado vazio',
      `${vazias.length} teste(s) retornaram resposta vazia — o painel fica em branco sem explicação ao usuário.`,
      'Mostrar um estado de erro amigável quando a resposta vier vazia.');
  }

  // Travamentos -> a UI fica só com spinner.
  const travados = res.filter((r) => (r.bugs || []).some((b) => /travou|tempo/i.test(b)));
  if (travados.length) {
    add('média', 'Feedback de carregamento',
      `${travados.length} teste(s) travaram/deram timeout — na UI isso aparece como spinner infinito se não houver aviso.`,
      'Já há watchdog no ai.js; garantir que a UI troque o spinner por mensagem de erro clara ao falhar.');
  }
}

// ---------- geração do relatório ----------
function gerarRelatorio() {
  const ordem = { alta: 0, 'média': 1, baixa: 2, info: 3 };
  achados.sort((a, b) => (ordem[a.severidade] ?? 9) - (ordem[b.severidade] ?? 9));

  const emoji = { alta: '🔴', 'média': '🟡', baixa: '🔵', info: 'ℹ️' };
  let md = `# Relatório de Frontend — Estudo AI\n\n`;
  md += `Gerado em: ${new Date().toLocaleString('pt-BR')}\n\n`;
  md += `Achados: ${achados.length}\n\n`;
  md += `Severidade: 🔴 alta · 🟡 média · 🔵 baixa · ℹ️ info\n\n`;

  if (!achados.length) {
    md += 'Nenhum problema visual encontrado. 🎉\n';
  } else {
    md += `| Sev | Área | Problema | Sugestão |\n|-----|------|----------|----------|\n`;
    for (const a of achados) {
      md += `| ${emoji[a.severidade] || ''} | ${a.area} | ${a.problema} | ${a.sugestao} |\n`;
    }
  }
  md += `\n> Observação: análise estática + correlação com o agente de teste. Para validação visual completa (pixels), seria preciso abrir a UI num navegador headless e inspecionar o DOM renderizado.\n`;

  fs.writeFileSync(RELATORIO, md, 'utf-8');
}

function main() {
  console.log('Agente de Frontend — analisando a interface...');
  if (!fs.existsSync(CSS) || !fs.existsSync(HTML)) {
    console.error('Não encontrei o CSS/HTML do renderer em', RENDERER);
    process.exit(1);
  }
  const css = fs.readFileSync(CSS, 'utf-8');
  const html = fs.readFileSync(HTML, 'utf-8');

  analisarCss(css);
  analisarHtml(html);
  analisarBugsDaIA();
  gerarRelatorio();

  const altas = achados.filter((a) => a.severidade === 'alta').length;
  console.log(`Concluído. ${achados.length} achado(s) (${altas} de severidade alta).`);
  console.log('Relatório: ' + RELATORIO);
}

main();
