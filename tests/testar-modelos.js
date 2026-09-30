#!/usr/bin/env node
'use strict';

/**
 * AGENTE DE TESTE do Estudo AI.
 *
 * Exercita a lógica de IA REAL do app (src/services/ai.js) contra TODOS os
 * modelos instalados no Ollama, usando a pasta tests/pasta-teste, e gera um
 * relatório de bugs/problemas em tests/relatorio-testes.md.
 *
 * O que testa, para cada modelo:
 *   - Resumo (curto, médio, detalhado) de um arquivo
 *   - Mapa mental de um arquivo  (valida o JSON estruturado)
 *   - Exercícios de um arquivo
 *   - Resumo da PASTA INTEIRA (map-reduce)
 *   - Mapa mental da PASTA INTEIRA
 *
 * Para cada teste registra: sucesso/falha, tempo, e um diagnóstico automático
 * (travamento, timeout, JSON inválido, resposta vazia/curta demais, etc.).
 *
 * Uso:
 *   node tests/testar-modelos.js                 # testa todos os modelos
 *   node tests/testar-modelos.js qwen2.5:7b      # testa só um modelo
 *
 * Pré-requisitos: Ollama rodando (ollama serve) com pelo menos 1 modelo.
 */

const fs = require('fs');
const path = require('path');

const ai = require('../src/services/ai');

const PASTA_TESTE = path.join(__dirname, 'pasta-teste');
const RELATORIO = path.join(__dirname, 'relatorio-testes.md');
const BUGS_JSON = path.join(__dirname, 'bugs.json'); // atualizado a cada teste
const OLLAMA_URL = 'http://127.0.0.1:11434';

// Estado compartilhado, gravado incrementalmente para o agente "conversar"
// com quem estiver acompanhando (Kiro lê este arquivo e corrige os bugs).
const estado = {
  iniciadoEm: new Date().toISOString(),
  status: 'rodando',
  modelos: [],       // lista de modelos a testar
  resultados: [],    // { model, teste, status, ms, bugs:[], erro, amostra }
  concluidoEm: null,
};

function flushEstado() {
  try {
    fs.writeFileSync(BUGS_JSON, JSON.stringify(estado, null, 2), 'utf-8');
  } catch {}
}

// ------------------------------------------------------------------
// Utilitários
// ------------------------------------------------------------------
function lerArquivosTeste() {
  const nomes = fs.readdirSync(PASTA_TESTE).filter((n) => !n.startsWith('.'));
  return nomes.map((nome) => {
    const p = path.join(PASTA_TESTE, nome);
    const st = fs.statSync(p);
    return {
      name: nome,
      path: p,
      text: fs.readFileSync(p, 'utf-8'),
      mtime: st.mtimeMs,
      size: st.size,
    };
  });
}

async function listarModelos() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map((m) => m.name);
  } catch {
    return [];
  }
}

// Teto de tempo por teste (evita esperar 8 min num modelo travado).
// Pode ser ajustado por variável de ambiente: TESTE_TIMEOUT_S=180
const TIMEOUT_TESTE_MS = (Number(process.env.TESTE_TIMEOUT_S) || 150) * 1000;

// Executa uma função de teste medindo tempo, com teto de tempo e captura de erros.
// A função recebe um AbortSignal; no timeout, abortamos de verdade a geração
// (o ai.js encerra a chamada e para os retries), evitando travar por muito tempo.
async function medir(fnComSinal) {
  const inicio = Date.now();
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ __timeout: true });
    }, TIMEOUT_TESTE_MS);
  });
  try {
    const vencedor = await Promise.race([fnComSinal(controller.signal), timeout]);
    clearTimeout(timer);
    if (vencedor && vencedor.__timeout) {
      return { res: { ok: false, error: `TRAVOU: sem resposta em ${TIMEOUT_TESTE_MS / 1000}s (modelo pesado demais)` }, ms: Date.now() - inicio, travou: true };
    }
    return { res: vencedor, ms: Date.now() - inicio };
  } catch (e) {
    clearTimeout(timer);
    return { res: { ok: false, error: 'EXCEÇÃO: ' + (e && e.message) }, ms: Date.now() - inicio };
  }
}

