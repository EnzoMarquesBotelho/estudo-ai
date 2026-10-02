#!/usr/bin/env node
'use strict';

/**
 * Teste do NÚCLEO de priorização do plano (src/services/plano.js) e da
 * orquestração gerarPlano com grouping/classification/rag.ask MOCKADOS.
 * Script node puro sem framework (padrão de tests/testar-grouping.js).
 *
 * O núcleo priorizarAssuntos não importa nada; mesmo assim mockamos electron
 * ANTES dos requires, por segurança (a orquestração não toca store aqui, mas o
 * padrão do projeto é mockar antes de qualquer require do app).
 */

const Module = require('module');
const orig = Module._load;
Module._load = function (req) {
  if (req === 'electron') return { app: { isPackaged: false, getPath: () => require('os').tmpdir() } };
  return orig.apply(this, arguments);
};

const plano = require('../src/services/plano');

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

// ===========================================================================
// 1) Ordenação por peso (critério 23) + fórmula/constantes (24)
// ===========================================================================
console.log('\n== Priorização por peso ==');
(() => {
  // Assunto A: 2 provas (3.0*2=6) + 3 listas (2.0*3=6) = 12 pesos.
  // Assunto B: 1 trabalho (1.0) = 1 peso.
  const tiposPorPath = {
    'A/prova1': 'prova', 'A/prova2': 'prova',
    'A/lista1': 'lista', 'A/lista2': 'lista', 'A/lista3': 'lista',
    'B/trab1': 'trabalho',
  };
  const assuntos = [
    { id: 'B', nome: 'Trabalhos', arquivos: [{ path: 'B/trab1', mtime: 500 }] },
    { id: 'A', nome: 'Provas e listas', arquivos: [
      { path: 'A/prova1', mtime: 100 }, { path: 'A/prova2', mtime: 110 },
      { path: 'A/lista1', mtime: 120 }, { path: 'A/lista2', mtime: 130 }, { path: 'A/lista3', mtime: 140 },
    ] },
  ];
  const r = plano.priorizarAssuntos({ assuntos, tiposPorPath });
  eq(r[0].id, 'A', 'assunto com provas/listas vem primeiro (critério 23)');
  eq(r[0].somaPesos, 12, 'somaPesos de A = 12 (2*3 + 3*2)');
  eq(r[1].somaPesos, 1, 'somaPesos de B = 1');

  // Constantes nomeadas em ponto único.
  eq(plano.PESO_TIPO.prova, 3.0, 'PESO_TIPO.prova = 3.0');
  eq(plano.PESO_TIPO.lista, 2.0, 'PESO_TIPO.lista = 2.0');
  eq(plano.RECENCIA_MIN, 1.0, 'RECENCIA_MIN = 1.0');
  eq(plano.RECENCIA_MAX, 1.2, 'RECENCIA_MAX = 1.2');

  // fatorRecencia dentro da faixa.
  ok(r[0].fatorRecencia >= 1.0 && r[0].fatorRecencia <= 1.2, 'fatorRecencia em [1.0, 1.2]');
  // escore = somaPesos * fatorRecencia.
  ok(Math.abs(r[0].escore - r[0].somaPesos * r[0].fatorRecencia) < 1e-9, 'escore = somaPesos * fatorRecencia');
})();

// ===========================================================================
// 2) Desempate por recência (critério 25)
// ===========================================================================
console.log('\n== Desempate por recência ==');
(() => {
  const tiposPorPath = { 'X/p': 'prova', 'Y/p': 'prova' };
  const assuntos = [
    { id: 'X', nome: 'X', arquivos: [{ path: 'X/p', mtime: 100 }] },
    { id: 'Y', nome: 'Y', arquivos: [{ path: 'Y/p', mtime: 999 }] },
  ];
  const r = plano.priorizarAssuntos({ assuntos, tiposPorPath });
  // Mesma somaPesos (3), mas Y é mais recente -> Y primeiro.
  eq(r[0].id, 'Y', 'empate de peso -> mais recente primeiro (critério 25)');
})();

// ===========================================================================
// 3) origemPriorizacao cita arquivo + tipo (critério 26)
// ===========================================================================
console.log('\n== Origem da priorização ==');
(() => {
  const tiposPorPath = { 'd/Prova_2.pdf': 'prova', 'd/aula.pdf': 'aula' };
  const assuntos = [{ id: 'd', nome: 'Disc', arquivos: [
    { path: 'd/Prova_2.pdf', mtime: 1 }, { path: 'd/aula.pdf', mtime: 2 },
  ] }];
  const r = plano.priorizarAssuntos({ assuntos, tiposPorPath });
  const o = r[0].origemPriorizacao;
  ok(o.length >= 1, 'tem origemPriorizacao');
  eq(o[0].nome, 'Prova_2.pdf', 'cita o arquivo de maior peso (nome)');
  eq(o[0].tipo, 'prova', 'cita o tipo (prova)');
})();

// ===========================================================================
// 4) Join de mtime: ausente -> 0 sem NaN; mtimeMax===mtimeMin -> RECENCIA_MIN
// ===========================================================================
console.log('\n== Robustez do mtime ==');
(() => {
  // path sem tipo -> 'outro' (0.25); mtime ausente -> 0.
  const assuntos = [{ id: 'z', nome: 'Z', arquivos: [
    { path: 'z/a', mtime: undefined }, { path: 'z/b' },
  ] }];
  const r = plano.priorizarAssuntos({ assuntos, tiposPorPath: {} });
  ok(!Number.isNaN(r[0].escore), 'escore não é NaN com mtime ausente');
  eq(r[0].fatorRecencia, 1.0, 'mtimeMax===mtimeMin -> fatorRecencia = RECENCIA_MIN');
  eq(r[0].arquivos[0].tipo, 'outro', 'tipo ausente -> outro');
})();

