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
 * -----------------------------------------------------------------------------
 * MODO INCREMENTAL (estado em tests/modelos-estado.json)
 * -----------------------------------------------------------------------------
 * - 1ª execução (sem estado salvo): cada modelo é testado COMPLETAMENTE (as 7
 *   funções).
 * - Execuções seguintes: por modelo, só rodamos as funções NOVAS, isto é, as
 *   que ainda não têm resultado salvo para aquele modelo (chave
 *   "<modelo>::<funcao>"). Se nenhuma função for nova, o modelo é pulado.
 * - ROLLBACK por modelo: se, durante o incremental, QUALQUER função daquele
 *   modelo retornar status FALHA (inclui travou/timeout/erro/resposta vazia),
 *   ESSE modelo específico volta a ser testado COMPLETAMENTE (todas as 7
 *   funções). Os demais modelos continuam no modo incremental.
 * - ⚠️ ATENÇÃO: o status ALERTA (passou com ressalva) NÃO conta como falha e
 *   NÃO dispara rollback. Só FALHA dispara.
 * - FORCAR_COMPLETO=1 ignora o estado e testa TODOS os modelos completamente.
 *
 * Uso:
 *   node tests/testar-modelos.js                 # testa todos os modelos
 *   node tests/testar-modelos.js qwen2.5:7b      # testa só um modelo
 *   FORCAR_COMPLETO=1 node tests/testar-modelos.js  # ignora o estado incremental
 *
 * Pré-requisitos: Ollama rodando (ollama serve) com pelo menos 1 modelo.
 *
 * NOTA: a bateria real (contra Ollama) NÃO roda no build. A lógica incremental
 * é validada por tests/testar-modelos-incremental.js, que injeta um runner
 * mockado (sem Ollama, sem pasta real) — ver module.exports no fim do arquivo.
 */

const fs = require('fs');
const path = require('path');

const ai = require('../src/services/ai');

const PASTA_TESTE = path.join(__dirname, 'pasta-teste');
const RELATORIO = path.join(__dirname, 'relatorio-testes.md');
const BUGS_JSON = path.join(__dirname, 'bugs.json'); // atualizado a cada teste
const ESTADO_INC = path.join(__dirname, 'modelos-estado.json'); // estado incremental
const OLLAMA_URL = 'http://127.0.0.1:11434';

// Flag de modo "forçar completo": ignora o estado incremental. Lida de forma
// dinâmica (função) para que os testes de lógica possam alternar a env sem
// reimportar o módulo.
function forcarCompleto() {
  return process.env.FORCAR_COMPLETO === '1';
}

// Lista canônica das 7 funções testadas, na ordem em que rodam. Serve de
// referência de funcoesConhecidas e para detectar funções NOVAS.
const FUNCOES_CANONICAS = [
  'Resumo curto (arquivo)',
  'Resumo médio (arquivo)',
  'Resumo detalhado (arquivo)',
  'Mapa mental (arquivo)',
  'Exercícios (arquivo)',
  'Resumo detalhado (PASTA)',
  'Mapa mental (PASTA)',
  'Resumo médio + foco prova (arquivo)',
  'Resumo detalhado + foco aprofundado (arquivo)',
];

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
// Estado incremental (tests/modelos-estado.json)
// ------------------------------------------------------------------
// Shape:
//   {
//     atualizadoEm: ISO,
//     funcoesConhecidas: [nome],
//     resultados: { "<modelo>::<funcao>": { status, timestamp } }
//   }
function chaveEstado(model, funcao) {
  return `${model}::${funcao}`;
}

