'use strict';

/**
 * Classificação por TIPO de material (Fase 3, Parte 1).
 *
 * Tipos: aula | lista | prova | trabalho | outro (fallback).
 *
 * Como grouping.js/rag.js, este módulo tem DUAS camadas no mesmo arquivo:
 *   - NÚCLEO PURO: determinístico, importa só `crypto` (para o storeKey) e
 *     `./grouping-core` (que por sua vez só importa `crypto`). NÃO importa
 *     `fs`/`path`/`os`/rede, NEM `./grouping` NEM `./store`. A chamada ao
 *     Ollama é INJETADA de fora como `callGenerate`. (INV3, RF4, critério 7.)
 *   - CAMADA DE PERSISTÊNCIA (`classStore`): loadState/saveState/clearState,
 *     dependem de `./store` e gravam SOMENTE em userData (RF8, INV4).
 *
 * A orquestração (`runClassification`) recebe I/O (readText) e IA por
 * parâmetro — não importa `fs`.
 */

const crypto = require('crypto');
const core = require('./grouping-core');

// ===========================================================================
// Conjunto de tipos e constantes (ponto único de ajuste)
// ===========================================================================

// Conjunto fechado de tipos (RF1). 'outro' é o fallback obrigatório.
const TIPOS = ['aula', 'lista', 'prova', 'trabalho', 'outro'];
const TIPO_FALLBACK = 'outro';

// Origem da decisão (RF6): distingue na UI e no plano.
const ORIGEM = { HEURISTICA: 'heuristica', IA: 'ia', MANUAL: 'manual' };

// Limiar de confiança: abaixo disto, escala para IA (RF3). Ajustável aqui.
const LIMIAR_CONFIANCA_IA = 0.5;

// Nº de palavras do snippet lido para a heurística (barato).
const SNIPPET_PALAVRAS = 60;

// Pistas PT-BR por tipo (regex, case-insensitive). Ordem de prioridade quando
// houver múltiplos matches: prova > lista > trabalho > aula.
//
// Fronteiras de palavra baseadas em LETRAS (lookarounds), não em `\b`: nomes de
// arquivo usam `_`/`-`/dígitos como separadores (ex.: "Prova_2_Calculo"), e `_`
// é um caractere de palavra para `\b` — logo `\bprova\b` NÃO casaria "Prova_2".
// `(?<![a-zà-ú])` / `(?![a-zà-ú])` deixam dígitos, `_`, `-`, `.` e espaços
// atuarem como separadores, mantendo o match preso ao início/fim da palavra.
const B0 = '(?<![a-zà-ú])';
const B1 = '(?![a-zà-ú])';
const PISTAS = [
  { tipo: 'prova', re: new RegExp(`${B0}(prova|avalia(c|ç)[aã]o|p[12]|gabarito|exame|teste)${B1}`, 'i'), peso: 1.0 },
  { tipo: 'lista', re: new RegExp(`${B0}(lista|exerc[ií]cios?|quest[õo]es|problemas)${B1}`, 'i'), peso: 0.9 },
  { tipo: 'trabalho', re: new RegExp(`${B0}(trabalho|atividade|entrega|relat[óo]rio|projeto|semin[áa]rio)${B1}`, 'i'), peso: 0.85 },
  { tipo: 'aula', re: new RegExp(`${B0}(aula|slides?|resumo|apostila|notas|cap[íi]tulo|material)${B1}`, 'i'), peso: 0.7 },
];

// Prioridade fixa de desempate quando dois tipos casam (prova > lista > trabalho > aula > outro).
const PRIORIDADE = { prova: 4, lista: 3, trabalho: 2, aula: 1, outro: 0 };

// ===========================================================================
// NÚCLEO — heurística barata (RF2)
// ===========================================================================

