#!/usr/bin/env node
'use strict';

/**
 * Teste do handler IPC `ex:byDiscipline` (src/main.js) — Exercícios por disciplina.
 * Script node puro sem framework (padrão de tests/testar-plano.js).
 *
 * Estratégia: mockamos `electron` ANTES de qualquer require do app. O mock do
 * `ipcMain.handle` CAPTURA cada handler num registro, então conseguimos invocar
 * o handler REAL de main.js diretamente, sem abrir janela. Sobrescrevemos os
 * métodos dos serviços que fariam I/O (grouping.loadMapping, library.readFileText,
 * ai.generateExercisesFolder) nos MESMOS objetos cacheados que main.js importa —
 * logo nada toca disco nem rede, e nenhum arquivo de estudo é lido de verdade.
 *
 * Cobre o CONTRATO da resolução por disciplina (INV1 — só leitura, aqui mockada):
 *   (a) disciplina inexistente        => { ok:false, error:'SEM_DISCIPLINA' }
 *   (b) disciplina sem arquivos        => erro PT-BR
 *   (c) nenhum arquivo legível         => erro PT-BR
 *   (d) caminho feliz                  => chama ai.generateExercisesFolder com os
 *                                          arquivos certos (só os legíveis) e emite
 *                                          progresso de leitura { phase:'read', ... }.
 */

const Module = require('module');

// -------------------- registro de handlers capturados --------------------
const handlers = {};
// Eventos enviados ao renderer via webContents.send (canal ex:progress etc.).
const enviados = [];

const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'electron') {
    return {
      app: {
        isPackaged: false,
        getPath: () => require('os').tmpdir(),
        whenReady: () => ({ then: () => {} }), // não dispara createWindow
        on: () => {},
        quit: () => {},
      },
      BrowserWindow: function () { return {}; },
      ipcMain: {
        handle: (canal, fn) => { handlers[canal] = fn; },
      },
      dialog: {},
      shell: {},
    };
  }
  return origLoad.apply(this, arguments);
};
// BrowserWindow precisa de getAllWindows para o app.on('activate') (não chamado,
// mas garante robustez caso o mock seja estendido).
require('electron').BrowserWindow.getAllWindows = () => [];

// -------- sobrescrever os serviços que fariam I/O (mesmos objetos cacheados) --------
const library = require('../src/services/library');
const grouping = require('../src/services/grouping');
const ai = require('../src/services/ai');

// Estado controlável pelos testes.
let MAPPING = null;              // o que grouping.loadMapping devolve
let TEXTOS = {};                 // path -> { ok, text } que library.readFileText devolve
let ultimaChamadaGerar = null;   // { files, options } capturado de generateExercisesFolder

grouping.loadMapping = () => MAPPING;
library.readFileText = async (p) => (TEXTOS[p] || { ok: false });
ai.generateExercisesFolder = async (files, options /*, onProgress */) => {
  ultimaChamadaGerar = { files, options };
  return { ok: true, text: '# Lista de Exercícios\n1. ...\n## Gabarito\n1. ...', model: 'fake' };
};

// store.get('rootFolder') é usado por resolveFolder quando folder não vem; aqui
// sempre passamos folder explícito. Mas resolveFolder valida fs.existsSync(root):
// usamos o próprio diretório de testes como "pasta" existente (nunca é lido).
const ROOT = __dirname;

// require do main DEPOIS dos mocks: registra os handlers no `handlers`.
require('../src/main');

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

const chamar = (args) => handlers['ex:byDiscipline'](null, args);

