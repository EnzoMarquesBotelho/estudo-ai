#!/usr/bin/env node
'use strict';

/**
 * Teste do NÚCLEO de agrupamento (src/services/grouping.js), script node puro
 * sem framework (padrão de tests/testar-modelos.js).
 *
 * NÃO precisa de Ollama: callGenerate é injetado/mockado de forma
 * determinística. A persistência (loadMapping/saveMapping/clearMapping) é
 * testada de ponta a ponta porque store.js cai numa pasta temp fora do Electron.
 *
 * O electron é mockado ANTES de qualquer require de módulo do app (store.js
 * tenta require('electron')).
 */

// ---- Mock de electron ANTES de qualquer require do app (EXATAMENTE o padrão
//      exigido pelo context.json) ----
const Module = require('module');
const orig = Module._load;
Module._load = function (req) {
  if (req === 'electron') return { app: { isPackaged: false, getPath: () => require('os').tmpdir() } };
  return orig.apply(this, arguments);
};

const grouping = require('../src/services/grouping');

// ------------------------------- mini-harness -------------------------------
let passes = 0;
let falhas = 0;
const problemas = [];

function ok(cond, msg) {
  if (cond) {
    passes += 1;
  } else {
    falhas += 1;
    problemas.push(msg);
    console.log('  ❌ ' + msg);
  }
}

function eq(a, b, msg) {
  ok(a === b, `${msg} (esperado ${JSON.stringify(b)}, obtido ${JSON.stringify(a)})`);
}

function throwsNot(fn, msg) {
  try { fn(); passes += 1; } catch (e) { falhas += 1; problemas.push(`${msg}: ${e.message}`); console.log('  ❌ ' + msg + ': ' + e.message); }
}

const ROOT = 'C:\\Users\\teste\\faculdade';

// ===========================================================================
// 1) Montagem de sinais
// ===========================================================================
console.log('\n== Sinais / relPath / primeiroNivel ==');
(() => {
  // relPathOf: separador \ do Windows normalizado; root com e sem separador final.
  eq(grouping.relPathOf('C:\\Users\\teste\\faculdade\\Cálculo\\lim.pdf', ROOT), 'Cálculo/lim.pdf', 'relPathOf subpasta');
  eq(grouping.relPathOf('C:\\Users\\teste\\faculdade\\solto.txt', ROOT), 'solto.txt', 'relPathOf raiz');
  eq(grouping.relPathOf('C:\\Users\\teste\\faculdade\\x.md', 'C:\\Users\\teste\\faculdade\\'), 'x.md', 'relPathOf root com sep final');

  // primeiroNivel: subpasta vs raiz.
  eq(grouping.primeiroNivel('Cálculo/lim.pdf'), 'Cálculo', 'primeiroNivel subpasta');
  eq(grouping.primeiroNivel('solto.txt'), null, 'primeiroNivel raiz -> null');

  eq(grouping.basenameOf('Cálculo/lim.pdf'), 'lim.pdf', 'basenameOf');

  // truncatePalavras: corta em N palavras, não no meio.
  const texto = Array.from({ length: 300 }, (_, i) => 'p' + i).join(' ');
  const t150 = grouping.truncatePalavras(texto, 150);
  eq(t150.split(/\s+/).length, 150, 'truncatePalavras 150 palavras');
  ok(!t150.includes('p150'), 'truncatePalavras não inclui a 151ª palavra');

  // buildSignal: relPath, snippet, SEM ext.
  const f = { name: 'lim.pdf', path: 'C:\\Users\\teste\\faculdade\\Cálculo\\lim.pdf', mtime: 1, size: 10 };
  const sig = grouping.buildSignal(f, texto, ROOT);
  eq(sig.relPath, 'Cálculo/lim.pdf', 'buildSignal relPath');
  eq(sig.name, 'lim.pdf', 'buildSignal name');
  eq(sig.path, f.path, 'buildSignal path');
  ok(!('ext' in sig), 'buildSignal SEM ext');
  eq(sig.snippet.split(/\s+/).length, 150, 'buildSignal snippet 150 palavras');

  // buildSignals: texto vazio -> snippet ''.
  const sigs = grouping.buildSignals([f, { name: 'bin.dat', path: ROOT + '\\bin.dat', mtime: 2, size: 5 }], { [f.path]: texto }, ROOT);
  eq(sigs.length, 2, 'buildSignals quantidade');
  eq(sigs[1].snippet, '', 'buildSignals snippet vazio p/ texto ausente');
})();