// classificarHeuristica(signal) -> { tipo, confianca, origem:'heuristica', pistas:[string] }
// signal = { path, name, relPath, snippet } (snippet já cortado em SNIPPET_PALAVRAS
// pela orquestração). Determinística; NUNCA retorna null (critério 6/8).
function classificarHeuristica(signal) {
  const s = signal || {};
  const name = String(s.name || '');
  const pasta = core.primeiroNivel(s.relPath) || '';
  const snippet = String(s.snippet || '');
  const forte = `${name}\n${pasta}`;      // nome + subpasta de 1º nível (peso maior)
  const fraco = snippet;                   // trecho do conteúdo (peso menor)

  // Candidatos: cada pista que casa vira um candidato com confiança e origem do match.
  const candidatos = [];
  for (const p of PISTAS) {
    const matchForte = p.re.test(forte);
    const matchFraco = p.re.test(fraco);
    if (!matchForte && !matchFraco) continue;
    // Match em nome/pasta ⇒ confiança >= LIMIAR (usa o peso da pista).
    // Match só no snippet ⇒ confiança menor (peso * 0.6).
    const confianca = matchForte ? Math.max(p.peso, LIMIAR_CONFIANCA_IA) : p.peso * 0.6;
    candidatos.push({ tipo: p.tipo, confianca, forte: matchForte });
  }

  // Pista fraca: .docx favorece levemente 'trabalho' (bônus pequeno, nunca decide sozinho).
  const ehDocx = /\.docx$/i.test(name);

  if (!candidatos.length) {
    return { tipo: TIPO_FALLBACK, confianca: 0, origem: ORIGEM.HEURISTICA, pistas: [] };
  }

  // Aplica o bônus de .docx ao candidato 'trabalho', se existir.
  if (ehDocx) {
    const t = candidatos.find((c) => c.tipo === 'trabalho');
    if (t) t.confianca = Math.min(1.0, t.confianca + 0.05);
  }

  // Escolhe por PRIORIDADE fixa; empate de prioridade -> maior confiança.
  candidatos.sort((a, b) => {
    const dp = (PRIORIDADE[b.tipo] || 0) - (PRIORIDADE[a.tipo] || 0);
    if (dp !== 0) return dp;
    return b.confianca - a.confianca;
  });
  const escolhido = candidatos[0];

  // Pistas (para a UI/depuração): tipos que casaram, na ordem de prioridade.
  const pistas = candidatos.map((c) => c.tipo);

  return {
    tipo: escolhido.tipo,
    confianca: Math.max(0, Math.min(1, escolhido.confianca)),
    origem: ORIGEM.HEURISTICA,
    pistas,
  };
}

// ===========================================================================
// NÚCLEO — escalada para IA sob demanda (RF3)
// ===========================================================================

// Monta o prompt de UM lote de tipos. PT-BR, numera por índice LOCAL 0..n-1,
// pede JSON { "arquivos":[{ "id":0, "tipo":"prova" }] }, instrui NÃO inventar.
function buildPromptTipo(signalsLote) {
  const linhas = signalsLote.map((s, i) => {
    const pasta = core.primeiroNivel(s.relPath) || '(raiz)';
    const trecho = (s.snippet || '').replace(/\s+/g, ' ').trim();
    return `${i}) nome: ${s.name} | pasta: ${pasta} | trecho: "${trecho}"`;
  });

  return `Você é um organizador de material de estudo. Para cada arquivo abaixo, diga qual é o TIPO do material.

Escolha SOMENTE um destes tipos para cada arquivo: ${TIPOS.join(', ')}.
- "aula": material de estudo/apresentação (aula, slides, apostila, resumo, notas, capítulo).
- "lista": lista de exercícios, questões ou problemas para praticar.
- "prova": avaliação, prova, P1/P2, exame, teste ou gabarito.
- "trabalho": trabalho, atividade de entrega, relatório, projeto ou seminário.
- "outro": quando não encaixa em nenhum dos acima.

Não invente. Baseie-se só no nome, na pasta e no trecho. Cada arquivo tem um índice (id).

ARQUIVOS:
${linhas.join('\n')}

Responda SOMENTE com JSON válido, sem texto antes ou depois, exatamente neste formato:
{ "arquivos": [ { "id": 0, "tipo": "prova" } ] }`;
}

// Parse defensivo da resposta de UM lote. Mapeia id -> signalsLote[id].path
// LOCALMENTE. JSON inválido / id fora de range / tipo inválido / campo ausente
// -> aquele arquivo cai para 'outro', sem throw (critério 9).
// Retorna [{ path, tipo }].
function parseTipoResponse(rawText, signalsLote) {
  const n = signalsLote.length;
  const tipoPorIndice = new Array(n).fill(TIPO_FALLBACK);

  let parsed = null;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = null;
  }

  const arquivos = parsed && Array.isArray(parsed.arquivos) ? parsed.arquivos : [];
  for (const item of arquivos) {
    if (!item || typeof item !== 'object') continue;
    const id = item.id;
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || id >= n) continue;
    const tipo = typeof item.tipo === 'string' && TIPOS.includes(item.tipo.trim())
      ? item.tipo.trim()
      : TIPO_FALLBACK;
    tipoPorIndice[id] = tipo;
  }

  return signalsLote.map((s, i) => ({ path: s.path, tipo: tipoPorIndice[i] }));
}

