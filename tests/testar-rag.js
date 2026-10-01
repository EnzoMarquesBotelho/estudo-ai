#!/usr/bin/env node
'use strict';

/**
 * Teste do NÚCLEO + orquestração de RAG (src/services/rag.js) e de ai.embed
 * (src/services/ai.js), script node puro sem framework (padrão de
 * tests/testar-grouping.js).
 *
 * NÃO precisa de Ollama: embed/generate são injetados/mockados de forma
 * determinística; ai.embed é exercitado com global.fetch mockado (nenhuma
 * conexão real é feita). A persistência (ragStore) é testada ponta-a-ponta
 * porque cai numa pasta temp fora do Electron.
 *
 * O electron é mockado ANTES de qualquer require de módulo do app.
 */

// ---- Mock de electron ANTES de qualquer require do app (padrão exigido) ----
const Module = require('module');
const orig = Module._load;
Module._load = function (req) {
  if (req === 'electron') return { app: { isPackaged: false, getPath: () => require('os').tmpdir() } };
  return orig.apply(this, arguments);
};

const rag = require('../src/services/rag');
const ai = require('../src/services/ai');

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

function throwsErro(fn, msg) {
  try { fn(); falhas += 1; problemas.push(msg + ' (não lançou)'); console.log('  ❌ ' + msg + ' (não lançou)'); }
  catch { passes += 1; }
}

const ROOT = 'C:\\Users\\teste\\acervo';

// Vetor determinístico "one-hot" num espaço de 4 dim, a partir de uma seed 0..3.
function vetorSeed(seed) {
  const v = [0, 0, 0, 0];
  v[((seed % 4) + 4) % 4] = 1;
  return v;
}

// ===========================================================================
// 1) chunkText
// ===========================================================================
console.log('\n== chunkText ==');
(() => {
  eq(rag.chunkText('').length, 0, 'chunkText vazio -> []');
  eq(rag.chunkText('   \n  ').length, 0, 'chunkText só whitespace -> []');

  const curto = 'Uma frase curta.';
  const c1 = rag.chunkText(curto);
  eq(c1.length, 1, 'chunkText texto menor que maxChars -> 1 chunk');
  eq(c1[0].ordem, 0, 'chunkText ordem 0');
  eq(c1[0].trecho, curto, 'chunkText preserva o texto curto');

  // Texto longo: vários chunks, ordem sequencial, nenhum maior que maxChars.
  const longo = Array.from({ length: 60 }, (_, i) => `Sentenca numero ${i} com algum conteudo de estudo.`).join(' ');
  const chunks = rag.chunkText(longo, { maxChars: 200, overlap: 50 });
  ok(chunks.length >= 2, 'chunkText texto longo -> >=2 chunks');
  ok(chunks.every((c) => c.trecho.length <= 200), 'chunkText nenhum chunk excede maxChars');
  ok(chunks.every((c, i) => c.ordem === i), 'chunkText ordem sequencial');

  // Nenhum texto perdido: a concatenação (removendo overlaps) cobre todo o texto.
  // Verificação simples: cada caractere do texto normalizado aparece em algum chunk.
  const juntado = chunks.map((c) => c.trecho).join('');
  ok(juntado.length >= longo.length, 'chunkText não perde texto (cobertura total com overlap)');

  // Overlap presente entre chunks adjacentes: o fim do chunk i reaparece no início do i+1.
  let temOverlap = false;
  for (let i = 0; i < chunks.length - 1; i++) {
    const fim = chunks[i].trecho.slice(-20);
    if (fim && chunks[i + 1].trecho.includes(fim.trim().slice(0, 8))) { temOverlap = true; break; }
  }
  ok(temOverlap, 'chunkText há sobreposição entre chunks adjacentes');
})();

// ===========================================================================
// 2) cosineSimilarity
// ===========================================================================
console.log('\n== cosineSimilarity ==');
(() => {
  eq(rag.cosineSimilarity([1, 0, 0], [1, 0, 0]), 1, 'cosine idênticos -> 1');
  eq(rag.cosineSimilarity([1, 0], [0, 1]), 0, 'cosine ortogonais -> 0');
  eq(rag.cosineSimilarity([0, 0], [1, 1]), 0, 'cosine norma zero -> 0');
  eq(rag.cosineSimilarity([1, 2, 3], [1, 2]), 0, 'cosine tamanhos diferentes -> 0');
  const s = rag.cosineSimilarity([1, 1, 0], [1, 0, 0]);
  ok(s > 0.7 && s < 0.72, 'cosine 45 graus ~0.707');
})();

