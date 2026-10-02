#!/usr/bin/env node
'use strict';

/**
 * Teste do NÚCLEO de classificação por tipo (src/services/classification.js),
 * script node puro sem framework (padrão de tests/testar-grouping.js).
 *
 * NÃO precisa de Ollama: callGenerate é injetado/mockado de forma
 * determinística. A persistência (loadState/saveState) é testada de ponta a
 * ponta porque store.js cai numa pasta temp fora do Electron.
 *
 * O electron é mockado ANTES de qualquer require de módulo do app.
 */

// ---- Mock de electron ANTES de qualquer require do app (padrão do projeto) ----
const Module = require('module');
const orig = Module._load;
Module._load = function (req) {
  if (req === 'electron') return { app: { isPackaged: false, getPath: () => require('os').tmpdir() } };
  return orig.apply(this, arguments);
};

const fs = require('fs');
const os = require('os');
const path = require('path');

const classification = require('../src/services/classification');
const groupingCore = require('../src/services/grouping-core');

// ------------------------------- mini-harness -------------------------------
let passes = 0;
let falhas = 0;
const problemas = [];

function ok(cond, msg) {
  if (cond) { passes += 1; }
  else { falhas += 1; problemas.push(msg); console.log('  ❌ ' + msg); }
}
function eq(a, b, msg) {
  ok(a === b, `${msg} (esperado ${JSON.stringify(b)}, obtido ${JSON.stringify(a)})`);
}

const ROOT = 'C:\\Users\\teste\\faculdade';