// Carrega o estado incremental do disco. Em FORCAR_COMPLETO ou se o arquivo não
// existir/estiver corrompido, devolve um estado vazio (nada "conhecido").
function carregarEstadoIncremental(arquivo = ESTADO_INC) {
  const vazio = { atualizadoEm: null, funcoesConhecidas: [], resultados: {}, tinhaEstadoAoCarregar: false };
  if (forcarCompleto()) return vazio;
  try {
    if (!fs.existsSync(arquivo)) return vazio;
    const dados = JSON.parse(fs.readFileSync(arquivo, 'utf-8'));
    const resultados = dados.resultados && typeof dados.resultados === 'object' ? dados.resultados : {};
    return {
      atualizadoEm: dados.atualizadoEm || null,
      funcoesConhecidas: Array.isArray(dados.funcoesConhecidas) ? dados.funcoesConhecidas : [],
      resultados,
      // Snapshot do "tinha estado?" no momento do carregamento. É fixo durante
      // toda a execução para que o flush por função (que mexe em atualizadoEm)
      // não vire a 1ª execução em incremental no meio do caminho.
      tinhaEstadoAoCarregar: Object.keys(resultados).length > 0,
    };
  } catch {
    return vazio;
  }
}

// Persiste o estado incremental após cada função testada.
function flushEstadoIncremental(estadoInc, arquivo = ESTADO_INC) {
  try {
    estadoInc.atualizadoEm = new Date().toISOString();
    fs.writeFileSync(arquivo, JSON.stringify(estadoInc, null, 2), 'utf-8');
  } catch {}
}

// Grava o resultado de uma função no estado incremental (chave modelo::funcao)
// e garante que a função conste em funcoesConhecidas.
function registrarResultadoIncremental(estadoInc, model, funcao, status) {
  estadoInc.resultados[chaveEstado(model, funcao)] = {
    status,
    timestamp: new Date().toISOString(),
  };
  if (!estadoInc.funcoesConhecidas.includes(funcao)) {
    estadoInc.funcoesConhecidas.push(funcao);
  }
}