// ===========================================================================
// 2) chunkSignals (dois tetos)
// ===========================================================================
console.log('\n== chunkSignals ==');
(() => {
  // Teto de arquivos: 20 arquivos pequenos -> >=2 lotes (teto 12).
  const pequenos = Array.from({ length: 20 }, (_, i) => ({ path: 'p' + i, name: 'n' + i, relPath: 'n' + i, snippet: 'abc' }));
  const lotes = grouping.chunkSignals(pequenos);
  ok(lotes.length >= 2, 'chunkSignals teto de arquivos gera >=2 lotes');
  ok(lotes.every((l) => l.length <= 12), 'chunkSignals nenhum lote > 12 arquivos');

  // Teto de chars: snippets grandes fecham por chars antes de 12 arquivos.
  const grandes = Array.from({ length: 6 }, (_, i) => ({ path: 'g' + i, name: 'g' + i, relPath: 'g' + i, snippet: 'x'.repeat(2500) }));
  const lotesG = grouping.chunkSignals(grandes);
  ok(lotesG.length >= 2, 'chunkSignals teto de chars gera >=2 lotes');
  ok(lotesG.every((l) => l.reduce((a, s) => a + s.snippet.length, 0) <= 6000 || l.length === 1), 'chunkSignals respeita teto de chars');

  // Arquivo gigante sozinho, snippet truncado.
  const comGigante = [
    { path: 'a', name: 'a', relPath: 'a', snippet: 'z'.repeat(100) },
    { path: 'big', name: 'big', relPath: 'big', snippet: 'y'.repeat(9000) },
    { path: 'b', name: 'b', relPath: 'b', snippet: 'w'.repeat(100) },
  ];
  const lotesGig = grouping.chunkSignals(comGigante);
  const loteBig = lotesGig.find((l) => l.length === 1 && l[0].path === 'big');
  ok(loteBig, 'chunkSignals arquivo gigante vai sozinho');
  eq(loteBig[0].snippet.length, 6000, 'chunkSignals snippet gigante truncado ao teto');
})();

// ===========================================================================
// 3) buildBatchPrompt / parseBatchResponse
// ===========================================================================
console.log('\n== buildBatchPrompt / parseBatchResponse ==');
(() => {
  const lote = [
    { path: 'C:\\r\\Cálculo\\lim.pdf', name: 'lim.pdf', relPath: 'Cálculo/lim.pdf', snippet: 'limites e derivadas' },
    { path: 'C:\\r\\notas.md', name: 'notas.md', relPath: 'notas.md', snippet: 'notas gerais' },
  ];
  const prompt = grouping.buildBatchPrompt(lote, { disciplinasConhecidas: ['História'] });
  ok(prompt.includes('0) nome: lim.pdf'), 'buildBatchPrompt índice 0');
  ok(prompt.includes('1) nome: notas.md'), 'buildBatchPrompt índice 1');
  ok(prompt.includes('História'), 'buildBatchPrompt inclui disciplinasConhecidas');
  ok(prompt.includes('(raiz)'), 'buildBatchPrompt marca arquivo na raiz');

  // Válido por índice -> mapeia id -> path local.
  const valido = grouping.parseBatchResponse('{ "arquivos": [ { "id":0, "disciplina":"Cálculo I" }, { "id":1, "disciplina":"Geral" } ] }', lote);
  eq(valido[0].path, lote[0].path, 'parse válido path 0');
  eq(valido[0].disciplina, 'Cálculo I', 'parse válido disc 0');
  eq(valido[1].disciplina, 'Geral', 'parse válido disc 1');

  // JSON inválido -> tudo "Não classificados".
  const invalido = grouping.parseBatchResponse('isto não é json', lote);
  ok(invalido.every((x) => x.disciplina === 'Não classificados'), 'parse inválido -> Não classificados');

  // Parcial: id 1 ausente -> fica "Não classificados".
  const parcial = grouping.parseBatchResponse('{ "arquivos": [ { "id":0, "disciplina":"Cálculo I" } ] }', lote);
  eq(parcial[0].disciplina, 'Cálculo I', 'parse parcial id 0 ok');
  eq(parcial[1].disciplina, 'Não classificados', 'parse parcial id 1 ausente -> Não classificados');

  // id fora de range / não-inteiro -> ignorados.
  const foraRange = grouping.parseBatchResponse('{ "arquivos": [ { "id":5, "disciplina":"X" }, { "id":1.5, "disciplina":"Y" } ] }', lote);
  ok(foraRange.every((x) => x.disciplina === 'Não classificados'), 'parse id fora de range / não-inteiro -> Não classificados');
})();