// Analisa o resultado e devolve status + diagnóstico de bug.
function diagnosticar(tipo, res, ms) {
  const bugs = [];
  let status = 'OK';

  if (!res || !res.ok) {
    status = 'FALHA';
    const err = (res && res.error) || 'sem resposta';
    bugs.push(`Erro: ${err}`);
    if (/travou|parou de responder|tempo esgotado|watchdog/i.test(err)) {
      bugs.push('→ Modelo travou/estourou tempo (provável falta de memória/VRAM).');
    }
    if (/fetch|conex/i.test(err)) {
      bugs.push('→ Conexão com o Ollama caiu durante a geração.');
    }
    if (/mapa válido|JSON/i.test(err)) {
      bugs.push('→ O modelo não devolveu JSON válido para o mapa mental.');
    }
    return { status, bugs };
  }

  // Sucesso "ok", mas ainda pode ter problemas de qualidade.
  if (tipo === 'mapa') {
    const map = res.map || {};
    if (!map.central) bugs.push('Mapa sem tema central.');
    if (!Array.isArray(map.nodes) || map.nodes.length < 2) bugs.push('Mapa com poucos ramos (<2).');
    const semDesc = (map.nodes || []).some((n) =>
      (n.children || []).some((c) => !c || !c.descricao || !c.descricao.trim())
    );
    if (semDesc) bugs.push('Há subtópicos sem descrição (mapa vira só rótulos).');
  } else {
    const txt = (res.text || '').trim();
    if (!txt) { status = 'FALHA'; bugs.push('Resposta vazia.'); }
    else if (txt.length < 120) bugs.push(`Resposta muito curta (${txt.length} chars) — possível resumo raso.`);
    if (/^\s*(desculpe|sorry|i cannot|não posso)/i.test(txt)) bugs.push('Modelo recusou/again em inglês.');
  }

  if (ms > 300000) bugs.push(`Muito lento (${Math.round(ms / 1000)}s).`);
  if (bugs.length && status === 'OK') status = 'ALERTA';
  return { status, bugs };
}

// ------------------------------------------------------------------
// Execução dos testes de um modelo
// ------------------------------------------------------------------
async function testarModelo(model, arquivos, log) {
  const linhas = [];
  const umArquivo = arquivos[0];
  let travamentosSeguidos = 0;
  let pulando = false;

  const registrar = (nome, tipo, r) => {
    const { status, bugs } = diagnosticar(tipo, r.res, r.ms);
    const emoji = status === 'OK' ? '✅' : status === 'ALERTA' ? '⚠️' : '❌';
    linhas.push(
      `| ${nome} | ${emoji} ${status} | ${Math.round(r.ms / 1000)}s | ${bugs.join(' ') || '-'} |`
    );
    log(`  ${emoji} ${nome} (${Math.round(r.ms / 1000)}s) ${bugs.join(' ')}`);

    // Amostra da resposta (para eu diagnosticar): texto ou mapa resumido.
    let amostra = '';
    if (r.res && r.res.ok) {
      if (tipo === 'mapa' && r.res.map) amostra = JSON.stringify(r.res.map).slice(0, 500);
      else if (r.res.text) amostra = r.res.text.slice(0, 400);
    }
    estado.resultados.push({
      model, teste: nome, status, ms: r.ms,
      bugs, erro: (r.res && !r.res.ok) ? r.res.error : null, amostra,
    });
    flushEstado();

    // Se travar, o modelo é pesado demais para esta máquina: pula o resto dele.
    if (r.travou) travamentosSeguidos++; else travamentosSeguidos = 0;
    if (travamentosSeguidos >= 1) pulando = true;
  };

  // Executa um teste, ou registra como "pulado" se já decidimos pular o modelo.
  const rodar = async (nome, tipo, fn) => {
    if (pulando) {
      linhas.push(`| ${nome} | ⏭️ PULADO | - | Modelo travou nos testes anteriores (pesado demais). |`);
      log(`  ⏭️ ${nome} (pulado)`);
      estado.resultados.push({ model, teste: nome, status: 'PULADO', ms: 0, bugs: ['Modelo travou antes.'], erro: null, amostra: '' });
      flushEstado();
      return;
    }
    registrar(nome, tipo, await medir(fn));
  };

  log(`\n=== Modelo: ${model} ===`);

  await rodar('Resumo curto (arquivo)', 'texto', (signal) => ai.generateSummary(umArquivo.text, { model, nivel: 'curto', signal }));
  await rodar('Resumo médio (arquivo)', 'texto', (signal) => ai.generateSummary(umArquivo.text, { model, nivel: 'médio', signal }));
  await rodar('Resumo detalhado (arquivo)', 'texto', (signal) => ai.generateSummary(umArquivo.text, { model, nivel: 'detalhado', signal }));
  await rodar('Mapa mental (arquivo)', 'mapa', (signal) => ai.generateMindmap(umArquivo.text, { model, signal }));
  await rodar('Exercícios (arquivo)', 'texto', (signal) => ai.generateExercises(umArquivo.text, { model, quantidade: 5, tipo: 'mistas', signal }));
  await rodar('Resumo detalhado (PASTA)', 'texto', (signal) => ai.generateSummaryFolder(arquivos, { model, nivel: 'detalhado', signal }));
  await rodar('Mapa mental (PASTA)', 'mapa', (signal) => ai.generateMindmapFolder(arquivos, { model, signal }));

  return linhas;
}