// ===========================================================================
// 3) topK
// ===========================================================================
console.log('\n== topK ==');
(() => {
  const chunks = [
    { path: 'a', trecho: 'a', vetor: [1, 0, 0] },
    { path: 'b', trecho: 'b', vetor: [0, 1, 0] },
    { path: 'c', trecho: 'c', vetor: [0.9, 0.1, 0] },
    { path: 'd', trecho: 'd' }, // sem vetor -> ignorado
  ];
  const r = rag.topK([1, 0, 0], chunks, 2);
  eq(r.length, 2, 'topK respeita k');
  eq(r[0].chunk.path, 'a', 'topK ordena por relevância (melhor primeiro)');
  eq(r[1].chunk.path, 'c', 'topK segundo mais relevante');
  const todos = rag.topK([1, 0, 0], chunks, 10);
  eq(todos.length, 3, 'topK ignora chunks sem vetor válido');
})();

// ===========================================================================
// 4) buildAnswerPrompt + selecionarTrechos
// ===========================================================================
console.log('\n== buildAnswerPrompt / selecionarTrechos ==');
(() => {
  const ranqueados = [
    { chunk: { path: 'C:\\x\\a.pdf', trecho: 'A'.repeat(4000) }, score: 0.9 },
    { chunk: { path: 'C:\\x\\b.docx', trecho: 'B'.repeat(4000) }, score: 0.8 },
    { chunk: { path: 'C:\\x\\c.md', trecho: 'C'.repeat(4000) }, score: 0.1 },
  ];
  const sel = rag.selecionarTrechos(ranqueados);
  ok(sel.length >= 1 && sel.length < 3, 'selecionarTrechos corta pelo teto MAX_PROMPT_CHARS');
  eq(sel[0].path, 'C:\\x\\a.pdf', 'selecionarTrechos mantém os de maior score');
  const soma = sel.reduce((a, t) => a + t.trecho.length, 0);
  ok(soma <= rag.MAX_PROMPT_CHARS + 4000, 'selecionarTrechos soma dentro do esperado');

  const trechos = [
    { path: 'C:\\x\\a.pdf', trecho: 'conteudo sobre limites' },
    { path: 'C:\\x\\b.docx', trecho: 'conteudo sobre derivadas' },
  ];
  const prompt = rag.buildAnswerPrompt('O que é um limite?', trechos);
  ok(prompt.includes('O que é um limite?'), 'buildAnswerPrompt inclui a pergunta');
  ok(prompt.includes('[1]') && prompt.includes('[2]'), 'buildAnswerPrompt numera as fontes [1..n]');
  ok(prompt.includes('a.pdf') && prompt.includes('b.docx'), 'buildAnswerPrompt inclui os nomes dos arquivos');
  ok(prompt.includes('Não encontrei isso no material indexado.'), 'buildAnswerPrompt inclui instrução anti-alucinação');
})();

// ===========================================================================
// 5) normalizeEmbedResponse (3 formatos + ordem + dim + erro)
// ===========================================================================
console.log('\n== normalizeEmbedResponse ==');
(() => {
  const emb = rag.normalizeEmbedResponse({ embeddings: [[1, 2], [3, 4]] });
  eq(emb.length, 2, 'normalize /api/embed array de arrays');
  eq(emb[1][0], 3, 'normalize preserva a ordem');

  const uno = rag.normalizeEmbedResponse({ embedding: [5, 6, 7] });
  eq(uno.length, 1, 'normalize /api/embeddings vetor único -> [[...]]');
  eq(uno[0][2], 7, 'normalize vetor único conteúdo');

  const openai = rag.normalizeEmbedResponse({ data: [{ embedding: [1, 1] }, { embedding: [2, 2] }] });
  eq(openai.length, 2, 'normalize formato OpenAI data[].embedding');

  throwsErro(() => rag.normalizeEmbedResponse({ foo: 'bar' }), 'normalize formato desconhecido -> throw');
  throwsErro(() => rag.normalizeEmbedResponse({ embeddings: [[1, 2], [3]] }), 'normalize dim divergente -> throw');
  throwsErro(() => rag.normalizeEmbedResponse({ embeddings: [['x', 'y']] }), 'normalize vetor não-numérico -> throw');
})();