// ===========================================================================
// 4) classifyIntoDisciplinas (parse Ollama mockado -> disciplinas)
// ===========================================================================
console.log('\n== classifyIntoDisciplinas ==');
(async () => {
  const sigs = [
    { path: 'p0', name: 'a', relPath: 'a', snippet: 'calc' },
    { path: 'p1', name: 'b', relPath: 'b', snippet: 'calc2' },
    { path: 'p2', name: 'c', relPath: 'c', snippet: 'hist' },
  ];
  // callGenerate fake determinístico: classifica por índice no lote.
  // Normaliza nomes variando caixa/espaço para testar consolidação.
  const fake = async (prompt) => {
    // único lote (3 arquivos). Devolve "Cálculo", " cálculo " e "História".
    return { ok: true, text: JSON.stringify({ arquivos: [
      { id: 0, disciplina: 'Cálculo' },
      { id: 1, disciplina: '  cálculo  ' },
      { id: 2, disciplina: 'História' },
    ] }) };
  };
  const progresso = [];
  const res = await grouping.classifyIntoDisciplinas(sigs, { callGenerate: fake, onProgress: (p) => progresso.push(p), disciplinasConhecidas: [] });
  ok(res.ok, 'classify ok');
  // "Cálculo" e " cálculo " consolidam em 1 disciplina; "História" em outra.
  const calc = res.disciplinas.find((d) => d.nome === 'Cálculo');
  const hist = res.disciplinas.find((d) => d.nome === 'História');
  ok(calc && calc.arquivos.length === 2, 'classify consolida nomes equivalentes (2 arquivos em Cálculo)');
  ok(hist && hist.arquivos.length === 1, 'classify História com 1 arquivo');
  eq(res.disciplinas.length, 2, 'classify 2 disciplinas no total');
  ok(progresso.length >= 1 && progresso[0].phase === 'disciplinas', 'classify emite progresso phase disciplinas');
  eq(progresso[progresso.length - 1].total, progresso[0].total, 'classify total estável');

  // ---- Regra de erro: 1º lote offline -> fatal ----
  const fakeOffline = async () => ({ ok: false, error: 'Ollama não está rodando. Instale em https://ollama.com' });
  const resOff = await grouping.classifyIntoDisciplinas(sigs, { callGenerate: fakeOffline });
  eq(resOff.ok, false, 'classify 1º lote offline -> ok:false');
  ok(resOff.error && resOff.error.startsWith('Ollama não está rodando'), 'classify offline propaga erro');
  ok(!resOff.disciplinas, 'classify offline não classifica nada');

  // ---- Regra de erro: 500/timeout no 1º lote -> recuperável (Não classificados) ----
  const fake500 = async () => ({ ok: false, error: 'Ollama respondeu 500' });
  const res500 = await grouping.classifyIntoDisciplinas(sigs, { callGenerate: fake500 });
  ok(res500.ok, 'classify 500 no 1º lote -> run continua (ok:true)');
  const nc = res500.disciplinas.find((d) => d.id === grouping.ID_NAO_CLASSIFICADOS);
  ok(nc && nc.arquivos.length === 3, 'classify 500 -> todos em Não classificados');

  // isOllamaOffline isolado.
  ok(grouping.isOllamaOffline({ ok: false, error: 'Ollama não está rodando. etc' }), 'isOllamaOffline true no prefixo');
  ok(!grouping.isOllamaOffline({ ok: false, error: 'Ollama respondeu 500' }), 'isOllamaOffline false p/ outro erro');
  ok(!grouping.isOllamaOffline({ ok: true, text: 'x' }), 'isOllamaOffline false p/ sucesso');

  // ---- labelFromPorPasta ----
  console.log('\n== labelFromPorPasta ==');
  const sigsP = [
    { path: 'q0', name: 'a', relPath: 'Mat/a.pdf', snippet: '' },
    { path: 'q1', name: 'b', relPath: 'Mat/b.pdf', snippet: '' },
    { path: 'q2', name: 'c', relPath: 'raiz.txt', snippet: '' },
  ];
  const lp = grouping.labelFromPorPasta(sigsP);
  ok(lp.ok, 'labelFromPorPasta ok:true');
  const mat = lp.disciplinas.find((d) => d.nome === 'Mat');
  ok(mat && mat.arquivos.length === 2, 'labelFromPorPasta subpasta vira disciplina');
  const ncp = lp.disciplinas.find((d) => d.id === grouping.ID_NAO_CLASSIFICADOS);
  ok(ncp && ncp.arquivos.includes('q2'), 'labelFromPorPasta raiz -> Não classificados');

  // =========================================================================
  // 5) splitIntoTopicos / addTopicos (path ausente -> sinal degradado)
  // =========================================================================
  console.log('\n== splitIntoTopicos / addTopicos ==');
  const fakeTop = async (prompt) => {
    // Classifica por posição; vamos devolver dois tópicos.
    const m = prompt.match(/\n(\d+)\) nome:/g) || [];
    const arquivos = m.map((_, i) => ({ id: i, disciplina: i < 2 ? 'Tópico A' : 'Tópico B' }));
    return { ok: true, text: JSON.stringify({ arquivos }) };
  };

  // Disciplina com <3 arquivos -> sem tópicos.
  const topVazio = await grouping.splitIntoTopicos({ id: 'd1', nome: 'X', arquivos: ['a', 'b'] }, {}, { callGenerate: fakeTop, root: ROOT });
  eq(topVazio.length, 0, 'splitIntoTopicos <3 arquivos -> []');

  // Disciplina com arquivos; um path ausente em signalsByPath -> sinal degradado.
  const antigoPath = 'C:\\Users\\teste\\faculdade\\Hist\\antigo.pdf';
  const signalsByPath = {
    n1: { path: 'n1', name: 'n1', relPath: 'n1', snippet: 'texto1' },
    n2: { path: 'n2', name: 'n2', relPath: 'n2', snippet: 'texto2' },
    n3: { path: 'n3', name: 'n3', relPath: 'n3', snippet: 'texto3' },
  };
  const disc = { id: 'd2', nome: 'Hist', arquivos: ['n1', 'n2', 'n3', antigoPath] };
  const tops = await grouping.splitIntoTopicos(disc, signalsByPath, { callGenerate: fakeTop, root: ROOT });
  const todosNosTopicos = tops.reduce((a, t) => a.concat(t.arquivos), []);
  ok(todosNosTopicos.includes(antigoPath), 'splitIntoTopicos arquivo antigo (path ausente) NÃO é perdido');
  ok(tops.length >= 1, 'splitIntoTopicos gera tópicos');

  // addTopicos: progresso ANTES de cada disciplina, inclusive puladas por <3.
  const mapping = {
    rootFolder: ROOT,
    mode: 'porConteudo',
    disciplinas: [
      { id: 'dA', nome: 'A', arquivos: ['n1', 'n2', 'n3'] },
      { id: 'dB', nome: 'B', arquivos: ['x', 'y'] }, // <3 -> pulada mas conta no progresso
      { id: grouping.ID_NAO_CLASSIFICADOS, nome: 'Não classificados', arquivos: ['z'] },
    ],
  };
  const prog = [];
  const comTopicos = await grouping.addTopicos(mapping, signalsByPath, { callGenerate: fakeTop, onProgress: (p) => prog.push(p), root: ROOT });
  const fases = prog.filter((p) => p.phase === 'topicos');
  eq(fases.length, 2, 'addTopicos itera 2 disciplinas (exclui Não classificados)');
  eq(fases[fases.length - 1].current, fases[fases.length - 1].total, 'addTopicos termina com current===total');
  ok(comTopicos.disciplinas.find((d) => d.id === grouping.ID_NAO_CLASSIFICADOS), 'addTopicos preserva Não classificados');

  // addTopicos com alvo: só a disciplina alvo é processada.
  const prog2 = [];
  await grouping.addTopicos(mapping, signalsByPath, { callGenerate: fakeTop, onProgress: (p) => prog2.push(p), alvo: ['dA'], root: ROOT });
  eq(prog2.filter((p) => p.phase === 'topicos').length, 1, 'addTopicos com alvo itera só 1 disciplina');

  // =========================================================================
  // 6) Edições manuais
  // =========================================================================
  console.log('\n== edições manuais ==');
  const base = normalizeFixture();

  // rename
  const r1 = grouping.renameDisciplina(base, 'd_calc', 'Cálculo I');
  ok(r1.ok, 'rename ok');
  eq(r1.mapping.disciplinas.find((d) => d.id === 'd_calc').nome, 'Cálculo I', 'rename aplica nome');
  ok(r1.mapping.editedAt && !r1.mapping.generatedAt, 'rename toca editedAt e não generatedAt');
  ok(base.disciplinas.find((d) => d.id === 'd_calc').nome === 'Cálculo', 'rename imutável (não altera base)');
  ok(!grouping.renameDisciplina(base, 'd_calc', '   ').ok, 'rename nome vazio -> erro');
  ok(!grouping.renameDisciplina(base, 'inexistente', 'X').ok, 'rename id inexistente -> erro');

  // create
  const c1 = grouping.createDisciplina(base, 'Nova');
  ok(c1.ok && c1.id, 'create ok com id');
  ok(c1.mapping.disciplinas.some((d) => d.id === c1.id && d.nome === 'Nova'), 'create adiciona disciplina');
  ok(!grouping.createDisciplina(base, '  ').ok, 'create nome vazio -> erro');

  // move: deriva origem do path; remove do tópico de origem.
  const mv = grouping.moveArquivo(base, 'f_lim', 'd_hist');
  ok(mv.ok, 'move ok');
  const calcDepois = mv.mapping.disciplinas.find((d) => d.id === 'd_calc');
  const histDepois = mv.mapping.disciplinas.find((d) => d.id === 'd_hist');
  ok(!calcDepois.arquivos.includes('f_lim'), 'move remove da origem');
  ok(histDepois.arquivos.includes('f_lim'), 'move adiciona no destino');
  ok(!calcDepois.topicos.some((t) => t.arquivos.includes('f_lim')), 'move remove do tópico de origem');
  // invariante 1: path em no máximo uma disciplina.
  const contagem = mv.mapping.disciplinas.filter((d) => d.arquivos.includes('f_lim')).length;
  eq(contagem, 1, 'move preserva invariante 1 (path em 1 disciplina)');
  ok(!grouping.moveArquivo(base, 'inexistente', 'd_hist').ok, 'move path ausente -> erro');
  ok(!grouping.moveArquivo(base, 'f_lim', 'inexistente').ok, 'move destino inexistente -> erro');
  // origem === destino -> no-op sem erro.
  const noop = grouping.moveArquivo(base, 'f_lim', 'd_calc');
  ok(noop.ok, 'move origem===destino -> no-op ok');

  // merge
  const mg = grouping.mergeDisciplinas(base, 'd_hist', 'd_calc');
  ok(mg.ok, 'merge ok');
  ok(!mg.mapping.disciplinas.some((d) => d.id === 'd_hist'), 'merge remove source');
  ok(mg.mapping.disciplinas.find((d) => d.id === 'd_calc').arquivos.includes('f_rev'), 'merge concatena arquivos');
  ok(!grouping.mergeDisciplinas(base, 'd_calc', 'd_calc').ok, 'merge sourceId===targetId -> erro');
  ok(!grouping.mergeDisciplinas(base, 'd_calc', 'inexistente').ok, 'merge id inexistente -> erro');

  // =========================================================================
  // 7) appendClassified (match por nome atual preservando id)
  // =========================================================================
  console.log('\n== appendClassified ==');
  // Simula rename: "Cálculo" -> "Cálculo I" mantendo o id d_calc.
  const renomeado = grouping.renameDisciplina(base, 'd_calc', 'Cálculo I').mapping;
  // A IA, incentivada, devolve "Cálculo I" de novo.
  const app = grouping.appendClassified(renomeado, [
    { path: 'novo1', disciplina: 'Cálculo I' },
    { path: 'novo2', disciplina: 'Biologia' }, // nova disciplina
    { path: 'novo3', disciplina: 'Não classificados' },
  ]);
  const calcAp = app.mapping.disciplinas.find((d) => d.id === 'd_calc');
  ok(calcAp && calcAp.arquivos.includes('novo1'), 'append casa por nome atual preservando id');
  ok(app.mapping.disciplinas.some((d) => d.nome === 'Biologia' && d.id !== 'd_calc'), 'append rótulo sem match -> nova disciplina');
  ok(app.mapping.disciplinas.find((d) => d.id === grouping.ID_NAO_CLASSIFICADOS).arquivos.includes('novo3'), 'append Não classificados');
  ok(app.discIdsAfetados.includes('d_calc'), 'append retorna discIdsAfetados');
  ok(Array.isArray(app.discIdsAfetados) && app.discIdsAfetados.length >= 3, 'append discIdsAfetados cobre as 3 afetadas');

  // =========================================================================
  // 8) diffFiles / pruneRemoved / refreshSignatures / suggestMode / store
  // =========================================================================
  console.log('\n== incrementais / suggestMode / store ==');
  const mapSig = {
    rootFolder: ROOT,
    disciplinas: [{ id: 'd1', nome: 'D', arquivos: ['a', 'b'] }],
    fileSignatures: { a: 100, b: 200 },
  };
  const scanned = [
    { path: 'a', mtime: 100 }, // inalterado
    { path: 'b', mtime: 999 }, // alterado -> novo
    { path: 'c', mtime: 300 }, // novo
  ];
  const diff = grouping.diffFiles(mapSig, scanned);
  eq(diff.inalterados.length, 1, 'diffFiles inalterados');
  eq(diff.novos.length, 2, 'diffFiles novos (alterado + novo)');
  // 'a' e 'b' estão no scan; nenhum removido? b mudou mas ainda existe. Nenhum removido.
  eq(diff.removidos.length, 0, 'diffFiles nenhum removido');

  const scannedComRemovido = [{ path: 'a', mtime: 100 }];
  eq(grouping.diffFiles(mapSig, scannedComRemovido).removidos.length, 1, 'diffFiles detecta removido (b sumiu)');

  // pruneRemoved
  const pruned = grouping.pruneRemoved(mapSig, ['b']);
  ok(!pruned.disciplinas[0].arquivos.includes('b'), 'pruneRemoved remove do mapeamento');
  ok(!('b' in pruned.fileSignatures), 'pruneRemoved remove assinatura');

  // refreshSignatures seta generatedAt e cobre antigos+novos.
  const refreshed = grouping.refreshSignatures(mapSig, [{ path: 'a', mtime: 100 }, { path: 'c', mtime: 300 }]);
  ok(refreshed.generatedAt, 'refreshSignatures seta generatedAt');
  eq(refreshed.fileSignatures.c, 300, 'refreshSignatures cobre novo');
  ok(!('b' in refreshed.fileSignatures), 'refreshSignatures substitui o conjunto');

  // suggestMode: porPasta (>=2 matérias e arqFora > arqGeral).
  const scanPasta = { root: ROOT, notebooks: [
    { name: 'Geral', path: ROOT, files: [{}, {}] },
    { name: 'Mat', path: ROOT + '\\Mat', files: [{}, {}, {}] },
    { name: 'Fis', path: ROOT + '\\Fis', files: [{}, {}, {}] },
  ] };
  eq(grouping.suggestMode(scanPasta).sugerido, 'porPasta', 'suggestMode porPasta');

  const scanConteudo = { root: ROOT, notebooks: [
    { name: 'Geral', path: ROOT, files: [{}, {}, {}, {}, {}] },
    { name: 'Mat', path: ROOT + '\\Mat', files: [{}] },
  ] };
  eq(grouping.suggestMode(scanConteudo).sugerido, 'porConteudo', 'suggestMode porConteudo (poucas matérias)');

  // storeKey determinístico.
  eq(grouping.storeKey(ROOT), grouping.storeKey(ROOT), 'storeKey determinístico');
  ok(grouping.storeKey(ROOT).startsWith('grouping::'), 'storeKey prefixo');

  // load/save/clear ponta a ponta (store cai em temp).
  const rootUnico = ROOT + '\\run-' + Date.now();
  const mapParaSalvar = { rootFolder: rootUnico, mode: 'porConteudo', disciplinas: [{ id: 'dx', nome: 'DX', arquivos: ['z'] }], fileSignatures: {} };
  eq(grouping.loadMapping(rootUnico), null, 'loadMapping antes de salvar -> null');
  grouping.saveMapping(mapParaSalvar);
  const carregado = grouping.loadMapping(rootUnico);
  ok(carregado && carregado.disciplinas[0].id === 'dx', 'saveMapping/loadMapping ponta a ponta');
  grouping.clearMapping(rootUnico);
  eq(grouping.loadMapping(rootUnico), null, 'clearMapping -> loadMapping null');

  // ---------------------------------------------------------------------
  finalizar();
})().catch((e) => {
  console.error('Erro fatal no teste:', e);
  process.exit(1);
});

// Fixture de mapeamento com disciplinas e tópicos para edições.
function normalizeFixture() {
  return {
    rootFolder: ROOT,
    mode: 'porConteudo',
    disciplinas: [
      {
        id: 'd_calc', nome: 'Cálculo', arquivos: ['f_lim', 'f_deriv'],
        topicos: [{ id: 't_lim', nome: 'Limites', arquivos: ['f_lim'] }],
      },
      { id: 'd_hist', nome: 'História', arquivos: ['f_rev'] },
      { id: grouping.ID_NAO_CLASSIFICADOS, nome: 'Não classificados', arquivos: [] },
    ],
    generatedAt: undefined,
    fileSignatures: {},
  };
}

function finalizar() {
  console.log(`\n============================`);
  console.log(`Passes: ${passes} · Falhas: ${falhas}`);
  if (falhas) {
    console.log('\nProblemas:');
    for (const p of problemas) console.log('  - ' + p);
  } else {
    console.log('Todos os casos passaram. ✅');
  }
  process.exit(falhas ? 1 : 0);
}