(async () => {
  // Pré-condição: o handler foi registrado.
  console.log('\n== Registro do handler ==');
  ok(typeof handlers['ex:byDiscipline'] === 'function', 'ipcMain.handle("ex:byDiscipline") registrado');

  // ===========================================================================
  console.log('\n== (a) disciplina inexistente -> SEM_DISCIPLINA ==');
  MAPPING = { disciplinas: [{ id: 'd1', nome: 'Cálculo', arquivos: ['C:\\x\\a.pdf'] }] };
  TEXTOS = { 'C:\\x\\a.pdf': { ok: true, text: 'conteúdo' } };
  {
    const r = await chamar({ folder: ROOT, discId: 'NAO_EXISTE', options: {} });
    ok(r && r.ok === false, 'retorna erro');
    eq(r.error, 'SEM_DISCIPLINA', 'erro é SEM_DISCIPLINA');
  }

  // ===========================================================================
  console.log('\n== pasta inválida -> erro PT-BR ==');
  {
    const r = await chamar({ folder: 'C:\\pasta\\que\\nao\\existe\\123', discId: 'd1', options: {} });
    ok(r && r.ok === false, 'retorna erro');
    eq(r.error, 'Pasta inválida.', 'mensagem PT-BR de pasta inválida');
  }

  // ===========================================================================
  console.log('\n== (b) disciplina sem arquivos -> erro ==');
  MAPPING = { disciplinas: [{ id: 'd1', nome: 'Vazia', arquivos: [] }] };
  {
    const r = await chamar({ folder: ROOT, discId: 'd1', options: {} });
    ok(r && r.ok === false, 'retorna erro');
    ok(/não tem arquivos/i.test(r.error), 'mensagem PT-BR de disciplina sem arquivos');
  }

  // ===========================================================================
  console.log('\n== (c) nenhum arquivo legível -> erro ==');
  MAPPING = { disciplinas: [{ id: 'd1', nome: 'Ilegível', arquivos: ['C:\\x\\a.pdf', 'C:\\x\\b.pdf'] }] };
  TEXTOS = {
    'C:\\x\\a.pdf': { ok: false },          // falhou/timeout
    'C:\\x\\b.pdf': { ok: true, text: '   ' }, // só espaços -> ignorado
  };
  {
    const r = await chamar({ folder: ROOT, discId: 'd1', options: {} });
    ok(r && r.ok === false, 'retorna erro');
    ok(/nenhum arquivo legível/i.test(r.error), 'mensagem PT-BR de nenhum legível');
  }

  // ===========================================================================
  console.log('\n== (d) caminho feliz -> generateExercisesFolder com os arquivos certos ==');
  MAPPING = {
    disciplinas: [{
      id: 'd2', nome: 'Física',
      arquivos: ['C:\\x\\prova.pdf', 'C:\\x\\quebrado.pdf', 'C:\\x\\aula.docx'],
    }],
  };
  TEXTOS = {
    'C:\\x\\prova.pdf': { ok: true, text: 'conteúdo da prova' },
    'C:\\x\\quebrado.pdf': { ok: false },                 // ilegível -> fora
    'C:\\x\\aula.docx': { ok: true, text: 'conteúdo da aula' },
  };
  ultimaChamadaGerar = null;
  {
    const r = await chamar({ folder: ROOT, discId: 'd2', options: { quantidade: 8, tipo: 'mistas' } });
    ok(r && r.ok === true, 'retorna ok no caminho feliz');
    ok(ultimaChamadaGerar !== null, 'generateExercisesFolder foi chamado');
    const files = (ultimaChamadaGerar && ultimaChamadaGerar.files) || [];
    eq(files.length, 2, 'passou só os 2 arquivos legíveis (ignora o ilegível)');
    const paths = files.map((f) => f.path);
    ok(paths.includes('C:\\x\\prova.pdf') && paths.includes('C:\\x\\aula.docx'), 'passou prova.pdf e aula.docx');
    ok(!paths.includes('C:\\x\\quebrado.pdf'), 'não passou o arquivo ilegível');
    // name derivado por string do path (sem tocar disco).
    ok(files.every((f) => typeof f.name === 'string' && f.name.length), 'cada arquivo tem name');
    const nomes = files.map((f) => f.name);
    ok(nomes.includes('prova.pdf') && nomes.includes('aula.docx'), 'names são os basenames corretos');
    // options repassadas + onToken injetado pelo main.
    ok(ultimaChamadaGerar.options.quantidade === 8 && ultimaChamadaGerar.options.tipo === 'mistas', 'repassa as options do renderer');
    ok(typeof ultimaChamadaGerar.options.onToken === 'function', 'injeta onToken (streaming) como no padrão da pasta inteira');
  }

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