// ===========================================================================
// 6) Incremental: fileSig / diffForIndex / prune / upsert / refreshSignatures
// ===========================================================================
console.log('\n== incremental ==');
(() => {
  eq(rag.fileSig({ mtime: 100, size: 20 }), '100::20', 'fileSig mtime::size');
  // mtime fracionário arredonda para ms inteiro (achado 5).
  eq(rag.fileSig({ mtime: 1699999999999.123, size: 20480 }), '1699999999999::20480', 'fileSig arredonda mtime float');

  const indice = {
    fileSignatures: { 'C:\\a.pdf': '100::10', 'C:\\b.pdf': '200::20' },
    chunks: [
      { path: 'C:\\a.pdf', ordem: 0, trecho: 'a', vetor: [1] },
      { path: 'C:\\b.pdf', ordem: 0, trecho: 'b', vetor: [1] },
    ],
  };
  const scannedPaths = [
    { path: 'C:\\a.pdf', mtime: 100, size: 10 },   // inalterado
    { path: 'C:\\b.pdf', mtime: 999, size: 20 },   // alterado (mtime)
    { path: 'C:\\c.pdf', mtime: 300, size: 30 },   // novo
    // 'C:\\removido.pdf' não está no scan: mas não está no índice tampouco.
  ];
  const files = [
    { path: 'C:\\a.pdf', text: 'a', mtime: 100, size: 10 },
    { path: 'C:\\b.pdf', text: 'b2', mtime: 999, size: 20 },
    { path: 'C:\\c.pdf', text: 'c', mtime: 300, size: 30 },
  ];
  const diff = rag.diffForIndex(indice, { scannedPaths, files });
  eq(diff.inalterados.length, 1, 'diffForIndex 1 inalterado');
  eq(diff.novos.length, 1, 'diffForIndex 1 novo');
  eq(diff.alterados.length, 1, 'diffForIndex 1 alterado');
  eq(diff.removidos.length, 0, 'diffForIndex nenhum removido (todos no scan)');

  // Mudança só de size (mesmo mtime) -> alterado (achado 9).
  const diffSize = rag.diffForIndex(indice, {
    scannedPaths: [{ path: 'C:\\a.pdf', mtime: 100, size: 999 }],
    files: [{ path: 'C:\\a.pdf', text: 'a', mtime: 100, size: 999 }],
  });
  eq(diffSize.alterados.length, 1, 'diffForIndex detecta mudança só de size');

  // removidos sai de scannedPaths, NÃO de files. Arquivo some do disco -> removido.
  const diffRem = rag.diffForIndex(indice, {
    scannedPaths: [{ path: 'C:\\a.pdf', mtime: 100, size: 10 }],
    files: [{ path: 'C:\\a.pdf', text: 'a', mtime: 100, size: 10 }],
  });
  eq(diffRem.removidos.length, 1, 'diffForIndex removido = ausente do scan (b sumiu)');
  eq(diffRem.removidos[0], 'C:\\b.pdf', 'diffForIndex removido correto');

  // Arquivo ainda no disco mas ilegível (text:'' e assinatura mudada) -> alterado, NÃO removido.
  const diffIleg = rag.diffForIndex(indice, {
    scannedPaths: [{ path: 'C:\\a.pdf', mtime: 500, size: 10 }, { path: 'C:\\b.pdf', mtime: 200, size: 20 }],
    files: [{ path: 'C:\\a.pdf', text: '', mtime: 500, size: 10 }, { path: 'C:\\b.pdf', text: 'b', mtime: 200, size: 20 }],
  });
  ok(diffIleg.alterados.some((f) => f.path === 'C:\\a.pdf'), 'arquivo ilegível com assinatura mudada -> alterado');
  eq(diffIleg.removidos.length, 0, 'arquivo ilegível NÃO vira removido');

  // mtime fracionário: assinatura gravada por refreshSignatures e comparada por
  // diffForIndex devem casar (não gerar falso-positivo permanente).
  const indVazio = { fileSignatures: {}, chunks: [] };
  const refreshed = rag.refreshSignatures(indVazio, [{ path: 'C:\\frac.pdf', mtime: 1699999999999.123, size: 20480 }]);
  eq(refreshed.fileSignatures['C:\\frac.pdf'], '1699999999999::20480', 'refreshSignatures grava via fileSig (float arredondado)');
  ok(refreshed.generatedAt, 'refreshSignatures seta generatedAt');
  const diffFrac = rag.diffForIndex(refreshed, {
    scannedPaths: [{ path: 'C:\\frac.pdf', mtime: 1699999999999.456, size: 20480 }], // casa decimal diferente, mesmo ms
    files: [{ path: 'C:\\frac.pdf', text: 'x', mtime: 1699999999999.456, size: 20480 }],
  });
  eq(diffFrac.inalterados.length, 1, 'diff mtime fracionário -> inalterado (estável)');
  eq(diffFrac.alterados.length, 0, 'diff mtime fracionário -> sem falso-positivo');

  // pruneChunks / upsertChunks imutáveis.
  const pruned = rag.pruneChunks(indice, ['C:\\a.pdf']);
  ok(!pruned.chunks.some((c) => c.path === 'C:\\a.pdf'), 'pruneChunks remove os chunks do path');
  ok(indice.chunks.some((c) => c.path === 'C:\\a.pdf'), 'pruneChunks é imutável (não altera o original)');

  const ups = rag.upsertChunks(indice, 'C:\\a.pdf', [{ path: 'C:\\a.pdf', ordem: 0, trecho: 'novo', vetor: [2] }]);
  eq(ups.chunks.filter((c) => c.path === 'C:\\a.pdf').length, 1, 'upsertChunks substitui os antigos');
  eq(ups.chunks.find((c) => c.path === 'C:\\a.pdf').trecho, 'novo', 'upsertChunks insere os novos');
})();