// Monta um sinal como a orquestração faz (name/relPath via core, snippet cru em 60).
function sinal(relAbs, texto) {
  const abs = ROOT + '\\' + relAbs.replace(/\//g, '\\');
  const relPath = groupingCore.relPathOf(abs, ROOT);
  return {
    path: abs,
    name: groupingCore.basenameOf(relPath),
    relPath,
    snippet: groupingCore.truncatePalavras(texto || '', classification.SNIPPET_PALAVRAS),
  };
}

// ===========================================================================
// 1) Heurística por tipo (critérios 1–4) — sem acionar IA
// ===========================================================================
console.log('\n== Heurística por tipo ==');
(() => {
  const prova = classification.classificarHeuristica(sinal('Prova_2_Calculo.pdf', ''));
  eq(prova.tipo, 'prova', 'Prova_2_Calculo.pdf -> prova');
  ok(prova.confianca >= classification.LIMIAR_CONFIANCA_IA, 'prova com confiança alta (>= limiar)');
  eq(prova.origem, 'heuristica', 'origem heuristica');

  eq(classification.classificarHeuristica(sinal('lista-exercicios-03.pdf', '')).tipo, 'lista', 'lista-exercicios-03.pdf -> lista');
  eq(classification.classificarHeuristica(sinal('trabalho-final-grupo.docx', '')).tipo, 'trabalho', 'trabalho-final-grupo.docx -> trabalho');
  eq(classification.classificarHeuristica(sinal('aula-05-slides.pdf', '')).tipo, 'aula', 'aula-05-slides.pdf -> aula');
  eq(classification.classificarHeuristica(sinal('apostila.md', '')).tipo, 'aula', 'apostila.md -> aula');

  // Desempate por prioridade: nome com "prova" e "lista" -> prova.
  eq(classification.classificarHeuristica(sinal('prova-lista.pdf', '')).tipo, 'prova', 'prova-lista.pdf -> prova (prioridade)');
})();

// ===========================================================================
// 2) Fallback 'outro' + nunca null (critério 6) + match só no snippet
// ===========================================================================
console.log('\n== Fallback / snippet ==');
(() => {
  const generico = classification.classificarHeuristica(sinal('documento1.pdf', 'texto qualquer sem pistas'));
  eq(generico.tipo, 'outro', 'documento1.pdf sem pista -> outro');
  eq(generico.confianca, 0, 'confiança 0 sem pista');
  ok(generico.confianca < classification.LIMIAR_CONFIANCA_IA, 'ambíguo (abaixo do limiar) -> vai à IA');
  ok(generico.tipo !== null && generico.tipo !== undefined, 'nunca null/undefined');

  // Match só no snippet: confiança menor que match forte, mas não vazio.
  const soSnippet = classification.classificarHeuristica(sinal('arquivo-x.txt', 'Esta é a prova final da disciplina'));
  eq(soSnippet.tipo, 'prova', 'match no snippet detecta prova');
  ok(soSnippet.confianca > 0, 'match no snippet tem confiança > 0');
})();

// ===========================================================================
// 3) Núcleo puro (critério 7): grouping-core só crypto; classification sem fs/grouping/store
// ===========================================================================
console.log('\n== Núcleo puro (imports) ==');
(() => {
  // grouping-core carrega sem Electron e sem tocar fs (acabou de ser importado acima).
  ok(typeof groupingCore.relPathOf === 'function', 'grouping-core carregou (só crypto)');

  const srcClass = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'classification.js'), 'utf-8');
  // O núcleo de classification NÃO importa ./grouping nem fs/path/os.
  ok(!/require\(['"]\.\/grouping['"]\)/.test(srcClass), "classification.js não faz require('./grouping')");
  ok(!/require\(['"]fs['"]\)/.test(srcClass), "classification.js não faz require('fs')");
  ok(!/require\(['"]path['"]\)/.test(srcClass), "classification.js não faz require('path')");
  ok(!/require\(['"]os['"]\)/.test(srcClass), "classification.js não faz require('os')");

  const srcCore = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'grouping-core.js'), 'utf-8');
  ok(!/require\(['"]\.\/store['"]\)/.test(srcCore), "grouping-core.js não faz require('./store')");
  ok(!/require\(['"]fs['"]\)/.test(srcCore), "grouping-core.js não faz require('fs')");

  // A heurística roda sem callGenerate.
  ok(classification.classificarHeuristica(sinal('aula.pdf', '')).tipo === 'aula', 'heurística roda sem callGenerate');
})();

// ===========================================================================
// 4) Determinismo (critério 8)
// ===========================================================================
console.log('\n== Determinismo ==');
(() => {
  const s = sinal('documento-sem-pista.pdf', 'conteúdo neutro');
  const a = classification.classificarHeuristica(s);
  const b = classification.classificarHeuristica(s);
  eq(JSON.stringify(a), JSON.stringify(b), 'mesma entrada -> saída idêntica');
})();

// ===========================================================================
// 5) Parse defensivo (critério 9)
// ===========================================================================
console.log('\n== Parse defensivo da IA ==');
(() => {
  const lote = [sinal('a.pdf', ''), sinal('b.pdf', '')];
  // JSON inválido -> tudo 'outro', sem throw.
  let r;
  try { r = classification.parseTipoResponse('not json', lote); } catch (e) { r = null; }
  ok(Array.isArray(r) && r.every((x) => x.tipo === 'outro'), 'JSON inválido -> outro, sem throw');

  // id fora de range + tipo inválido + campo ausente.
  const raw = JSON.stringify({ arquivos: [
    { id: 0, tipo: 'prova' },         // válido
    { id: 9, tipo: 'lista' },         // id fora de range -> ignorado
    { id: 1, tipo: 'inexistente' },   // tipo inválido -> outro
  ] });
  const r2 = classification.parseTipoResponse(raw, lote);
  eq(r2[0].tipo, 'prova', 'id 0 válido -> prova');
  eq(r2[1].tipo, 'outro', 'id 1 tipo inválido -> outro');
})();

// ===========================================================================
// 6) Incremental (critérios 10–12) + assinatura float não arredondada (NIT-2)
// ===========================================================================
console.log('\n== Incremental / assinatura float ==');
(() => {
  const files = [
    { path: ROOT + '\\a.pdf', mtime: 1710000000123.456, size: 10 },
    { path: ROOT + '\\b.pdf', mtime: 2000.0, size: 20 },
  ];
  let state = classification.estadoVazio(ROOT);
  // Simula uma classificação prévia marcando os dois arquivos.
  state = classification.mergeResultados(state, {
    [files[0].path]: { tipo: 'prova', origem: 'heuristica', confianca: 1 },
    [files[1].path]: { tipo: 'aula', origem: 'heuristica', confianca: 0.7 },
  });
  state = classification.refreshSignatures(state, files);

  // Assinatura float NÃO arredondada.
  eq(state.fileSignatures[files[0].path], 1710000000123.456, 'assinatura float preservada (não arredondada)');

  // 2ª run sem mudança -> novos vazio.
  const d1 = classification.diffClassification(state, files);
  eq(d1.novos.length, 0, 'sem mudança -> nenhum novo (critério 10)');

  // Mudar mtime de 1 arquivo -> só ele em novos.
  const files2 = [files[0], { path: files[1].path, mtime: 3000.0, size: 20 }];
  const d2 = classification.diffClassification(state, files2);
  eq(d2.novos.length, 1, 'só o alterado em novos (critério 11)');
  eq(d2.novos[0].path, files[1].path, 'o alterado é b.pdf');

  // Remover arquivo -> removidos + prune expurga.
  const files3 = [files[0]];
  const d3 = classification.diffClassification(state, files3);
  ok(d3.removidos.includes(files[1].path), 'b.pdf em removidos (critério 12)');
  const pruned = classification.pruneRemovidos(state, d3.removidos);
  ok(!pruned.arquivos[files[1].path], 'b.pdf expurgado de arquivos');
  ok(!pruned.fileSignatures[files[1].path], 'b.pdf expurgado de fileSignatures');
})();

// ===========================================================================
// 7) Chaveamento por rootFolder (critério 14)
// ===========================================================================
console.log('\n== Chaveamento ==');
(() => {
  const k1 = classification.storeKey('C:\\pastaA');
  const k2 = classification.storeKey('C:\\pastaB');
  ok(k1 !== k2, 'roots distintos -> storeKey distinto');
  ok(k1.startsWith('classification::'), "prefixo 'classification::'");
})();

// ===========================================================================
// 8) Correção manual (critérios 15–18) + persistência
// ===========================================================================
console.log('\n== Correção manual ==');
(() => {
  const p = ROOT + '\\manual.pdf';
  let state = classification.estadoVazio(ROOT);
  const r = classification.setManual(state, p, 'prova');
  ok(r.ok, 'setManual ok');
  eq(r.state.arquivos[p].origem, 'manual', 'origem manual (critério 15)');
  eq(r.state.arquivos[p].tipo, 'prova', 'tipo prova');
  state = r.state;

  // setManual com tipo inválido -> erro.
  ok(classification.setManual(state, p, 'xpto').ok === false, 'tipo inválido rejeitado');

  // mergeResultados NÃO altera manual (critério 16).
  const merged = classification.mergeResultados(state, { [p]: { tipo: 'aula', origem: 'ia', confianca: 1 } });
  eq(merged.arquivos[p].tipo, 'prova', 'reclassificação automática não altera manual');
  eq(merged.arquivos[p].origem, 'manual', 'origem continua manual');

  // Persistência: salva e relê (reinício simulado) — critério 17.
  classification.saveState(state);
  const relido = classification.loadState(ROOT);
  eq(relido.arquivos[p].origem, 'manual', 'manual sobrevive a reinício (relê de store)');

  // Arquivo manual que muda no disco: diff -> mudadosManuais; mantém tipo (critério 18).
  const sWithSig = classification.refreshSignatures(state, [{ path: p, mtime: 100.0 }]);
  const d = classification.diffClassification(sWithSig, [{ path: p, mtime: 200.0 }]);
  ok(d.mudadosManuais.includes(p), 'manual alterado -> mudadosManuais (não novos)');
  eq(d.novos.length, 0, 'manual alterado não entra em novos');
  const marcado = classification.marcarMudadosManuais(sWithSig, d.mudadosManuais);
  eq(marcado.arquivos[p].mudouDesdeManual, true, 'mudouDesdeManual = true');
  eq(marcado.arquivos[p].tipo, 'prova', 'tipo manual mantido');

  // clearManual descarta.
  const limpo = classification.clearManual(state, p);
  ok(!limpo.arquivos[p], 'clearManual remove o registro');

  // Limpa a chave do store para não vazar entre execuções do teste.
  classification.clearState(ROOT);
})();

// ===========================================================================
// 9) classificarComIA: progresso crescente, offline no 1º lote, recuperável depois
// ===========================================================================
console.log('\n== IA: progresso / offline ==');
(async () => {
  const ambiguos = [sinal('x1.pdf', ''), sinal('x2.pdf', '')];

  // Progresso: current cresce até total.
  const eventos = [];
  const mockOk = async () => ({ ok: true, text: JSON.stringify({ arquivos: [{ id: 0, tipo: 'prova' }] }) });
  const r = await classification.classificarComIA(ambiguos, {
    callGenerate: mockOk,
    onProgress: (p) => eventos.push(p),
  });
  ok(r.ok, 'classificarComIA ok');
  ok(eventos.length > 0 && eventos[eventos.length - 1].current === eventos[eventos.length - 1].total, 'progresso current chega a total (critério 19)');

  // Offline no 1º lote -> fatal.
  const mockOffline = async () => ({ ok: false, error: 'Ollama não está rodando. Abra o Ollama.' });
  const rOff = await classification.classificarComIA(ambiguos, { callGenerate: mockOffline });
  ok(rOff.ok === false, 'offline no 1º lote -> fatal (critério 22)');

  // Erro genérico (não offline) -> recuperável (lote vira outro).
  const mockErr = async () => ({ ok: false, error: 'timeout' });
  const rErr = await classification.classificarComIA(ambiguos, { callGenerate: mockErr });
  ok(rErr.ok === true && Object.values(rErr.porPath).every((v) => v.tipo === 'outro'), 'erro recuperável -> outro');

  await testarRunClassification();
  await testarInvarianteSagrada();
  finalizar();
})();

// ===========================================================================
// 10) runClassification: progresso, cancelamento, pendentes
// ===========================================================================
async function testarRunClassification() {
  console.log('\n== runClassification ==');
  const root = path.join(os.tmpdir(), 'cabulia-test-run-' + Date.now());
  classification.clearState(root);

  const scanned = [
    { path: root + '\\Prova_1.pdf', mtime: 100.0, name: 'Prova_1.pdf' },
    { path: root + '\\documento-neutro.pdf', mtime: 200.0, name: 'documento-neutro.pdf' },
  ];
  // readText: Prova_1 forte na heurística; documento-neutro ambíguo -> IA.
  const readText = async (p) => ({ ok: true, text: p.includes('neutro') ? 'conteudo sem pista' : 'prova' });
  const callGenerate = async () => ({ ok: true, text: JSON.stringify({ arquivos: [{ id: 0, tipo: 'lista' }] }) });

  const eventos = [];
  const r = await classification.runClassification({
    rootFolder: root, scannedFiles: scanned, readText, callGenerate,
    onProgress: (p) => eventos.push(p), fromScratch: true,
  });
  ok(r.ok, 'runClassification ok');
  eq(r.state.arquivos[scanned[0].path].tipo, 'prova', 'Prova_1.pdf -> prova (heurística)');
  eq(r.state.arquivos[scanned[1].path].tipo, 'lista', 'documento-neutro -> lista (via IA mock)');
  ok(eventos.some((e) => e.phase === 'classify'), 'emitiu progresso phase classify');

  // 2ª run incremental sem mudança -> nada novo (idempotente).
  const r2 = await classification.runClassification({
    rootFolder: root, scannedFiles: scanned, readText, callGenerate, fromScratch: false,
  });
  ok(r2.ok, '2ª run ok');
  eq(JSON.stringify(r2.state.arquivos), JSON.stringify(r.state.arquivos), '2ª run idêntica (critério 10)');

  // Cancelamento: signal já abortado -> salva parcial, cancelado:true, incremental depois.
  classification.clearState(root);
  const abortado = { aborted: true };
  const rc = await classification.runClassification({
    rootFolder: root, scannedFiles: scanned, readText, callGenerate,
    signal: abortado, fromScratch: true,
  });
  ok(rc.ok && rc.cancelado === true, 'cancelado salva parcial e marca cancelado (critério 20)');
  // Depois, sem abort, completa o que faltou.
  const rd = await classification.runClassification({
    rootFolder: root, scannedFiles: scanned, readText, callGenerate, fromScratch: false,
  });
  eq(Object.keys(rd.state.arquivos).length, 2, 'run subsequente completa os pendentes');

  classification.clearState(root);
}

// ===========================================================================
// 11) INVARIANTE SAGRADA (critério 13): nenhum arquivo da pasta de estudos é tocado
// ===========================================================================
async function testarInvarianteSagrada() {
  console.log('\n== INVARIANTE SAGRADA (INV4) ==');
  const fixture = path.join(os.tmpdir(), 'cabulia-fixture-' + Date.now());
  fs.mkdirSync(fixture, { recursive: true });
  // Arquivos de estudo falsos.
  const arqs = {
    'Prova_Calculo.txt': 'conteudo de prova',
    'lista-exercicios.txt': 'lista de exercicios',
    'documento-neutro.txt': 'texto generico sem pistas claras',
  };
  for (const [nome, txt] of Object.entries(arqs)) {
    fs.writeFileSync(path.join(fixture, nome), txt, 'utf-8');
  }

  // Snapshot ANTES.
  const snapshot = (dir) => {
    const out = {};
    for (const nome of fs.readdirSync(dir)) {
      const st = fs.statSync(path.join(dir, nome));
      out[nome] = { size: st.size, mtime: st.mtimeMs };
    }
    return out;
  };
  const antes = snapshot(fixture);

  const scanned = Object.keys(arqs).map((nome) => {
    const p = path.join(fixture, nome);
    return { path: p, mtime: fs.statSync(p).mtimeMs, name: nome };
  });
  // readText real lendo os fixtures (SÓ LEITURA); callGenerate mockado.
  const readText = async (p) => {
    try { return { ok: true, text: fs.readFileSync(p, 'utf-8') }; }
    catch (e) { return { ok: false }; }
  };
  const callGenerate = async () => ({ ok: true, text: JSON.stringify({ arquivos: [{ id: 0, tipo: 'outro' }] }) });

  classification.clearState(fixture);
  const r = await classification.runClassification({
    rootFolder: fixture, scannedFiles: scanned, readText, callGenerate, fromScratch: true,
  });
  ok(r.ok, 'runClassification sobre fixture ok');

  // Snapshot DEPOIS: nenhum arquivo criado/alterado/removido na fixture.
  const depois = snapshot(fixture);
  eq(Object.keys(depois).length, Object.keys(antes).length, 'nenhum arquivo criado/removido na fixture');
  let intactos = true;
  for (const nome of Object.keys(antes)) {
    if (!depois[nome] || depois[nome].size !== antes[nome].size || depois[nome].mtime !== antes[nome].mtime) {
      intactos = false;
    }
  }
  ok(intactos, 'arquivos da fixture intactos (mesmo size/mtime) — INV4');

  // A escrita do estado foi no store (userData/tmp), não na fixture.
  const relido = classification.loadState(fixture);
  ok(relido && relido.arquivos, 'estado persistido no store (userData/tmp), fora da fixture');

  // Limpeza.
  classification.clearState(fixture);
  try { fs.rmSync(fixture, { recursive: true, force: true }); } catch {}
}

function finalizar() {
  console.log('\n============================');
  console.log(`Passes: ${passes} · Falhas: ${falhas}`);
  if (falhas === 0) {
    console.log('Todos os casos passaram. ✅');
    process.exit(0);
  } else {
    console.log('Falhas:');
    for (const p of problemas) console.log('  - ' + p);
    process.exit(1);
  }
}
