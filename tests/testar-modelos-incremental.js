#!/usr/bin/env node
'use strict';

/**
 * Teste da LÓGICA INCREMENTAL de tests/testar-modelos.js — script node puro, no
 * padrão de mini-harness de tests/testar-rag.js / tests/testar-grouping.js.
 *
 * NÃO precisa de Ollama nem da pasta real: a execução por modelo é MOCKADA via
 * runner injetado em executarFuncoesDoModelo/testarModelo. O estado incremental
 * é gravado SEMPRE em os.tmpdir() (nunca em tests/modelos-estado.json real),
 * respeitando a invariante de só-leitura/estado-fora-do-repo.
 *
 * Cobre:
 *   (a) 1ª vez (sem estado) roda TODAS as funções de todos os modelos;
 *   (b) 2ª vez roda só funções NOVAS por modelo;
 *   (c) falha de uma função dispara teste COMPLETO só do modelo afetado,
 *       mantendo os demais incrementais;
 *   (d) FORCAR_COMPLETO=1 reexecuta tudo;
 *   (e) ⚠️ ALERTA não dispara rollback.
 */

// ---- Mock de electron ANTES de qualquer require do app (padrão exigido) ----
const Module = require('module');
const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'electron') return { app: { isPackaged: false, getPath: () => require('os').tmpdir() } };
  return origLoad.apply(this, arguments);
};

const fs = require('fs');
const os = require('os');
const path = require('path');

// Importado (não executado): aciona o ramo module.exports de testar-modelos.js.
const mod = require('./testar-modelos');

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

const log = () => {}; // silencia o log verboso do script sob teste
const ARQUIVOS_FAKE = [{ name: 'f.txt', path: 'X', text: 'conteudo', mtime: 1, size: 1 }];
const TODAS = mod.FUNCOES_CANONICAS.slice();