// ===========================================================================
// 5) Núcleo puro não importa nada (critério: INV3)
// ===========================================================================
console.log('\n== Núcleo puro (imports) ==');
(() => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'plano.js'), 'utf-8');
  // O núcleo não deve importar grouping-core/store/fs/path/crypto no topo do módulo.
  ok(!/require\(['"]\.\/grouping/.test(src), 'plano.js não importa grouping');
  ok(!/require\(['"]\.\/store['"]\)/.test(src), 'plano.js não importa store');
  ok(!/require\(['"]fs['"]\)/.test(src), 'plano.js não importa fs');
  ok(!/require\(['"]crypto['"]\)/.test(src), 'plano.js não importa crypto');
})();

// ===========================================================================
// 6) Orquestração gerarPlano com mocks (critérios 27–30)
// ===========================================================================
(async () => {
  console.log('\n== gerarPlano (mocks) ==');

  const mapping = {
    rootFolder: 'C:\\x', disciplinas: [
      { id: 'd1', nome: 'Cálculo', arquivos: ['C:\\x\\Prova.pdf', 'C:\\x\\aula.pdf'] },
    ],
  };
  const classState = {
    version: 1, rootFolder: 'C:\\x',
    fileSignatures: { 'C:\\x\\Prova.pdf': 100.5, 'C:\\x\\aula.pdf': 50.0 },
    arquivos: {
      'C:\\x\\Prova.pdf': { tipo: 'prova', origem: 'heuristica' },
      'C:\\x\\aula.pdf': { tipo: 'aula', origem: 'heuristica' },
    },
  };

  // ask mock: devolve resposta + fontes (shape real: resposta + trechoCurto).
  const askOk = async (a) => ({
    ok: true,
    resposta: `Estude os pontos principais de ${a.pergunta}.`,
    fontes: [{ path: a.scopePaths[0], trechoCurto: 'trecho...' }],
  });

  const prog = [];
  const r = await plano.gerarPlano({
    rootFolder: 'C:\\x', discId: 'd1', mapping, classState, ask: askOk,
    onProgress: (p) => prog.push(p),
  });
  ok(r.ok, 'gerarPlano ok com mocks');
  ok(typeof r.markdown === 'string' && r.markdown.includes('# Plano de estudos'), 'markdown gerado');
  ok(!/\|/.test(r.markdown.replace(/\\/g, '')), 'markdown sem tabelas (sem pipe) — critério 27');
  ok(!/\]\(http/.test(r.markdown), 'markdown sem links — critério 27');
  ok(r.markdown.includes('Prova.pdf') && /prova/.test(r.markdown), 'cita origem Prova.pdf (prova) — critério 26');
  ok(Array.isArray(r.fontes) && r.fontes.length >= 1, 'fontes agregadas');
  ok(prog.some((p) => p.phase === 'plano' && typeof p.message === 'string'), 'progresso usa campo message (plano)');

  // Dedup de fontes por path: dois assuntos citando o mesmo path -> 1 fonte.
  const mapping2 = {
    rootFolder: 'C:\\x', disciplinas: [{ id: 'd2', nome: 'D', arquivos: ['C:\\x\\a'], topicos: [
      { id: 't1', nome: 'T1', arquivos: ['C:\\x\\a'] },
      { id: 't2', nome: 'T2', arquivos: ['C:\\x\\a'] },
    ] }],
  };
  const classState2 = {
    rootFolder: 'C:\\x', fileSignatures: { 'C:\\x\\a': 10 },
    arquivos: { 'C:\\x\\a': { tipo: 'prova' } },
  };
  const askSame = async () => ({ ok: true, resposta: 'ok', fontes: [{ path: 'C:\\x\\a', trechoCurto: 't' }] });
  const r2 = await plano.gerarPlano({ rootFolder: 'C:\\x', discId: 'd2', mapping: mapping2, classState: classState2, ask: askSame });
  eq(r2.fontes.length, 1, 'fontes deduplicadas por path (LOW-1)');

  // SEM_INDICE por assunto -> lacuna declarada, plano ainda gerado (critério 28).
  const askSemIndice = async () => ({ ok: false, error: 'SEM_INDICE' });
  const r3 = await plano.gerarPlano({ rootFolder: 'C:\\x', discId: 'd1', mapping, classState, ask: askSemIndice });
  ok(r3.ok, 'SEM_INDICE por assunto não derruba o plano');
  ok(/não indexado/i.test(r3.markdown), 'declara lacuna de material não indexado (critério 28)');

  // SEM_CLASSIFICACAO quando não há Parte 1 (critério 30).
  const r4 = await plano.gerarPlano({ rootFolder: 'C:\\x', discId: 'd1', mapping, classState: null, ask: askOk });
  ok(r4.ok === false && r4.error === 'SEM_CLASSIFICACAO', 'sem classificação -> SEM_CLASSIFICACAO');

  // SEM_MAPEAMENTO quando não há Fase 1.
  const r5 = await plano.gerarPlano({ rootFolder: 'C:\\x', discId: 'd1', mapping: null, classState, ask: askOk });
  ok(r5.ok === false && r5.error === 'SEM_MAPEAMENTO', 'sem mapeamento -> SEM_MAPEAMENTO');

  finalizar();
})();

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