// Classifica os sinais ambíguos chamando a IA em lotes.
// callGenerate: (prompt) => Promise<{ ok, text } | { ok:false, error }> (injetado)
// onProgress: (p) => void  (p = { phase:'classify', current, total, name })
// signal: AbortSignal opcional (cancelamento entre lotes).
// Sucesso -> { ok:true, porPath:{ [path]: { tipo, origem:'ia' } } }
// 1º lote offline -> { ok:false, error } (nada classificado — fatal controlado).
async function classificarComIA(signalsAmbiguos, { callGenerate, onProgress, signal } = {}) {
  const lotes = core.chunkSignals(signalsAmbiguos || []);
  const total = lotes.length;
  const porPath = {};

  for (let i = 0; i < lotes.length; i++) {
    if (signal && signal.aborted) break;
    const lote = lotes[i];
    if (onProgress) {
      const nome = (lote[0] && lote[0].name) || `lote ${i + 1}`;
      onProgress({ phase: 'classify', current: i + 1, total, name: nome });
    }

    let res;
    try {
      res = await callGenerate(buildPromptTipo(lote));
    } catch (e) {
      res = { ok: false, error: (e && e.message) || 'falha' };
    }

    // 1º lote offline => fatal: aborta sem classificar nada.
    if (i === 0 && core.isOllamaOffline(res)) {
      return { ok: false, error: res.error };
    }

    let doLote;
    if (res && res.ok && typeof res.text === 'string') {
      doLote = parseTipoResponse(res.text, lote);
    } else {
      // Offline após o 1º lote / erro / timeout: recuperável -> lote vira 'outro'.
      doLote = lote.map((s) => ({ path: s.path, tipo: TIPO_FALLBACK }));
    }
    for (const c of doLote) {
      porPath[c.path] = { tipo: c.tipo, origem: ORIGEM.IA };
    }
  }

  return { ok: true, porPath };
}

// ===========================================================================
// NÚCLEO — persistência (shape) e storeKey (puro, só crypto)
// ===========================================================================

// storeKey LOCAL a classification.js (prefixo próprio 'classification::').
// NÃO reusa grouping.storeKey (que vive no módulo que carrega ./store).
function storeKey(rootFolder) {
  const hash = crypto.createHash('sha1').update(String(rootFolder)).digest('hex').slice(0, 12);
  return `classification::${hash}`;
}

function estadoVazio(rootFolder) {
  return { version: 1, rootFolder, generatedAt: 0, fileSignatures: {}, arquivos: {} };
}

// ===========================================================================
// NÚCLEO — incremental via fileSignatures (RF5), merge e manual (RF6/RF7)
// ===========================================================================

// diffClassification(state, scannedFiles) ->
//   { novos:[file], removidos:[path], inalterados:[path], mudadosManuais:[path] }
// Padrão do grouping: assinatura é `path -> mtime` (float, NÃO arredondado).
function diffClassification(state, scannedFiles) {
  const sigs = (state && state.fileSignatures) || {};
  const reg = (state && state.arquivos) || {};
  const novos = [];
  const inalterados = [];
  const mudadosManuais = [];
  const vistos = new Set();

  for (const f of scannedFiles || []) {
    vistos.add(f.path);
    const assinado = sigs[f.path];
    const mudou = assinado === undefined || assinado !== (f.mtime || 0);
    const ehManual = reg[f.path] && reg[f.path].origem === ORIGEM.MANUAL;
    if (!mudou) {
      inalterados.push(f.path);
    } else if (ehManual) {
      // Arquivo manual que mudou no disco: mantém o tipo, sinaliza (RF7).
      mudadosManuais.push(f.path);
    } else {
      novos.push(f);
    }
  }

  const removidos = Object.keys(sigs).filter((p) => !vistos.has(p));
  return { novos, removidos, inalterados, mudadosManuais };
}