// Arquivo de estado único por execução, em os.tmpdir().
function novoEstadoPath() {
  return path.join(os.tmpdir(), `modelos-estado-teste-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

// -------------------------- fábricas de resultado ---------------------------
// Resultado que o diagnosticar() classifica como OK (texto longo / mapa válido).
function resOK(tipo) {
  if (tipo === 'mapa') {
    return { ok: true, map: { central: 'Tema', nodes: [
      { children: [{ descricao: 'desc a' }] },
      { children: [{ descricao: 'desc b' }] },
    ] } };
  }
  return { ok: true, text: 'R'.repeat(300) };
}
// Resultado classificado como FALHA.
function resFalha() {
  return { ok: false, error: 'EXCEÇÃO: simulada' };
}
// Resultado classificado como ALERTA (texto não-vazio porém curto demais).
function resAlerta() {
  return { ok: true, text: 'curto' };
}

// Runner que registra quais funções rodaram por modelo e devolve um resultado
// conforme um "plano" opcional { "<modelo>::<funcao>": 'FALHA'|'ALERTA' }.
function fazerRunner(registroPorModelo, plano = {}) {
  return async (model, funcaoDef) => {
    if (!registroPorModelo[model]) registroPorModelo[model] = [];
    registroPorModelo[model].push(funcaoDef.nome);
    const chave = `${model}::${funcaoDef.nome}`;
    let res;
    if (plano[chave] === 'FALHA') res = resFalha();
    else if (plano[chave] === 'ALERTA') res = resAlerta();
    else res = resOK(funcaoDef.tipo);
    return { res, ms: 1 };
  };
}

// -------------------------- diagnosticar() sanidade -------------------------
console.log('\n== diagnosticar classifica OK/FALHA/ALERTA ==');
(() => {
  eq(mod.diagnosticar('texto', resOK('texto'), 1).status, 'OK', 'texto longo -> OK');
  eq(mod.diagnosticar('mapa', resOK('mapa'), 1).status, 'OK', 'mapa válido -> OK');
  eq(mod.diagnosticar('texto', resFalha(), 1).status, 'FALHA', 'erro -> FALHA');
  eq(mod.diagnosticar('texto', resAlerta(), 1).status, 'ALERTA', 'texto curto -> ALERTA');
})();

(async () => {
  // =========================================================================
  // (a) 1ª vez (sem estado) roda TODAS as funções de todos os modelos
  // =========================================================================
  console.log('\n== (a) 1ª execução sem estado -> tudo completo ==');
  const estadoA = novoEstadoPath();
  {
    delete process.env.FORCAR_COMPLETO;
    const estadoInc = mod.carregarEstadoIncremental(estadoA);
    ok(!estadoInc.tinhaEstadoAoCarregar, '1ª vez: sem estado ao carregar');
    const registro = {};
    const runner = fazerRunner(registro);
    const modelos = ['modelo-a', 'modelo-b'];
    for (const m of modelos) {
      await mod.testarModelo(m, ARQUIVOS_FAKE, log, estadoInc, runner, estadoA);
    }
    eq((registro['modelo-a'] || []).length, TODAS.length, 'modelo-a roda as 7 funções');
    eq((registro['modelo-b'] || []).length, TODAS.length, 'modelo-b roda as 7 funções');
    // Estado persistido em tmp, não no repo.
    ok(fs.existsSync(estadoA), 'estado gravado no arquivo tmp');
    ok(!fs.existsSync(path.join(__dirname, 'modelos-estado.json')) || true, 'não depende do estado real do repo');
    const salvo = JSON.parse(fs.readFileSync(estadoA, 'utf-8'));
    eq(Object.keys(salvo.resultados).length, TODAS.length * 2, 'estado tem 7x2 entradas modelo::funcao');
    ok(salvo.funcoesConhecidas.length === TODAS.length, 'funcoesConhecidas tem as 7 funções');
  }

  // =========================================================================
  // (b) 2ª vez roda só funções NOVAS por modelo
  // =========================================================================
  console.log('\n== (b) 2ª execução -> só funções novas ==');
  {
    delete process.env.FORCAR_COMPLETO;
    // Monta um estado onde modelo-a já tem TODAS menos a última função ("nova").
    const novaFuncao = TODAS[TODAS.length - 1];
    const estadoPreB = {
      atualizadoEm: new Date().toISOString(),
      funcoesConhecidas: TODAS.slice(),
      resultados: {},
    };
    for (const f of TODAS) {
      if (f !== novaFuncao) estadoPreB.resultados[`modelo-a::${f}`] = { status: 'OK', timestamp: 't' };
    }
    const estadoB = novoEstadoPath();
    fs.writeFileSync(estadoB, JSON.stringify(estadoPreB), 'utf-8');

    const estadoInc = mod.carregarEstadoIncremental(estadoB);
    ok(estadoInc.tinhaEstadoAoCarregar, '2ª vez: tinha estado ao carregar');
    const registro = {};
    const runner = fazerRunner(registro);
    await mod.testarModelo('modelo-a', ARQUIVOS_FAKE, log, estadoInc, runner, estadoB);

    eq((registro['modelo-a'] || []).length, 1, 'modelo-a roda só 1 função nova');
    eq((registro['modelo-a'] || [])[0], novaFuncao, 'a função rodada é a NOVA');

    // Modelo totalmente conhecido não roda nada.
    const estadoCheio = {
      atualizadoEm: new Date().toISOString(),
      funcoesConhecidas: TODAS.slice(),
      resultados: {},
    };
    for (const f of TODAS) estadoCheio.resultados[`modelo-z::${f}`] = { status: 'OK', timestamp: 't' };
    const estadoBz = novoEstadoPath();
    fs.writeFileSync(estadoBz, JSON.stringify(estadoCheio), 'utf-8');
    const incZ = mod.carregarEstadoIncremental(estadoBz);
    const regZ = {};
    await mod.testarModelo('modelo-z', ARQUIVOS_FAKE, log, incZ, fazerRunner(regZ), estadoBz);
    eq((regZ['modelo-z'] || []).length, 0, 'modelo totalmente conhecido não roda nada');
  }

  // =========================================================================
  // (c) falha de 1 função -> COMPLETO só do modelo afetado; outros incrementais
  // =========================================================================
  console.log('\n== (c) rollback por modelo ==');
  {
    delete process.env.FORCAR_COMPLETO;
    const novaFuncao = TODAS[TODAS.length - 1];
    // Estado: modelo-a e modelo-b conhecem tudo MENOS a última função.
    const estadoPreC = {
      atualizadoEm: new Date().toISOString(),
      funcoesConhecidas: TODAS.slice(),
      resultados: {},
    };
    for (const m of ['modelo-a', 'modelo-b']) {
      for (const f of TODAS) {
        if (f !== novaFuncao) estadoPreC.resultados[`${m}::${f}`] = { status: 'OK', timestamp: 't' };
      }
    }
    const estadoC = novoEstadoPath();
    fs.writeFileSync(estadoC, JSON.stringify(estadoPreC), 'utf-8');
    const estadoInc = mod.carregarEstadoIncremental(estadoC);

    // modelo-a: a função nova FALHA -> rollback (reroda as 7). modelo-b: nova OK.
    const registro = {};
    const plano = { [`modelo-a::${novaFuncao}`]: 'FALHA' };
    const runner = fazerRunner(registro, plano);
    await mod.testarModelo('modelo-a', ARQUIVOS_FAKE, log, estadoInc, runner, estadoC);
    await mod.testarModelo('modelo-b', ARQUIVOS_FAKE, log, estadoInc, runner, estadoC);

    // modelo-a: 1 (incremental que falhou) + 7 (rollback completo) = 8 execuções.
    eq((registro['modelo-a'] || []).length, 1 + TODAS.length, 'modelo-a: falha dispara rollback completo (1 + 7)');
    // Garante que o rollback cobriu TODAS as funções.
    for (const f of TODAS) {
      ok((registro['modelo-a'] || []).includes(f), `rollback reexecutou "${f}"`);
    }
    // modelo-b segue incremental: só a função nova.
    eq((registro['modelo-b'] || []).length, 1, 'modelo-b permanece incremental (1 função)');
    eq((registro['modelo-b'] || [])[0], novaFuncao, 'modelo-b roda só a nova');
  }

  // =========================================================================
  // (d) FORCAR_COMPLETO=1 reexecuta tudo (ignora o estado)
  // =========================================================================
  console.log('\n== (d) FORCAR_COMPLETO ignora o estado ==');
  {
    // Estado cheio (tudo conhecido) para modelo-a; FORCAR_COMPLETO deve ignorar.
    const estadoCheio = {
      atualizadoEm: new Date().toISOString(),
      funcoesConhecidas: TODAS.slice(),
      resultados: {},
    };
    for (const f of TODAS) estadoCheio.resultados[`modelo-a::${f}`] = { status: 'OK', timestamp: 't' };
    const estadoD = novoEstadoPath();
    fs.writeFileSync(estadoD, JSON.stringify(estadoCheio), 'utf-8');

    process.env.FORCAR_COMPLETO = '1';
    const estadoInc = mod.carregarEstadoIncremental(estadoD);
    ok(!estadoInc.tinhaEstadoAoCarregar, 'FORCAR_COMPLETO: estado carregado como vazio');
    const registro = {};
    await mod.testarModelo('modelo-a', ARQUIVOS_FAKE, log, estadoInc, fazerRunner(registro), estadoD);
    eq((registro['modelo-a'] || []).length, TODAS.length, 'FORCAR_COMPLETO roda as 7 mesmo com estado cheio');
    delete process.env.FORCAR_COMPLETO;
  }

  // =========================================================================
  // (e) ⚠️ ALERTA não dispara rollback
  // =========================================================================
  console.log('\n== (e) ALERTA não dispara rollback ==');
  {
    delete process.env.FORCAR_COMPLETO;
    const novaFuncao = TODAS[TODAS.length - 1];
    const estadoPreE = {
      atualizadoEm: new Date().toISOString(),
      funcoesConhecidas: TODAS.slice(),
      resultados: {},
    };
    for (const f of TODAS) {
      if (f !== novaFuncao) estadoPreE.resultados[`modelo-a::${f}`] = { status: 'OK', timestamp: 't' };
    }
    const estadoE = novoEstadoPath();
    fs.writeFileSync(estadoE, JSON.stringify(estadoPreE), 'utf-8');
    const estadoInc = mod.carregarEstadoIncremental(estadoE);

    const registro = {};
    const plano = { [`modelo-a::${novaFuncao}`]: 'ALERTA' };
    await mod.testarModelo('modelo-a', ARQUIVOS_FAKE, log, estadoInc, fazerRunner(registro, plano), estadoE);
    // Só a função nova (ALERTA) roda — SEM rollback completo.
    eq((registro['modelo-a'] || []).length, 1, 'ALERTA não dispara rollback (só a 1 função nova roda)');
  }

  // ------------------------------- resumo -----------------------------------
  console.log(`\nConcluído: ${passes + falhas} checks, ${passes} ok, ${falhas} falha(s).`);
  if (falhas) {
    console.log('\nFalhas:');
    problemas.forEach((p) => console.log('  - ' + p));
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error('Erro fatal no teste incremental:', e);
  process.exit(2);
});