// ===========================================================================
// 7) indexFiles com embed mock + 8) ask + 9) persistência + 10) genChunkId
// ===========================================================================
console.log('\n== indexFiles / ask / persistência / genChunkId ==');
(async () => {
  // genChunkId determinístico.
  eq(rag.genChunkId('C:\\a.pdf', 0), rag.genChunkId('C:\\a.pdf', 0), 'genChunkId determinístico');
  ok(rag.genChunkId('C:\\a.pdf', 0) !== rag.genChunkId('C:\\a.pdf', 1), 'genChunkId ordens distintas -> ids distintos');

  // embed mock: cada texto vira um vetor estável baseado no seu 1º char.
  let embedChamadas = 0;
  const embedMock = async (textos) => {
    embedChamadas += 1;
    const vetores = textos.map((t) => vetorSeed((t || ' ').charCodeAt(0)));
    return { ok: true, vetores };
  };

  const rootA = ROOT + '\\run-' + Date.now() + '-A';

  // --- indexFiles: gera o índice do zero ---
  const files1 = [
    { name: 'a.txt', text: 'Alpha conteudo de estudo sobre o tema um.', path: rootA + '\\a.txt', mtime: 100, size: 40 },
    { name: 'b.txt', text: 'Beta conteudo de estudo sobre o tema dois.', path: rootA + '\\b.txt', mtime: 200, size: 42 },
  ];
  const scan1 = files1.map((f) => ({ path: f.path, mtime: f.mtime, size: f.size }));
  const r1 = await rag.indexFiles({ rootFolder: rootA, files: files1, scannedPaths: scan1, embed: embedMock, embedModel: 'nomic-embed-text' });
  ok(r1.ok, 'indexFiles gera o índice (ok)');
  eq(r1.reindexados, 2, 'indexFiles processa 2 arquivos');
  eq(r1.pendentes, 0, 'indexFiles sem pendentes após indexar');
  const st1 = rag.indexStatus(rootA);
  ok(st1.exists && st1.arquivos === 2, 'indexStatus reflete 2 arquivos');
  ok(st1.chunks >= 2, 'indexStatus reflete chunks');
  eq(st1.modeloEmbedding, 'nomic-embed-text', 'indexStatus registra o modelo de embedding');
  eq(st1.dim, 4, 'indexStatus registra a dimensão dos vetores');

  // --- reindex sem mudança -> reindexados 0 ---
  const r2 = await rag.indexFiles({ rootFolder: rootA, files: files1, scannedPaths: scan1, embed: embedMock, embedModel: 'nomic-embed-text' });
  eq(r2.reindexados, 0, 'reindex sem mudança -> 0 reindexados');

  // --- alterar 1 arquivo -> só ele reprocessa ---
  const files1b = [
    files1[0],
    { name: 'b.txt', text: 'Beta ALTERADO conteudo novo sobre o tema dois.', path: rootA + '\\b.txt', mtime: 500, size: 50 },
  ];
  const scan1b = files1b.map((f) => ({ path: f.path, mtime: f.mtime, size: f.size }));
  const r3 = await rag.indexFiles({ rootFolder: rootA, files: files1b, scannedPaths: scan1b, embed: embedMock, embedModel: 'nomic-embed-text' });
  eq(r3.reindexados, 1, 'alterar 1 arquivo -> 1 reindexado');

  // --- fromScratch recria tudo ---
  const r4 = await rag.indexFiles({ rootFolder: rootA, files: files1b, scannedPaths: scan1b, fromScratch: true, embed: embedMock, embedModel: 'nomic-embed-text' });
  eq(r4.reindexados, 2, 'fromScratch recria todos');

  // --- troca de modelo de embedding força full ---
  const r5 = await rag.indexFiles({ rootFolder: rootA, files: files1b, scannedPaths: scan1b, embed: embedMock, embedModel: 'outro-modelo' });
  eq(r5.reindexados, 2, 'troca de modelo força reindex full');
  eq(rag.indexStatus(rootA).modeloEmbedding, 'outro-modelo', 'índice registra o novo modelo');

  // --- arquivo com text:'' -> pendente (não entra em fileSignatures); chunks antigos removidos ---
  const rootB = ROOT + '\\run-' + Date.now() + '-B';
  const filesB = [{ name: 'c.txt', text: 'Conteudo legivel inicial.', path: rootB + '\\c.txt', mtime: 100, size: 30 }];
  const scanB = filesB.map((f) => ({ path: f.path, mtime: f.mtime, size: f.size }));
  await rag.indexFiles({ rootFolder: rootB, files: filesB, scannedPaths: scanB, embed: embedMock, embedModel: 'nomic-embed-text' });
  ok(rag.indexStatus(rootB).chunks >= 1, 'arquivo legível indexado tem chunks');
  // agora o mesmo arquivo ficou ilegível (text:'' e assinatura mudada).
  const filesBileg = [{ name: 'c.txt', text: '', path: rootB + '\\c.txt', mtime: 777, size: 30 }];
  const scanBileg = filesBileg.map((f) => ({ path: f.path, mtime: f.mtime, size: f.size }));
  const rB = await rag.indexFiles({ rootFolder: rootB, files: filesBileg, scannedPaths: scanBileg, embed: embedMock, embedModel: 'nomic-embed-text' });
  eq(rB.reindexados, 0, 'arquivo ilegível -> 0 reindexados (pendente)');
  eq(rag.indexStatus(rootB).chunks, 0, 'arquivo ilegível -> chunks antigos removidos');
  ok(rB.pendentes >= 1, 'arquivo ilegível fica pendente');

  // --- removido de scannedPaths mas presente em files -> NÃO removido (regressão) ---
  const diffReg = rag.diffForIndex({ fileSignatures: { 'C:\\x.txt': '1::1' }, chunks: [] }, {
    scannedPaths: [{ path: 'C:\\x.txt', mtime: 2, size: 1 }],
    files: [{ path: 'C:\\x.txt', text: 'y', mtime: 2, size: 1 }],
  });
  eq(diffReg.removidos.length, 0, 'presente no scan -> não removido');

  // --- offline no 1º lote -> fatal (nada salvo) ---
  const rootOff = ROOT + '\\run-' + Date.now() + '-OFF';
  const embedOffline = async () => ({ ok: false, error: 'Ollama não está rodando. Abra o Ollama e tente de novo.' });
  const rOff = await rag.indexFiles({
    rootFolder: rootOff,
    files: [{ name: 'z.txt', text: 'texto qualquer para indexar', path: rootOff + '\\z.txt', mtime: 1, size: 10 }],
    scannedPaths: [{ path: rootOff + '\\z.txt', mtime: 1, size: 10 }],
    embed: embedOffline, embedModel: 'nomic-embed-text',
  });
  eq(rOff.ok, false, 'offline no 1º lote -> ok:false');
  ok(rOff.error && rOff.error.startsWith('Ollama não está rodando'), 'offline propaga prefixo literal');
  eq(rag.indexStatus(rootOff).exists, false, 'offline no 1º lote -> nada salvo');

  // =========================================================================
  // ask
  // =========================================================================
  console.log('\n== ask ==');
  // generate mock: devolve a resposta fixa + marca quantos trechos recebeu.
  let generateCapturado = '';
  const generateMock = async (prompt) => {
    generateCapturado = prompt;
    return { ok: true, text: 'Resposta baseada no material. [1]' };
  };

  // ask sem índice -> SEM_INDICE.
  const semIndice = await rag.ask({ rootFolder: ROOT + '\\inexistente', pergunta: 'x', embed: embedMock, generate: generateMock });
  eq(semIndice.ok, false, 'ask sem índice -> ok:false');
  eq(semIndice.error, 'SEM_INDICE', 'ask sem índice -> SEM_INDICE');

  // Prepara um índice conhecido para ask.
  const rootAsk = ROOT + '\\run-' + Date.now() + '-ASK';
  const filesAsk = [
    { name: 'calc.txt', text: 'Alpha trata de limites e derivadas em calculo.', path: rootAsk + '\\calc.txt', mtime: 1, size: 40 },
    { name: 'hist.txt', text: 'Beta trata de historia antiga e idade media.', path: rootAsk + '\\hist.txt', mtime: 2, size: 42 },
  ];
  const scanAsk = filesAsk.map((f) => ({ path: f.path, mtime: f.mtime, size: f.size }));
  await rag.indexFiles({ rootFolder: rootAsk, files: filesAsk, scannedPaths: scanAsk, embed: embedMock, embedModel: 'nomic-embed-text' });

  const resposta = await rag.ask({ rootFolder: rootAsk, pergunta: 'Alpha', embed: embedMock, generate: generateMock });
  ok(resposta.ok, 'ask retorna ok');
  ok(generateCapturado.includes('PERGUNTA: Alpha'), 'ask monta o prompt com a pergunta');
  ok(resposta.fontes.length >= 1, 'ask retorna fontes do topK');
  ok(resposta.fontes.every((f) => f.path && typeof f.trechoCurto === 'string'), 'ask fontes têm path e trechoCurto');

  // Fontes dedup por path.
  const paths = resposta.fontes.map((f) => f.path);
  eq(paths.length, new Set(paths).size, 'ask fontes dedup por path');

  // "não encontrei" ainda retorna as fontes do topK (não inventa fontes extras).
  const generateNaoEncontrei = async () => ({ ok: true, text: 'Não encontrei isso no material indexado.' });
  const respNao = await rag.ask({ rootFolder: rootAsk, pergunta: 'tema inexistente', embed: embedMock, generate: generateNaoEncontrei });
  ok(respNao.ok, 'ask "não encontrei" -> ok');
  ok(respNao.fontes.length >= 1, 'ask "não encontrei" ainda retorna fontes do topK');

  // Escopo por scopePaths restringe os chunks.
  const respEscopo = await rag.ask({ rootFolder: rootAsk, pergunta: 'Alpha', scopePaths: [rootAsk + '\\hist.txt'], embed: embedMock, generate: generateMock });
  ok(respEscopo.fontes.every((f) => f.path === rootAsk + '\\hist.txt'), 'ask escopo restringe aos paths informados');

  // Escopo vazio -> resposta de "sem material no escopo".
  const respVazio = await rag.ask({ rootFolder: rootAsk, pergunta: 'Alpha', scopePaths: [], embed: embedMock, generate: generateMock });
  ok(respVazio.ok && respVazio.fontes.length === 0, 'ask escopo vazio -> fontes vazias');
  ok(/Não há material indexado nesse escopo/.test(respVazio.resposta), 'ask escopo vazio -> mensagem clara');

  // ask não aceita model/signal/onNoIndex: a assinatura só usa os campos declarados.
  ok(rag.ask.length <= 1, 'ask recebe um único objeto de argumentos');

  // =========================================================================
  // Persistência: loadMeta/indexStatus leem só o .meta.json
  // =========================================================================
  console.log('\n== persistência (meta leve) ==');
  const meta = rag.loadMeta(rootAsk);
  ok(meta && Array.isArray(meta.paths) && meta.paths.length === 2, 'loadMeta tem paths');
  ok(meta.fileSignatures && Object.keys(meta.fileSignatures).length === 2, 'meta inclui fileSignatures (achado 1)');

  // Apaga o .json grande e confirma que indexStatus + pendentes respondem só pelo meta.
  const fs = require('fs');
  const pathMod = require('path');
  const os = require('os');
  const key = rag.indexKey(rootAsk);
  const jsonGrande = pathMod.join(os.tmpdir(), 'rag', key + '.json');
  if (fs.existsSync(jsonGrande)) fs.unlinkSync(jsonGrande);
  const stSemJson = rag.indexStatus(rootAsk);
  ok(stSemJson.exists && stSemJson.arquivos === 2, 'indexStatus responde sem o .json grande (só meta)');
  eq(rag.loadIndex(rootAsk), null, 'loadIndex sem o .json -> null');

  // pendentes calculável só do meta (loadMeta + diffForIndex).
  const metaIndex = { fileSignatures: meta.fileSignatures };
  const diffMeta = rag.diffForIndex(metaIndex, { scannedPaths: scanAsk, files: scanAsk });
  eq(diffMeta.novos.length + diffMeta.alterados.length + diffMeta.removidos.length, 0, 'pendentes calculável só do meta -> 0');

  // clearIndex apaga ambos.
  rag.clearIndex(rootAsk);
  eq(rag.indexStatus(rootAsk).exists, false, 'clearIndex -> indexStatus exists:false');

  // =========================================================================
  // ai.embed com global.fetch mockado
  // =========================================================================
  console.log('\n== ai.embed (fetch mockado) ==');

  function mockFetch(handler) {
    global.fetch = async (url, opts) => handler(url, JSON.parse(opts.body || '{}'));
  }
  function jsonResp(obj, okFlag = true, status = 200) {
    return { ok: okFlag, status, json: async () => obj, text: async () => JSON.stringify(obj) };
  }

  // Lote OK via /api/embed.
  ai._resetEmbedState();
  mockFetch((url, body) => {
    if (url.endsWith('/api/embed')) {
      return jsonResp({ embeddings: (body.input || []).map((_, i) => [i, i + 1]) });
    }
    return jsonResp({ error: 'not found' }, false, 404);
  });
  const eb1 = await ai.embed(['x', 'y', 'z']);
  ok(eb1.ok && eb1.vetores.length === 3, 'ai.embed lote OK devolve 3 vetores');

  // Lote devolve MENOS vetores que entradas -> degrada item-a-item e contagem final casa.
  ai._resetEmbedState();
  mockFetch((url, body) => {
    if (url.endsWith('/api/embed')) {
      if (Array.isArray(body.input)) {
        // lote: devolve só 1 vetor (truncado).
        return jsonResp({ embeddings: [[1, 2]] });
      }
      // item-a-item (input string): devolve 1 vetor.
      return jsonResp({ embeddings: [[9, 9]] });
    }
    return jsonResp({ error: 'not found' }, false, 404);
  });
  const eb2 = await ai.embed(['a', 'b', 'c']);
  ok(eb2.ok, 'ai.embed degradação -> ok');
  eq(eb2.vetores.length, 3, 'ai.embed degrada p/ item-a-item (contagem final casa)');

  // Offline (fetch rejeita) -> prefixo literal.
  ai._resetEmbedState();
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const eb3 = await ai.embed(['x']);
  eq(eb3.ok, false, 'ai.embed offline -> ok:false');
  ok(eb3.error && eb3.error.startsWith('Ollama não está rodando'), 'ai.embed offline -> prefixo literal');

  // 404 "not found" -> modelo ausente, sem fallback.
  ai._resetEmbedState();
  mockFetch(() => jsonResp({ error: "model 'nomic-embed-text' not found" }, false, 404));
  const eb4 = await ai.embed(['x']);
  eq(eb4.ok, false, 'ai.embed modelo ausente -> ok:false');
  ok(/não está instalado/.test(eb4.error), 'ai.embed modelo ausente -> mensagem clara');

  // 404 de ENDPOINT inexistente (sem menção a modelo) -> fallback para /api/embeddings.
  ai._resetEmbedState();
  mockFetch((url, body) => {
    if (url.endsWith('/api/embed')) return jsonResp({ error: 'unknown endpoint' }, false, 404);
    if (url.endsWith('/api/embeddings')) return jsonResp({ embedding: [7, 7, 7] });
    return jsonResp({}, false, 500);
  });
  const eb5 = await ai.embed(['só um']);
  ok(eb5.ok && eb5.vetores.length === 1, 'ai.embed 404 de endpoint -> fallback /api/embeddings');
  eq(eb5.vetores[0][0], 7, 'ai.embed fallback devolve o vetor correto');

  delete global.fetch;
  ai._resetEmbedState();

  finalizar();
})().catch((e) => {
  console.error('Erro fatal no teste:', e);
  process.exit(1);
});

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