// Aplica heurística+IA só nos novos; NUNCA sobrescreve origem:'manual' (critério 16).
// porPathNovo: { [path]: { tipo, origem, confianca? } } (imutável).
function mergeResultados(state, porPathNovo) {
  const arquivos = Object.assign({}, (state && state.arquivos) || {});
  for (const path of Object.keys(porPathNovo || {})) {
    const atual = arquivos[path];
    if (atual && atual.origem === ORIGEM.MANUAL) continue; // manual tem prioridade
    const novo = porPathNovo[path];
    arquivos[path] = {
      tipo: novo.tipo,
      origem: novo.origem,
      confianca: typeof novo.confianca === 'number' ? novo.confianca : 0,
      mudouDesdeManual: false,
    };
  }
  return Object.assign({}, state, { arquivos });
}

// Remove de 'arquivos' e 'fileSignatures' os paths que sumiram do disco (critério 12).
function pruneRemovidos(state, removidos) {
  const set = new Set(removidos || []);
  const arquivos = Object.assign({}, (state && state.arquivos) || {});
  const sigs = Object.assign({}, (state && state.fileSignatures) || {});
  for (const p of set) {
    delete arquivos[p];
    delete sigs[p];
  }
  return Object.assign({}, state, { arquivos, fileSignatures: sigs });
}

// Marca arquivos manuais cuja assinatura mudou, SEM alterar o tipo (RF7/critério 18).
function marcarMudadosManuais(state, mudadosManuais) {
  if (!mudadosManuais || !mudadosManuais.length) return state;
  const arquivos = Object.assign({}, (state && state.arquivos) || {});
  for (const p of mudadosManuais) {
    if (arquivos[p]) {
      arquivos[p] = Object.assign({}, arquivos[p], { mudouDesdeManual: true });
    }
  }
  return Object.assign({}, state, { arquivos });
}

// Reescreve fileSignatures (float, padrão grouping) e seta generatedAt.
// É a ÚNICA função que seta generatedAt.
function refreshSignatures(state, scannedFiles) {
  const sigs = {};
  for (const f of scannedFiles || []) {
    sigs[f.path] = f.mtime || 0;
  }
  return Object.assign({}, state, { fileSignatures: sigs, generatedAt: Date.now() });
}

// Força o tipo de um arquivo manualmente (prioridade e persistência — RF6).
// setManual(state, path, tipo) -> { ok, state } | { ok:false, error }
function setManual(state, path, tipo) {
  if (!TIPOS.includes(tipo)) {
    return { ok: false, error: 'Tipo inválido.' };
  }
  const arquivos = Object.assign({}, (state && state.arquivos) || {});
  arquivos[path] = { tipo, origem: ORIGEM.MANUAL, confianca: 1.0, mudouDesdeManual: false };
  return { ok: true, state: Object.assign({}, state, { arquivos }) };
}

// Descarta a correção manual (volta para automático na próxima run) — RF7/critério 18.
function clearManual(state, path) {
  const arquivos = Object.assign({}, (state && state.arquivos) || {});
  delete arquivos[path];
  return Object.assign({}, state, { arquivos });
}

// ===========================================================================
// ORQUESTRAÇÃO (camada de I/O, roda no main) — RF9/RF12/RNF2
// ===========================================================================