// ------------------------------------------------------------------
// Principal
// ------------------------------------------------------------------
async function main() {
  const log = (...a) => console.log(...a);
  log('Agente de teste do Estudo AI\n============================');

  // Verifica Ollama.
  const status = await ai.checkStatus();
  if (!status.ok) {
    log('❌ Ollama não está rodando. Abra o Ollama (ou rode "ollama serve") e tente de novo.');
    process.exit(1);
  }

  let modelos = process.argv[2] ? [process.argv[2]] : await listarModelos();
  if (!modelos.length) {
    log('❌ Nenhum modelo instalado. Rode: ollama pull qwen2.5:7b');
    process.exit(1);
  }
  log('Modelos a testar: ' + modelos.join(', '));
  estado.modelos = modelos;
  flushEstado();

  const arquivos = lerArquivosTeste();
  log(`Pasta de teste: ${arquivos.length} arquivo(s).`);

  const secoes = [];
  const inicioTotal = Date.now();
  for (const model of modelos) {
    const linhas = await testarModelo(model, arquivos, log);
    secoes.push({ model, linhas });
  }
  const totalMin = ((Date.now() - inicioTotal) / 60000).toFixed(1);
  estado.status = 'concluido';
  estado.concluidoEm = new Date().toISOString();
  flushEstado();

  // Monta o relatório em Markdown.
  let md = `# Relatório de Testes — Estudo AI\n\n`;
  md += `Gerado em: ${new Date().toLocaleString('pt-BR')}\n\n`;
  md += `Modelos testados: ${modelos.length} · Arquivos na pasta de teste: ${arquivos.length} · Tempo total: ${totalMin} min\n\n`;
  md += `Legenda: ✅ OK · ⚠️ passou mas com ressalva · ❌ falhou\n\n`;

  let totalBugs = 0;
  for (const s of secoes) {
    md += `## Modelo: \`${s.model}\`\n\n`;
    md += `| Teste | Status | Tempo | Observações / Bugs |\n`;
    md += `|-------|--------|-------|--------------------|\n`;
    md += s.linhas.join('\n') + '\n\n';
    totalBugs += s.linhas.filter((l) => l.includes('❌') || l.includes('⚠️')).length;
  }

  md += `---\n\n## Resumo\n\n`;
  md += totalBugs === 0
    ? 'Nenhum problema encontrado. 🎉\n'
    : `Foram encontrados **${totalBugs}** teste(s) com falha ou ressalva. Veja as observações acima.\n`;
  md += `\n> Dica: modelos que "travaram" ou deram timeout provavelmente são grandes demais para a memória/VRAM desta máquina. Prefira modelos de 7B/9B.\n`;

  fs.writeFileSync(RELATORIO, md, 'utf-8');
  log(`\n📄 Relatório salvo em: ${RELATORIO}`);
  log(`Concluído em ${totalMin} min. Testes com problema: ${totalBugs}.`);
}

main().catch((e) => {
  console.error('Erro fatal no agente de teste:', e);
  process.exit(1);
});