// Decide o conjunto de funções a rodar para um modelo:
//  - sem estado (1ª vez) OU FORCAR_COMPLETO -> TODAS as funções canônicas;
//  - caso contrário -> só as NOVAS (sem resultado salvo para aquele modelo).
function funcoesAlvoParaModelo(estadoInc, model) {
  const semEstado = !estadoInc.tinhaEstadoAoCarregar;
  if (forcarCompleto() || semEstado) return FUNCOES_CANONICAS.slice();
  return FUNCOES_CANONICAS.filter((f) => !estadoInc.resultados[chaveEstado(model, f)]);
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
// Catálogo das funções testadas por modelo (nome -> tipo + chamada).
// Centralizar aqui permite rodar só um subconjunto (funcoesAlvo) e injetar um
// runner mockado nos testes de lógica.
// ------------------------------------------------------------------
function catalogoFuncoes(arquivos) {
  const umArquivo = arquivos[0];
  return [
    { nome: 'Resumo curto (arquivo)', tipo: 'texto', fn: (model, signal) => ai.generateSummary(umArquivo.text, { model, nivel: 'curto', signal }) },
    { nome: 'Resumo médio (arquivo)', tipo: 'texto', fn: (model, signal) => ai.generateSummary(umArquivo.text, { model, nivel: 'médio', signal }) },
    { nome: 'Resumo detalhado (arquivo)', tipo: 'texto', fn: (model, signal) => ai.generateSummary(umArquivo.text, { model, nivel: 'detalhado', signal }) },
    { nome: 'Mapa mental (arquivo)', tipo: 'mapa', fn: (model, signal) => ai.generateMindmap(umArquivo.text, { model, signal }) },
    { nome: 'Exercícios (arquivo)', tipo: 'texto', fn: (model, signal) => ai.generateExercises(umArquivo.text, { model, quantidade: 5, tipo: 'mistas', signal }) },
    { nome: 'Resumo detalhado (PASTA)', tipo: 'texto', fn: (model, signal) => ai.generateSummaryFolder(arquivos, { model, nivel: 'detalhado', signal }) },
    { nome: 'Mapa mental (PASTA)', tipo: 'mapa', fn: (model, signal) => ai.generateMindmapFolder(arquivos, { model, signal }) },
    { nome: 'Resumo médio + foco prova (arquivo)', tipo: 'texto', fn: (model, signal) => ai.generateSummary(umArquivo.text, { model, nivel: 'médio', foco: 'prova', signal }) },
    { nome: 'Resumo detalhado + foco aprofundado (arquivo)', tipo: 'texto', fn: (model, signal) => ai.generateSummary(umArquivo.text, { model, nivel: 'detalhado', foco: 'aprofundado', signal }) },
  ];
}

// Runner real: mede o tempo e aborta travados de verdade (usa medir()).
// Recebe (model, funcaoDef) e devolve o objeto { res, ms, travou } de medir().
async function runnerReal(model, funcaoDef) {
  return medir((signal) => funcaoDef.fn(model, signal));
}

// ------------------------------------------------------------------
// Execução das funções-alvo de um modelo.
//
// Parametrizável:
//  - funcoesAlvo: nomes das funções a rodar (subconjunto do catálogo);
//  - runner: injetável (default = runnerReal). Nos testes de lógica, um runner
//    mockado simula passar/falhar sem Ollama nem pasta real;
//  - estadoInc: estado incremental; registra "<modelo>::<funcao>" após cada
//    função e persiste via flushEstadoIncremental;
//  - onRegistro(nome, status): callback opcional (usado pelo rollback/ testes).
//
// Preserva rodar/registrar/diagnosticar, o timeout por teste e a gravação de
// tests/bugs.json. Devolve { linhas, houveFalha } — houveFalha indica se alguma
// função retornou status FALHA (usado pela lógica de rollback por modelo).
// ------------------------------------------------------------------
async function executarFuncoesDoModelo(model, arquivos, log, opcoes = {}) {
  const {
    funcoesAlvo = FUNCOES_CANONICAS.slice(),
    runner = runnerReal,
    estadoInc = null,
    arquivoEstado = ESTADO_INC,
    onRegistro = null,
  } = opcoes;

  const catalogo = catalogoFuncoes(arquivos);
  const porNome = new Map(catalogo.map((c) => [c.nome, c]));
  const linhas = [];
  let houveFalha = false;

  const registrar = (nome, tipo, r) => {
    let { status, bugs } = diagnosticar(tipo, r.res, r.ms);

    // Diagnóstico ADITIVO de marcador por foco (não altera diagnosticar()).
    // Só rebaixa OK->ALERTA; NUNCA vira FALHA (para não disparar rollback).
    if (r.res && r.res.ok) {
      const txt = (r.res.text || '');
      if (/foco prova/i.test(nome) && !/pontos de atenção para a prova/i.test(txt)) {
        bugs.push('Faltou a seção de pontos de atenção para a prova.');
        if (status === 'OK') status = 'ALERTA';
      }
      if (/aprofundado/i.test(nome) && !/porqu[eê]|por que/i.test(txt)) {
        bugs.push('Resposta não demonstra aprofundamento (sem explicação do porquê).');
        if (status === 'OK') status = 'ALERTA';
      }
    }

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

    // Persiste o estado incremental por função (chave modelo::funcao).
    if (estadoInc) {
      registrarResultadoIncremental(estadoInc, model, nome, status);
      flushEstadoIncremental(estadoInc, arquivoEstado);
    }

    // ⚠️ Só FALHA conta para rollback; ALERTA NÃO.
    if (status === 'FALHA') houveFalha = true;

    if (onRegistro) onRegistro(nome, status);
  };

  for (const nome of funcoesAlvo) {
    const def = porNome.get(nome);
    if (!def) continue; // nome fora do catálogo canônico: ignora com segurança.
    const r = await runner(model, def);
    registrar(nome, def.tipo, r);
  }

  return { linhas, houveFalha };
}

// ------------------------------------------------------------------
// Testa um modelo respeitando o estado incremental e o rollback por modelo.
//
// 1) Decide funcoesAlvo (TODAS se 1ª vez/FORCAR_COMPLETO, senão só as NOVAS).
// 2) Roda as funções-alvo.
// 3) ROLLBACK: se, no modo incremental (funcoesAlvo != TODAS), alguma função
//    FALHOU, reexecuta ESSE modelo COMPLETAMENTE (as 7 funções), sem tocar os
//    demais. ⚠️ ALERTA não dispara rollback.
// ------------------------------------------------------------------
async function testarModelo(model, arquivos, log, estadoInc, runner = runnerReal, arquivoEstado = ESTADO_INC) {
  log(`\n=== Modelo: ${model} ===`);

  const todas = FUNCOES_CANONICAS.slice();
  const funcoesAlvo = funcoesAlvoParaModelo(estadoInc, model);

  if (!funcoesAlvo.length) {
    log('  ⏭️ Nada novo para este modelo (todas as funções já têm resultado salvo).');
    return [];
  }

  const incremental = funcoesAlvo.length < todas.length;
  const primeira = await executarFuncoesDoModelo(model, arquivos, log, {
    funcoesAlvo, runner, estadoInc, arquivoEstado,
  });

  // Rollback por modelo: só no modo incremental, só se houve FALHA.
  if (incremental && primeira.houveFalha) {
    log(`  ↩️ ROLLBACK: ${model} teve falha no incremental → reexecutando COMPLETO.`);
    const completo = await executarFuncoesDoModelo(model, arquivos, log, {
      funcoesAlvo: todas, runner, estadoInc, arquivoEstado,
    });
    return primeira.linhas.concat(completo.linhas);
  }

  return primeira.linhas;
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
    process.exit(0);
  }

  let modelos = process.argv[2] ? [process.argv[2]] : await listarModelos();
  if (!modelos.length) {
    log('❌ Nenhum modelo instalado. Rode: ollama pull qwen2.5:7b');
    process.exit(0);
  }
  log('Modelos a testar: ' + modelos.join(', '));
  estado.modelos = modelos;
  flushEstado();

  // Carrega o estado incremental (vazio em FORCAR_COMPLETO).
  const estadoInc = carregarEstadoIncremental();
  if (forcarCompleto()) log('Modo FORCAR_COMPLETO: ignorando o estado incremental.');
  else if (estadoInc.tinhaEstadoAoCarregar) log('Estado incremental carregado: testando apenas funções novas por modelo.');
  else log('Sem estado incremental: 1ª execução testa todos os modelos completamente.');

  const arquivos = lerArquivosTeste();
  log(`Pasta de teste: ${arquivos.length} arquivo(s).`);

  const secoes = [];
  const inicioTotal = Date.now();
  for (const model of modelos) {
    const linhas = await testarModelo(model, arquivos, log, estadoInc);
    secoes.push({ model, linhas });
  }
  const totalMin = ((Date.now() - inicioTotal) / 60000).toFixed(1);
  estado.status = 'concluido';
  estado.concluidoEm = new Date().toISOString();
  flushEstado();
  flushEstadoIncremental(estadoInc);

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
    md += (s.linhas.length ? s.linhas.join('\n') : '| (sem funções novas) | ⏭️ PULADO | - | Já testado antes. |') + '\n\n';
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

// A bateria real só roda quando o arquivo é executado diretamente. Quando é
// importado (require.main !== module), expomos a lógica para os testes de
// lógica (tests/testar-modelos-incremental.js) exercitarem com runner mockado.
if (require.main === module) {
  main().catch((e) => {
    console.error('Erro fatal no agente de teste:', e);
    process.exit(1);
  });
} else {
  module.exports = {
    FUNCOES_CANONICAS,
    chaveEstado,
    carregarEstadoIncremental,
    flushEstadoIncremental,
    registrarResultadoIncremental,
    funcoesAlvoParaModelo,
    diagnosticar,
    catalogoFuncoes,
    executarFuncoesDoModelo,
    testarModelo,
  };
}