// runClassification({ rootFolder, scannedFiles, readText, callGenerate,
//   onProgress, signal, fromScratch })
//   -> { ok:true, state, classificados, pendentes, cancelado } | { ok:false, error }
async function runClassification({
  rootFolder,
  scannedFiles,
  readText,
  callGenerate,
  onProgress,
  signal,
  fromScratch,
} = {}) {
  // 1) Estado de partida (incremental por padrão).
  let state = fromScratch
    ? estadoVazio(rootFolder)
    : (loadState(rootFolder) || estadoVazio(rootFolder));

  // 2) Diff + expurgo de removidos + marcação de manuais que mudaram.
  const diff = diffClassification(state, scannedFiles || []);
  state = pruneRemovidos(state, diff.removidos);
  state = marcarMudadosManuais(state, diff.mudadosManuais);

  // 3) Heurística nos novos (leitura SOB DEMANDA, um por vez).
  const porPathHeuristica = {};
  const ambiguos = [];
  const total = (diff.novos || []).length;
  let current = 0;
  let cancelado = false;

  for (const file of diff.novos || []) {
    if (signal && signal.aborted) { cancelado = true; break; }
    current += 1;

    let texto = '';
    try {
      const r = await readText(file.path);
      if (r && r.ok && typeof r.text === 'string') texto = r.text;
    } catch {
      texto = '';
    }

    const relPath = core.relPathOf(file.path, rootFolder);
    const sinal = {
      path: file.path,
      name: core.basenameOf(relPath),
      relPath,
      snippet: core.truncatePalavras(texto, SNIPPET_PALAVRAS),
    };
    texto = ''; // deixa o texto sair de escopo antes do próximo arquivo (memória)

    const h = classificarHeuristica(sinal);
    porPathHeuristica[file.path] = { tipo: h.tipo, origem: h.origem, confianca: h.confianca };
    if (h.confianca < LIMIAR_CONFIANCA_IA) {
      ambiguos.push(sinal);
    }

    if (onProgress) {
      onProgress({ phase: 'classify', current, total, name: file.name });
    }
  }

  // 4) IA só nos ambíguos (quando não cancelado antes de chegar aqui).
  let porPathIA = {};
  if (ambiguos.length && !(signal && signal.aborted)) {
    const resIA = await classificarComIA(ambiguos, { callGenerate, onProgress, signal });
    if (resIA.ok === false) {
      // Offline no 1º lote: fatal controlado -> NÃO salva (estado prévio intacto).
      return { ok: false, error: resIA.error };
    }
    porPathIA = resIA.porPath || {};
  }

  // 5) Junta heurística dos confiantes + IA dos ambíguos. A IA tem precedência
  //    para os paths ambíguos (que também estão na heurística com baixa confiança).
  const porPathNovo = Object.assign({}, porPathHeuristica, porPathIA);
  state = mergeResultados(state, porPathNovo);

  // 6) Assinaturas sobre o conjunto atual + persistência. Mesmo cancelado, salva
  //    o progresso parcial (os classificados têm assinatura; a próxima run é
  //    incremental e completa o resto — critério 20). Preserva assinaturas de
  //    arquivos ainda não classificados? Não: refreshSignatures assina TODOS os
  //    scannedFiles, mas só os classificados estão em 'arquivos'. Em cancelamento,
  //    assinamos só os já processados para que os pendentes voltem como 'novos'.
  const assinados = cancelado
    ? (scannedFiles || []).filter((f) => state.arquivos[f.path])
    : (scannedFiles || []);
  state = refreshSignatures(state, assinados);
  saveState(state);

  // 7) Pendentes: arquivos sem registro ou que caíram em 'outro' por falha de leitura/IA.
  const classificados = Object.keys(state.arquivos || {}).length;
  const pendentes = (scannedFiles || [])
    .filter((f) => !state.arquivos[f.path])
    .map((f) => f.path);

  return { ok: true, state, classificados, pendentes, cancelado };
}

// ===========================================================================
// CAMADA DE PERSISTÊNCIA (classStore) — grava SÓ em userData via ./store.
// Importado só AQUI (fim do arquivo), nunca no núcleo. (RF8, INV4.)
// ===========================================================================

const store = require('./store');

function loadState(rootFolder) {
  return store.get(storeKey(rootFolder)) || null;
}

function saveState(state) {
  return store.set(storeKey(state.rootFolder), state);
}

function clearState(rootFolder) {
  // store.js não tem delete; gravar null equivale a "ainda não classificado".
  return store.set(storeKey(rootFolder), null);
}

module.exports = {
  // constantes
  TIPOS,
  TIPO_FALLBACK,
  ORIGEM,
  LIMIAR_CONFIANCA_IA,
  SNIPPET_PALAVRAS,
  PRIORIDADE,
  // heurística
  classificarHeuristica,
  // IA
  buildPromptTipo,
  parseTipoResponse,
  classificarComIA,
  // persistência (chave/estado)
  storeKey,
  estadoVazio,
  // incremental / merge / manual
  diffClassification,
  mergeResultados,
  pruneRemovidos,
  marcarMudadosManuais,
  refreshSignatures,
  setManual,
  clearManual,
  // orquestração
  runClassification,
  // classStore
  loadState,
  saveState,
  clearState,
};
