#!/usr/bin/env node
'use strict';

/**
 * BATERIA DE TESTE DE ESTRESSE / ENTRADAS ADVERSARIAIS — CábulIA / Estudo AI.
 *
 * Diferente do beta-tester.js (que exercita o caminho "feliz"), este agente
 * BOMBARDEIA os serviços com as entradas mais comuns E as mais "burras":
 * arquivos vazios, binários salvos como texto, PDFs/DOCX corrompidos, nomes com
 * emoji/acentos/MAIÚSCULAS, arquivos gigantes, HTML com <script>, JSON lixo da
 * IA, timeouts que nunca respondem, mtime NaN, caminhos inexistentes e por aí
 * vai. O objetivo é mapear os LIMITES REAIS do app: ele degrada com graça ou
 * quebra?
 *
 * Tudo roda OFFLINE e DETERMINÍSTICO (sem Ollama, sem rede): o fetch e o https
 * são stubados, e cada caso tem resposta programada. Rodar duas vezes produz
 * exatamente o mesmo conjunto de checks/resultados (RNF3).
 *
 * INVARIANTE SAGRADA (INV1): nada é escrito/movido/apagado fora de os.tmpdir().
 * As fixtures adversariais vivem numa pasta temporária dedicada criada com
 * fs.mkdtempSync, tratada como SOMENTE LEITURA e vigiada por um SENTINELA DE FS
 * (snapshot inicial × final). A pasta é removida em finally (INV6).
 *
 * COMUNICAÇÃO COM O DESENVOLVEDOR/AGENTE:
 *   - tests/estresse-bugs.json (legível por máquina).
 *   - tests/relatorio-estresse.md (relatório humano, PT-BR).
 *   - Sai com código != 0 se houver bug de severidade "crítica" OU "alta".
 *
 * Uso:  node tests/beta-tester-estresse.js   (ou  npm run test:stress)
 */

// ---- Mock de electron ANTES de qualquer require de módulo do app ----------
// Faz store/rag/classification persistirem em os.tmpdir() (nunca em userData).
const Module = require('module');
const orig = Module._load;
Module._load = function (req) {
  if (req === 'electron') return { app: { isPackaged: false, getPath: () => require('os').tmpdir() } };
  return orig.apply(this, arguments);
};

const fs = require('fs');
const path = require('path');
const os = require('os');

const SRC = path.join(__dirname, '..', 'src');
const RELATORIO = path.join(__dirname, 'relatorio-estresse.md');
const BUGS_JSON = path.join(__dirname, 'estresse-bugs.json');

// ---------------------------------------------------------------------------
// Coletor de resultados (idêntico ao beta-tester.js, estendido com 'crítica')
// ---------------------------------------------------------------------------
const bugs = [];      // { severidade, area, titulo, detalhe, sugestao }
const passes = [];    // nomes dos checks que passaram
let totalChecks = 0;

function bug(severidade, area, titulo, detalhe, sugestao) {
  bugs.push({ severidade, area, titulo, detalhe, sugestao: sugestao || '' });
}

// Executa um check nomeado. Exceção inesperada vira bug: 'crítica' quando o
// caso representa um caminho que o app expõe em produção (§5), senão 'alta'.
// Passe severidadeExcecao: 'crítica' no 4º argumento para promover.
async function check(area, nome, fn, severidadeExcecao = 'alta') {
  totalChecks++;
  try {
    await fn();
    passes.push(`${area} · ${nome}`);
  } catch (e) {
    if (e && e.__assert) {
      bug(e.severidade || 'alta', area, nome, e.message, e.sugestao);
    } else {
      bug(severidadeExcecao, area, nome, 'Exceção inesperada: ' + (e && e.stack ? e.stack.split('\n')[0] : e), 'Investigar a exceção no serviço envolvido.');
    }
  }
}

// Asserção que vira bug com severidade/sugestão configuráveis.
function assert(cond, message, { severidade = 'alta', sugestao = '' } = {}) {
  if (!cond) {
    const err = new Error(message);
    err.__assert = true;
    err.severidade = severidade;
    err.sugestao = sugestao;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Stub de fetch programável por caso (sem rede). Adaptado do beta-tester.js.
// ---------------------------------------------------------------------------
// Guarda o último prompt enviado para /api/generate (não-stream) para inspeção.
const capturado = { prompts: [] };

// responder(body) -> string (texto da resposta) OU
//   { response } | { __http500:true } | { __nunca:true } (nunca resolve).
// tagsStatus controla a resposta de /api/tags (200 = online, 500 = offline).
function instalarFetchStub(responder, { tagsStatus = 200 } = {}) {
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith('/api/tags')) {
      if (tagsStatus !== 200) return jsonResponse({ error: 'offline' }, tagsStatus);
      return jsonResponse({ models: [{ name: 'qwen2.5:7b' }] });
    }
    if (u.endsWith('/api/generate')) {
      const body = JSON.parse(opts.body || '{}');
      capturado.prompts.push(body.prompt || '');
      const r = responder(body);
      if (r && typeof r === 'object' && r.__http500) return jsonResponse({ error: 'boom' }, 500);
      if (r && typeof r === 'object' && r.__nunca) {
        // Nunca resolve por conta própria: só o AbortController do caller
        // (options.signal) rejeita a Promise (simula travamento do modelo).
        return new Promise((_resolve, reject) => {
          const sig = opts.signal;
          if (sig) {
            if (sig.aborted) return reject(abortError());
            sig.addEventListener('abort', () => reject(abortError()), { once: true });
          }
        });
      }
      const texto = typeof r === 'string' ? r : (r && r.response) || '';
      return jsonResponse({ response: texto });
    }
    return jsonResponse({}, 404);
  };
}

function abortError() {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

function jsonResponse(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
    body: null, // generateStream checa !res.body e cai para erro — testamos o caminho não-stream
  };
}

function restaurarFetch() {
  delete global.fetch;
}

// ---------------------------------------------------------------------------
// Stub de https.get para o updater (usa 'https', não fetch). Do beta-tester.js.
// ---------------------------------------------------------------------------
const https = require('https');
const { EventEmitter } = require('events');
const _httpsGetOriginal = https.get;

function instalarHttpsStub({ statusCode = 200, body = {} }) {
  https.get = (_options, cb) => {
    const res = new EventEmitter();
    res.statusCode = statusCode;
    setImmediate(() => {
      res.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
      res.emit('end');
    });
    if (cb) cb(res);
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = () => {};
    return req;
  };
}

function restaurarHttps() {
  https.get = _httpsGetOriginal;
}

// ---------------------------------------------------------------------------
// Sandbox de FS + sentinela de INV1
// ---------------------------------------------------------------------------
// RAIZ_TMP = pasta temporária dedicada; subpastas material/ (fixtures "do
// usuário", tratadas como SOMENTE LEITURA), userdata/ e saida/.
let RAIZ_TMP = null;
let DIR_MATERIAL = null;
let DIR_SAIDA = null;
let snapshotMaterial = null;

function criarSandbox() {
  RAIZ_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cabulia-stress-'));
  DIR_MATERIAL = path.join(RAIZ_TMP, 'material');
  DIR_SAIDA = path.join(RAIZ_TMP, 'saida');
  fs.mkdirSync(DIR_MATERIAL, { recursive: true });
  fs.mkdirSync(path.join(RAIZ_TMP, 'userdata'), { recursive: true });
  fs.mkdirSync(DIR_SAIDA, { recursive: true });
}

function removerSandbox() {
  if (RAIZ_TMP) {
    try { fs.rmSync(RAIZ_TMP, { recursive: true, force: true }); } catch {}
  }
}

// Snapshot de material/ (lista de arquivos + mtime + size) para o sentinela.
function tirarSnapshot(dir) {
  const mapa = {};
  const walk = (d) => {
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) {
        mapa[p] = { tipo: 'dir' };
        walk(p);
      } else {
        let st = { size: -1, mtimeMs: -1 };
        try { st = fs.statSync(p); } catch {}
        mapa[p] = { tipo: 'file', size: st.size, mtimeMs: st.mtimeMs };
      }
    }
  };
  walk(dir);
  return mapa;
}

// Compara snapshot inicial × atual de material/. Qualquer diferença é um bug
// CRÍTICA (viola INV1). Retorna [] quando intacto.
function conferirSentinela() {
  const atual = tirarSnapshot(DIR_MATERIAL);
  const difs = [];
  const chaves = new Set([...Object.keys(snapshotMaterial), ...Object.keys(atual)]);
  for (const k of chaves) {
    const a = snapshotMaterial[k];
    const b = atual[k];
    if (!a) { difs.push(`arquivo novo: ${k}`); continue; }
    if (!b) { difs.push(`arquivo removido: ${k}`); continue; }
    if (a.tipo !== b.tipo) { difs.push(`tipo mudou: ${k}`); continue; }
    if (a.tipo === 'file' && (a.size !== b.size || a.mtimeMs !== b.mtimeMs)) {
      difs.push(`conteúdo/mtime alterado: ${k}`);
    }
  }
  return difs;
}

async function checarSentinela(area, nome) {
  await check(area, nome, async () => {
    const difs = conferirSentinela();
    assert(difs.length === 0, 'O sentinela de FS detectou alteração em material/ (viola INV1): ' + difs.join('; '), {
      severidade: 'crítica',
      sugestao: 'Nenhum serviço deve escrever/mover/apagar na pasta de material. Investigar o caso anterior.',
    });
  }, 'crítica');
}

// ---------------------------------------------------------------------------
// Semeadura determinística das fixtures (catálogo do design §2)
// ---------------------------------------------------------------------------
// Buffer de bytes "aleatórios" determinísticos (LCG com seed fixa) — sem Math.random.
function bytesDeterministicos(n, seed) {
  const buf = Buffer.alloc(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (1103515245 * x + 12345) >>> 0;
    buf[i] = (x >>> 16) & 0xff;
  }
  return buf;
}

// Nome de arquivo longo, porém dentro do MAX_PATH do Windows (o caminho
// completo precisa caber). Mede o espaço restante a partir de DIR_MATERIAL.
function nomeLongo(dir) {
  const MAX_PATH = 255; // conservador (Windows clássico ~260 incluindo drive)
  const sufixo = '.txt';
  const base = dir.length + 1; // + separador
  const restante = Math.max(8, MAX_PATH - base - sufixo.length - 5);
  const tam = Math.min(180, restante);
  return 'n'.repeat(tam) + sufixo;
}

function semearFixtures(dir) {
  fs.writeFileSync(path.join(dir, 'vazio.txt'), '', 'utf-8');
  fs.writeFileSync(path.join(dir, 'so-espacos.txt'), '   \n\t  \n', 'utf-8');
  fs.writeFileSync(path.join(dir, 'binario.bin.txt'), bytesDeterministicos(2048, 1337));
  // PDF corrompido: bytes que NÃO são PDF, extensão .pdf.
  fs.writeFileSync(path.join(dir, 'corrompido.pdf'), Buffer.from('isto nao e um pdf de verdade\x00\x01\x02', 'binary'));
  // DOCX corrompido: zip inválido, extensão .docx.
  fs.writeFileSync(path.join(dir, 'corrompido.docx'), Buffer.from('PK\x03\x04 zip quebrado', 'binary'));
  fs.writeFileSync(path.join(dir, 'emoji 🔥 acentuação.md'), '# Título com acentuação\nConteúdo normal 🔥.', 'utf-8');
  fs.writeFileSync(path.join(dir, 'MAIUSCULA.TXT'), 'Texto em arquivo com extensão maiúscula.', 'utf-8');
  fs.writeFileSync(path.join(dir, nomeLongo(dir)), 'Arquivo de nome longo, dentro do limite do SO.', 'utf-8');
  // Grande ~3 MB: repetição determinística (RNF3).
  const bloco = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ';
  fs.writeFileSync(path.join(dir, 'grande.txt'), bloco.repeat(Math.ceil((3 * 1024 * 1024) / bloco.length)), 'utf-8');
  fs.writeFileSync(path.join(dir, 'com-script.html'), '<html><body><h1>Oi</h1><script>alert(1)</script><p>Texto visível</p></body></html>', 'utf-8');
  // Subpasta cujo nome casa a heurística 'prova'.
  const subProva = path.join(dir, 'Prova_2_Calculo');
  fs.mkdirSync(subProva, { recursive: true });
  fs.writeFileSync(path.join(subProva, 'p2.txt'), 'Questões da segunda prova de Cálculo.', 'utf-8');
  // Subpasta vazia (não deve virar notebook).
  fs.mkdirSync(path.join(dir, 'vazia'), { recursive: true });
}

// Caminhos de arquivos semeados (usados pelos casos).
function fx(nome) { return path.join(DIR_MATERIAL, nome); }

// ===========================================================================
// 3.1 Library
// ===========================================================================
async function testarLibrary() {
  const library = require(path.join(SRC, 'services', 'library.js'));
  const AREA = 'Library';

  await check(AREA, 'scan da pasta de material não lança e organiza notebooks', async () => {
    const lib = library.scan(DIR_MATERIAL);
    assert(lib && Array.isArray(lib.notebooks), 'scan não retornou { notebooks:[] }.');
    const nomes = lib.notebooks.map((n) => n.name);
    assert(!nomes.includes('vazia'), 'Subpasta vazia virou notebook (não deveria).', { severidade: 'média' });
    assert(nomes.includes('Prova_2_Calculo'), 'Notebook da subpasta Prova_2_Calculo não apareceu.', { severidade: 'média' });
    const geral = lib.notebooks.find((n) => n.name === 'Geral');
    assert(geral && geral.files.length >= 1, 'Arquivos soltos deveriam cair no notebook "Geral".', { severidade: 'média' });
  }, 'crítica');

  await check(AREA, 'scan de arquivo (não pasta) retorna notebooks vazios', async () => {
    const lib = library.scan(fx('vazio.txt'));
    assert(lib && Array.isArray(lib.notebooks) && lib.notebooks.length === 0, 'scan de um arquivo deveria dar { notebooks:[] }.');
  }, 'crítica');

  await check(AREA, 'scan de caminho inexistente retorna notebooks vazios', async () => {
    const lib = library.scan(path.join(DIR_MATERIAL, '__nao_existe__'));
    assert(lib && Array.isArray(lib.notebooks) && lib.notebooks.length === 0, 'scan de caminho inexistente deveria dar { notebooks:[] }.');
  }, 'crítica');

  await check(AREA, 'readFileText de arquivo vazio não lança', async () => {
    const r = await library.readFileText(fx('vazio.txt'));
    assert(r && r.ok === true && typeof r.text === 'string', 'Ler arquivo vazio deveria dar { ok:true, text:"" }.');
  }, 'crítica');

  await check(AREA, 'readFileText de arquivo só com espaços volta texto vazio', async () => {
    const r = await library.readFileText(fx('so-espacos.txt'));
    assert(r && r.ok === true, 'Ler arquivo só com espaços deveria dar ok:true.');
    assert(r.text.trim() === '', 'Após cleanup, texto só com espaços deveria ficar vazio.', { severidade: 'baixa' });
  }, 'crítica');

  await check(AREA, 'readFileText de binário salvo como .txt não quebra', async () => {
    const r = await library.readFileText(fx('binario.bin.txt'));
    assert(r && r.ok === true && typeof r.text === 'string', 'Ler binário como UTF-8 deveria dar ok:true (lossy), sem lançar.');
  }, 'crítica');

  await check(AREA, 'readFileText de PDF corrompido falha de forma controlada', async () => {
    const r = await library.readFileText(fx('corrompido.pdf'));
    assert(r && r.ok === false && r.error, 'PDF corrompido deveria dar { ok:false, error }.');
    assert(r.name === 'corrompido.pdf', 'name deveria ser preservado no erro.', { severidade: 'baixa' });
  }, 'crítica');

  await check(AREA, 'readFileText de DOCX corrompido falha de forma controlada', async () => {
    const r = await library.readFileText(fx('corrompido.docx'));
    assert(r && r.ok === false && r.error, 'DOCX corrompido deveria dar { ok:false, error }.');
  }, 'crítica');

  await check(AREA, 'readFileText de arquivo inexistente falha de forma controlada', async () => {
    const r = await library.readFileText(fx('__nao_existe__.xyz'));
    assert(r && r.ok === false && r.error, 'Arquivo inexistente deveria dar { ok:false, error }.');
  }, 'crítica');

  await check(AREA, 'readFileText de HTML remove <script> mantendo texto', async () => {
    const r = await library.readFileText(fx('com-script.html'));
    assert(r && r.ok === true, 'Ler HTML deveria dar ok:true.');
    assert(!/<script>/.test(r.text) && !/alert\(1\)/.test(r.text), 'stripHtml não removeu <script>/alert(1).', { sugestao: 'Revisar stripHtml() em library.js.' });
    assert(/Texto visível/.test(r.text), 'stripHtml perdeu o texto visível.', { severidade: 'média' });
  }, 'crítica');

  await check(AREA, 'readFileText com nome unicode (emoji/acentos) preserva name', async () => {
    const r = await library.readFileText(fx('emoji 🔥 acentuação.md'));
    assert(r && r.ok === true, 'Ler arquivo com nome unicode deveria dar ok:true.');
    assert(r.name === 'emoji 🔥 acentuação.md', 'name com emoji/acentos não foi preservado.', { severidade: 'baixa' });
  }, 'crítica');

  await check(AREA, 'readFileText de extensão maiúscula (.TXT) é suportada', async () => {
    assert(library.isSupported('MAIUSCULA.TXT') === true, 'isSupported deveria aceitar .TXT (lowercase na comparação).', { severidade: 'média' });
    const r = await library.readFileText(fx('MAIUSCULA.TXT'));
    assert(r && r.ok === true && /maiúscula/.test(r.text), 'Ler .TXT maiúsculo deveria dar ok:true com o conteúdo.');
  }, 'crítica');

  await check(AREA, 'readFileText de arquivo gigante (~3MB) não estoura', async () => {
    const t0 = Date.now();
    const r = await library.readFileText(fx('grande.txt'));
    const ms = Date.now() - t0;
    assert(r && r.ok === true && r.text.length > 1000000, 'Ler arquivo gigante deveria dar ok:true com texto grande.');
    assert(ms < 15000, `Leitura do arquivo gigante demorou demais (${ms}ms).`, { severidade: 'média' });
  }, 'crítica');

  await checarSentinela(AREA, 'INV1 — material/ intacto após os casos de library');
}

// ===========================================================================
// 3.2 IA (ai.js) com fetch stubado
// ===========================================================================
async function testarIA() {
  const ai = require(path.join(SRC, 'services', 'ai.js'));
  const AREA = 'IA';

  await check(AREA, 'mapa mental com JSON lixo retorna erro controlado', async () => {
    instalarFetchStub(() => 'não é json {');
    try {
      const r = await ai.generateMindmap('Texto.', {});
      assert(r && r.ok === false && r.error, 'JSON lixo deveria dar { ok:false, error }.');
    } finally { restaurarFetch(); }
  }, 'crítica');

  await check(AREA, 'mapa mental com JSON truncado retorna erro controlado', async () => {
    instalarFetchStub(() => '{"central":"X","nodes":[{');
    try {
      const r = await ai.generateMindmap('Texto.', {});
      assert(r && r.ok === false && r.error, 'JSON truncado deveria dar { ok:false, error }.');
    } finally { restaurarFetch(); }
  }, 'crítica');

  await check(AREA, 'mapa mental com resposta vazia retorna erro controlado', async () => {
    instalarFetchStub(() => '');
    try {
      const r = await ai.generateMindmap('Texto.', {});
      assert(r && r.ok === false && r.error, 'Resposta vazia deveria dar { ok:false, error }.');
    } finally { restaurarFetch(); }
  }, 'crítica');

  await check(AREA, 'mapa mental com JSON gigante normaliza sem estourar', async () => {
    const nodes = [];
    for (let i = 0; i < 3000; i++) nodes.push({ title: 'R' + i, children: ['s', { titulo: 'B', descricao: 'd' }] });
    const payload = JSON.stringify({ central: 'Tema', nodes });
    instalarFetchStub(() => payload);
    try {
      const t0 = Date.now();
      const r = await ai.generateMindmap('Texto.', {});
      const ms = Date.now() - t0;
      assert(r && r.ok === true && r.map && Array.isArray(r.map.nodes), 'JSON gigante válido deveria dar ok:true normalizado.');
      assert(ms < 10000, `Normalização do mapa gigante demorou demais (${ms}ms).`, { severidade: 'média' });
    } finally { restaurarFetch(); }
  }, 'crítica');

  await check(AREA, 'mapa mental com <script> no conteúdo é dado opaco (ok:true)', async () => {
    instalarFetchStub(() => JSON.stringify({ central: '<script>alert(1)</script>', nodes: [{ title: 'A', children: [{ titulo: 'B', descricao: '<script>x</script>' }] }] }));
    try {
      const r = await ai.generateMindmap('Texto.', {});
      assert(r && r.ok === true, 'Mapa com <script> no texto deveria dar ok:true (escape é do exporter).');
    } finally { restaurarFetch(); }
  }, 'crítica');

  await check(AREA, 'offline (/api/tags 500) devolve erro com prefixo amigável', async () => {
    instalarFetchStub(() => '# ok', { tagsStatus: 500 });
    try {
      const r = await ai.generate('Texto.', {});
      assert(r && r.ok === false && typeof r.error === 'string', 'Offline deveria dar { ok:false, error }.');
      assert(/^Ollama não está rodando/.test(r.error), 'Erro offline deveria começar com o prefixo "Ollama não está rodando".', { sugestao: 'Manter o prefixo literal em generate() quando checkStatus falha.' });
    } finally { restaurarFetch(); }
  }, 'crítica');

  await check(AREA, 'timeout simulado respeita o signal (retorna cancelado)', async () => {
    instalarFetchStub(() => ({ __nunca: true }));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300);
    const tetoTeste = setTimeout(() => { /* teto duro */ }, 5000);
    try {
      const corrida = ai.generate('Texto.', { signal: controller.signal });
      const teto = new Promise((_r, rej) => setTimeout(() => rej(new Error('TETO_TESTE')), 5000));
      const r = await Promise.race([corrida, teto]);
      assert(r && r.ok === false && r.error === 'cancelado', 'Com signal abortado, generate deveria retornar { ok:false, error:"cancelado" }.', { severidade: 'crítica' });
    } catch (e) {
      if (e && e.message === 'TETO_TESTE') {
        assert(false, 'generate NÃO retornou dentro do teto do teste mesmo após abort() — travamento sem respeitar cancelamento.', { severidade: 'crítica', sugestao: 'Garantir que o signal propague para o fetch interno.' });
      }
      throw e;
    } finally {
      clearTimeout(timer);
      clearTimeout(tetoTeste);
      restaurarFetch();
    }
  }, 'crítica');

  await check(AREA, 'prompt bem formado — idioma entra no prompt do resumo', async () => {
    capturado.prompts = [];
    instalarFetchStub(() => '# Resumo\nok');
    try {
      const r = await ai.generateSummary('Texto de teste.', { idioma: 'English', nivel: 'curto' });
      assert(r && r.ok === true, 'generateSummary deveria dar ok:true com fetch stubado.');
      assert(/English/.test(capturado.prompts.join('\n')), 'O idioma "English" não entrou no prompt do resumo.', { sugestao: 'Verificar instrucaoIdioma().' });
    } finally { restaurarFetch(); }
  }, 'crítica');

  await check(AREA, 'prompt bem formado — quantidade entra no prompt dos exercícios', async () => {
    capturado.prompts = [];
    instalarFetchStub(() => '# Lista\n1. ...');
    try {
      await ai.generateExercises('Texto.', { quantidade: 8, tipo: 'multipla' });
      assert(/8/.test(capturado.prompts.join('\n')), 'A quantidade (8) não entrou no prompt dos exercícios.', { severidade: 'média' });
    } finally { restaurarFetch(); }
  }, 'crítica');

  await check(AREA, 'generateSummaryFolder([]) devolve erro de pasta vazia', async () => {
    const r = await ai.generateSummaryFolder([]);
    assert(r && r.ok === false && r.error === 'A pasta não tem arquivos legíveis.', 'Pasta vazia deveria dar o erro específico de "sem arquivos legíveis".');
  }, 'crítica');
}

// ===========================================================================
// 3.3 Classificação
// ===========================================================================
async function testarClassificacao() {
  const cls = require(path.join(SRC, 'services', 'classification.js'));
  const AREA = 'Classificação';

  await check(AREA, 'classificarHeuristica com sinais degenerados nunca é null', async () => {
    const casos = [
      { path: '/a', name: '', relPath: '', snippet: '' },
      { path: '/b', name: '!@#$%', relPath: '', snippet: '***' },
      { path: '/c', name: '🔥🔥', relPath: '', snippet: '🔥' },
    ];
    for (const s of casos) {
      const r = cls.classificarHeuristica(s);
      assert(r && typeof r === 'object', 'classificarHeuristica retornou null/undefined.');
      assert(cls.TIPOS.includes(r.tipo), 'tipo fora do conjunto TIPOS: ' + r.tipo);
      assert(r.confianca >= 0 && r.confianca <= 1, 'confianca fora de [0,1]: ' + r.confianca);
    }
  }, 'crítica');

  await check(AREA, 'heurística respeita a prioridade (prova > lista > trabalho > aula)', async () => {
    const r = cls.classificarHeuristica({ path: '/x', name: 'Prova_lista_trabalho_aula', relPath: '', snippet: '' });
    assert(r.tipo === 'prova', 'Com várias pistas no nome, "prova" deveria vencer. Veio: ' + r.tipo, { severidade: 'média' });
  }, 'crítica');

  await check(AREA, 'parseTipoResponse com lixo cai tudo para "outro" sem throw', async () => {
    const lote = [{ path: '/a' }, { path: '/b' }];
    const out = cls.parseTipoResponse('isto não é json', lote);
    assert(Array.isArray(out) && out.length === 2 && out.every((x) => x.tipo === 'outro'), 'JSON lixo deveria cair tudo para "outro".');
  }, 'crítica');

  await check(AREA, 'parseTipoResponse com id fora de range / tipo inválido é defensivo', async () => {
    const lote = [{ path: '/a' }, { path: '/b' }];
    const raw = JSON.stringify({ arquivos: [{ id: 99, tipo: 'prova' }, { id: 0, tipo: 'inexistente' }, { id: 1, tipo: 'lista' }, 'nao-objeto'] });
    const out = cls.parseTipoResponse(raw, lote);
    assert(out[0].tipo === 'outro', 'id 0 com tipo inválido deveria cair para "outro".');
    assert(out[1].tipo === 'lista', 'id 1 com tipo válido deveria ser preservado.');
  }, 'crítica');

  await check(AREA, 'diffClassification com mtime NaN/ausente/0 não lança', async () => {
    const state = cls.estadoVazio('/root');
    const scanned = [
      { path: '/a', mtime: NaN },
      { path: '/b' },
      { path: '/c', mtime: 0 },
    ];
    const diff = cls.diffClassification(state, scanned);
    assert(diff && Array.isArray(diff.novos), 'diffClassification deveria retornar { novos:[] } sem lançar.');
    assert(diff.novos.length === 3, 'Arquivos sem assinatura prévia deveriam ser tratados como novos.', { severidade: 'média' });
  }, 'crítica');

  await check(AREA, 'setManual com tipo inválido retorna erro', async () => {
    const state = cls.estadoVazio('/root');
    const r = cls.setManual(state, '/a', 'tipo_invalido');
    assert(r && r.ok === false && r.error === 'Tipo inválido.', 'setManual com tipo inválido deveria dar { ok:false, error:"Tipo inválido." }.');
  }, 'crítica');

  await check(AREA, 'manual prevalece sobre merge automático', async () => {
    let state = cls.estadoVazio('/root');
    const r = cls.setManual(state, '/a', 'prova');
    assert(r.ok, 'setManual válido deveria dar ok:true.');
    state = r.state;
    state = cls.mergeResultados(state, { '/a': { tipo: 'aula', origem: cls.ORIGEM.IA } });
    assert(state.arquivos['/a'].tipo === 'prova' && state.arquivos['/a'].origem === cls.ORIGEM.MANUAL, 'O merge automático sobrescreveu uma decisão manual (não deveria).');
  }, 'crítica');

  await check(AREA, 'classificarComIA: offline no 1º lote é fatal controlado', async () => {
    const sinais = [{ path: '/a', name: 'x', relPath: '', snippet: '' }];
    const callGenerate = async () => ({ ok: false, error: 'Ollama não está rodando. Abra o Ollama.' });
    const r = await cls.classificarComIA(sinais, { callGenerate });
    assert(r && r.ok === false && r.error, 'Offline no 1º lote deveria dar { ok:false, error }.');
  }, 'crítica');

  await check(AREA, 'classificarComIA: callGenerate que lança vira "outro" recuperável', async () => {
    // 1º lote OK (para não ser fatal), e um 2º callGenerate que lança seria
    // recuperável; com um único lote, um throw no 1º não é "offline", então o
    // lote cai para 'outro' e o resultado é ok:true.
    const sinais = [{ path: '/a', name: 'x', relPath: '', snippet: '' }];
    const callGenerate = async () => { throw new Error('boom'); };
    const r = await cls.classificarComIA(sinais, { callGenerate });
    assert(r && r.ok === true, 'Exceção no callGenerate (não-offline) deveria ser recuperável (ok:true).');
    assert(r.porPath['/a'] && r.porPath['/a'].tipo === 'outro', 'O lote que falhou deveria cair para "outro".');
  }, 'crítica');

  await check(AREA, 'runClassification com entradas degeneradas persiste em os.tmpdir()', async () => {
    const scanned = [
      { path: fx('vazio.txt'), name: 'vazio.txt', mtime: 1 },
      { path: fx('MAIUSCULA.TXT'), name: 'MAIUSCULA.TXT', mtime: 2 },
    ];
    let chamadas = 0;
    const readText = async (p) => {
      chamadas++;
      if (chamadas === 1) throw new Error('falha de leitura simulada');
      return { ok: true, text: 'Prova de cálculo' };
    };
    const callGenerate = async () => ({ ok: true, text: JSON.stringify({ arquivos: [] }) });
    const r = await cls.runClassification({ rootFolder: '/stress-root', scannedFiles: scanned, readText, callGenerate });
    assert(r && r.ok === true, 'runClassification com entradas degeneradas deveria dar ok:true sem lançar.');
  }, 'crítica');

  await checarSentinela(AREA, 'INV1 — material/ intacto após os casos de classificação');
}

// ===========================================================================
// 3.4 Plano (núcleo puro)
// ===========================================================================
async function testarPlano() {
  const plano = require(path.join(SRC, 'services', 'plano.js'));
  const AREA = 'Plano';

  await check(AREA, 'priorizarAssuntos com lista vazia retorna []', async () => {
    const r = plano.priorizarAssuntos({ assuntos: [], tiposPorPath: {} });
    assert(Array.isArray(r) && r.length === 0, 'Lista vazia deveria dar [].');
  }, 'crítica');

  await check(AREA, 'assunto com arquivos vazios dá escore 0 sem NaN', async () => {
    const r = plano.priorizarAssuntos({ assuntos: [{ id: 'a', nome: 'A', arquivos: [] }], tiposPorPath: {} });
    assert(r[0].escore === 0 && Number.isFinite(r[0].escore), 'escore de assunto vazio deveria ser 0 finito.');
  }, 'crítica');

  await check(AREA, 'tiposPorPath vazio trata tudo como "outro" (peso 0.25)', async () => {
    const r = plano.priorizarAssuntos({ assuntos: [{ id: 'a', nome: 'A', arquivos: [{ path: '/a', mtime: 10 }] }], tiposPorPath: {} });
    assert(Number.isFinite(r[0].somaPesos), 'somaPesos deveria ser finito.');
    assert(r[0].arquivos[0].tipo === 'outro' && r[0].arquivos[0].peso === plano.PESO_TIPO.outro, 'Path sem tipo deveria pesar como "outro".');
  }, 'crítica');

  await check(AREA, 'mtime ausente/NaN produz escore finito e fatorRecencia em [1.0,1.2]', async () => {
    const r = plano.priorizarAssuntos({
      assuntos: [{ id: 'a', nome: 'A', arquivos: [{ path: '/a' }, { path: '/b', mtime: NaN }, { path: '/c', mtime: 100 }] }],
      tiposPorPath: { '/c': 'prova' },
    });
    assert(Number.isFinite(r[0].escore), 'escore deveria ser finito mesmo com mtime NaN/ausente.');
    assert(Number.isFinite(r[0].fatorRecencia) && r[0].fatorRecencia >= 1.0 && r[0].fatorRecencia <= 1.2, 'fatorRecencia fora de [1.0,1.2]: ' + r[0].fatorRecencia);
  }, 'crítica');

  await check(AREA, 'empate de escore desempata por mtimeMaisRecente desc', async () => {
    const r = plano.priorizarAssuntos({
      assuntos: [
        { id: 'velho', nome: 'Velho', arquivos: [{ path: '/v', mtime: 10 }] },
        { id: 'novo', nome: 'Novo', arquivos: [{ path: '/n', mtime: 200 }] },
      ],
      tiposPorPath: { '/v': 'prova', '/n': 'prova' },
    });
    assert(r[0].id === 'novo', 'Com mesmo escore, o de mtime mais recente deveria vir primeiro.', { severidade: 'média' });
  }, 'crítica');

  await check(AREA, 'nenhum escore/fatorRecencia é NaN/Infinity', async () => {
    const r = plano.priorizarAssuntos({
      assuntos: [{ id: 'a', nome: 'A', arquivos: [{ path: '/a', mtime: Infinity }, { path: '/b', mtime: -Infinity }] }],
      tiposPorPath: {},
    });
    assert(Number.isFinite(r[0].escore) && Number.isFinite(r[0].fatorRecencia), 'escore/fatorRecencia deveriam ser finitos mesmo com mtime Infinity.');
  }, 'crítica');

  await check(AREA, 'gerarPlano sem classState/mapping devolve erros nomeados', async () => {
    const askNunca = async () => { throw new Error('ask não deveria ser chamado'); };
    const r1 = await plano.gerarPlano({ rootFolder: '/r', discId: 'd', mapping: { disciplinas: [] }, classState: null, ask: askNunca });
    assert(r1 && r1.ok === false && r1.error === 'SEM_CLASSIFICACAO', 'Sem classState deveria dar SEM_CLASSIFICACAO.');
    const r2 = await plano.gerarPlano({ rootFolder: '/r', discId: 'd', mapping: null, classState: { arquivos: {} }, ask: askNunca });
    assert(r2 && r2.ok === false && r2.error === 'SEM_MAPEAMENTO', 'Sem mapping deveria dar SEM_MAPEAMENTO.');
  }, 'crítica');
}

// ===========================================================================
// 3.5 Exporter (escritas só em RAIZ_TMP/saida/)
// ===========================================================================
async function testarExporter() {
  const exporter = require(path.join(SRC, 'services', 'exporter.js'));
  const AREA = 'Exporter';

  await check(AREA, 'suggestFilename sanea título e usa sufixo correto', async () => {
    const nome = exporter.suggestFilename('Aula: Circuitos / RLC *2*', 'summary');
    assert(!/[\/:*]/.test(nome), 'suggestFilename deixou caracteres inválidos: ' + nome, { severidade: 'média' });
    assert(/resumo/.test(nome), 'Sufixo "resumo" não aplicado para kind=summary.', { severidade: 'baixa' });
    assert(nome.length <= 80, 'Nome sugerido ficou longo demais: ' + nome.length, { severidade: 'baixa' });
  }, 'crítica');

  await check(AREA, 'suggestFilename com título vazio usa "estudo-ai" + kind', async () => {
    const nome = exporter.suggestFilename('', 'kind_desconhecido');
    assert(/estudo-ai/.test(nome) && /kind_desconhecido/.test(nome), 'Título vazio + kind desconhecido deveria usar "estudo-ai" e o próprio kind.', { severidade: 'baixa' });
  }, 'crítica');

  await check(AREA, 'save de resumo .md grava o texto em saida/', async () => {
    const dest = path.join(DIR_SAIDA, 'r.md');
    const res = exporter.save(dest, 'summary', { text: '# R\nconteúdo' });
    assert(res && res.ok, 'save de markdown deveria dar ok:true: ' + (res && res.error));
    assert(/# R/.test(fs.readFileSync(dest, 'utf-8')), 'Markdown exportado não contém o texto.');
  }, 'crítica');

  await check(AREA, 'save de .html escapa <script> (sem injeção)', async () => {
    const dest = path.join(DIR_SAIDA, 'x.html');
    const res = exporter.save(dest, 'summary', { text: '<script>alert(1)</script>' });
    assert(res && res.ok, 'save de html deveria dar ok:true.');
    const lido = fs.readFileSync(dest, 'utf-8');
    assert(!/<script>alert\(1\)<\/script>/.test(lido), 'HTML não escapou <script> literal.', { sugestao: 'Confirmar escapeHtml().' });
    assert(/&lt;script&gt;/.test(lido), 'HTML deveria conter &lt;script&gt;.', { severidade: 'média' });
  }, 'crítica');

  await check(AREA, 'save de mapa mental vira markdown com central/ramo/sub/descrição', async () => {
    const dest = path.join(DIR_SAIDA, 'm.md');
    const map = { central: 'T', nodes: [{ title: 'R', children: ['s', { titulo: 'B', descricao: 'd' }] }] };
    const res = exporter.save(dest, 'mindmap', { map });
    assert(res && res.ok, 'save de mapa deveria dar ok:true.');
    const lido = fs.readFileSync(dest, 'utf-8');
    assert(/T/.test(lido) && /R/.test(lido) && /B/.test(lido) && /d/.test(lido), 'Markdown do mapa sem central/ramo/sub/descrição.');
  }, 'crítica');

  await check(AREA, 'save com payload null/{} gera arquivo vazio controlado', async () => {
    const d1 = path.join(DIR_SAIDA, 'v1.md');
    const d2 = path.join(DIR_SAIDA, 'v2.md');
    const r1 = exporter.save(d1, 'summary', null);
    const r2 = exporter.save(d2, 'summary', {});
    assert(r1 && r1.ok && r2 && r2.ok, 'payload null/{} deveria dar ok:true (vazio controlado).', { severidade: 'média' });
  }, 'crítica');

  await check(AREA, 'save em drive inválido falha de forma controlada', async () => {
    const res = exporter.save('Z:\\caminho\\inexistente\\x.md', 'summary', { text: 'x' });
    assert(res && res.ok === false && res.error, 'Destino inválido deveria dar { ok:false, error } sem lançar.');
  }, 'crítica');
}

// ===========================================================================
// 3.6 Store (persiste em os.tmpdir())
// ===========================================================================
async function testarStore() {
  const store = require(path.join(SRC, 'services', 'store.js'));
  const AREA = 'Store';

  await check(AREA, 'set/get persiste valor', async () => {
    store.set('__stress_k__', 'v');
    assert(store.get('__stress_k__') === 'v', 'store.get não devolveu o valor gravado.');
  }, 'crítica');

  await check(AREA, 'setCache/getCache persiste objeto', async () => {
    store.setCache('__stress_c__', { t: 1 });
    const v = store.getCache('__stress_c__');
    assert(v && v.t === 1, 'getCache não devolveu o objeto gravado.');
  }, 'crítica');

  await check(AREA, 'getCache de chave inexistente retorna null (não undefined)', async () => {
    assert(store.getCache('__nunca_gravei_stress__') === null, 'getCache de chave inexistente deveria ser null.', { severidade: 'baixa' });
  }, 'crítica');

  await check(AREA, 'set com valor não-serializável não lança (grava false)', async () => {
    const ciclo = {};
    ciclo.self = ciclo; // JSON.stringify lançaria no writeJson, pego por try/catch
    const v = store.set('__stress_ciclo__', ciclo);
    // store.set retorna o próprio valor; o importante é NÃO lançar.
    assert(v === ciclo, 'set deveria retornar o valor passado mesmo com objeto cíclico.');
  }, 'crítica');
}

// ===========================================================================
// 3.7 RAG (núcleo puro)
// ===========================================================================
async function testarRag() {
  const rag = require(path.join(SRC, 'services', 'rag.js'));
  const AREA = 'RAG';

  await check(AREA, 'chunkText de vazio/espaços retorna []', async () => {
    assert(rag.chunkText('').length === 0, 'chunkText("") deveria dar [].');
    assert(rag.chunkText('   ').length === 0, 'chunkText("   ") deveria dar [].');
  }, 'crítica');

  await check(AREA, 'chunkText de texto gigante cobre tudo sem loop infinito', async () => {
    const texto = 'palavra '.repeat(50000); // ~400 KB
    const t0 = Date.now();
    const chunks = rag.chunkText(texto);
    const ms = Date.now() - t0;
    assert(chunks.length > 0, 'Texto grande deveria gerar chunks.');
    assert(chunks.every((c) => c.trecho.length <= 1200), 'Algum chunk passou do tamanho esperado.', { severidade: 'média' });
    assert(ms < 10000, `chunkText demorou demais (${ms}ms) — risco de loop.`, { severidade: 'crítica' });
  }, 'crítica');

  await check(AREA, 'cosineSimilarity é defensivo (tamanhos/norma zero/não-array)', async () => {
    assert(rag.cosineSimilarity([1, 2], [1, 2, 3]) === 0, 'Tamanhos diferentes deveriam dar 0.');
    assert(rag.cosineSimilarity([0, 0], [0, 0]) === 0, 'Norma zero deveria dar 0.');
    assert(rag.cosineSimilarity(null, [1]) === 0, 'Não-array deveria dar 0.');
  }, 'crítica');

  await check(AREA, 'topK ignora chunks sem vetor e normaliza k inválido', async () => {
    const chunks = [
      { path: '/a', trecho: 'a', vetor: [1, 0] },
      { path: '/b', trecho: 'b' },
      { path: '/c', trecho: 'c', vetor: [0, 1] },
    ];
    const r = rag.topK([1, 0], chunks, NaN);
    assert(Array.isArray(r) && r.every((x) => Array.isArray(x.chunk.vetor)), 'topK deveria ignorar chunks sem vetor.');
    assert(r.length <= 5, 'k inválido (NaN) deveria cair para o padrão (<=5).', { severidade: 'baixa' });
  }, 'crítica');

  await check(AREA, 'normalizeEmbedResponse lança nos formatos inválidos (contrato)', async () => {
    const invalidos = [{}, { embeddings: [] }, { embeddings: [[1, NaN]] }, { embeddings: [[1, 2], [1]] }];
    for (const data of invalidos) {
      let lancou = false;
      try { rag.normalizeEmbedResponse(data); } catch (e) {
        lancou = /formato inesperado/.test(e.message);
      }
      assert(lancou, 'normalizeEmbedResponse deveria lançar "formato inesperado" para: ' + JSON.stringify(data));
    }
  });

  await check(AREA, 'buildAnswerPrompt tem instrução anti-alucinação e numera fontes', async () => {
    const prompt = rag.buildAnswerPrompt('O que é X?', [{ path: '/a.txt', trecho: 'conteúdo' }, { path: '/b.txt', trecho: 'mais' }]);
    assert(/Não encontrei isso no material indexado\./.test(prompt), 'Prompt sem a instrução anti-alucinação esperada.');
    assert(/\[1\]/.test(prompt) && /\[2\]/.test(prompt), 'Prompt deveria numerar as fontes.', { severidade: 'média' });
  }, 'crítica');

  await check(AREA, 'fileSig arredonda mtime e trata NaN', async () => {
    assert(rag.fileSig({ mtime: 123.9, size: 10 }) === '124::10', 'fileSig deveria arredondar mtime: ' + rag.fileSig({ mtime: 123.9, size: 10 }));
    assert(rag.fileSig({ mtime: NaN, size: NaN }) === '0::0', 'fileSig com NaN deveria dar "0::0".');
  }, 'crítica');

  await check(AREA, 'diffForIndex ignora itens sem path e não lança', async () => {
    const r = rag.diffForIndex({ fileSignatures: {} }, { scannedPaths: [{}, { path: '/a' }], files: [{}, { path: '/a', mtime: 1, size: 2 }] });
    assert(r && Array.isArray(r.novos), 'diffForIndex deveria retornar objeto com arrays.');
    assert(r.novos.length === 1 && r.novos[0].path === '/a', 'Itens sem path deveriam ser ignorados.', { severidade: 'média' });
  }, 'crítica');
}

// ===========================================================================
// 3.8 Updater (https stubado; sem applyUpdate)
// ===========================================================================
async function testarUpdater() {
  const updater = require(path.join(SRC, 'services', 'updater.js'));
  const AREA = 'Updater';

  await check(AREA, 'isGitRepo coerente com existência de .git na raiz', async () => {
    const raiz = path.resolve(__dirname, '..');
    const temGit = fs.existsSync(path.join(raiz, '.git'));
    assert(updater.isGitRepo() === temGit, 'isGitRepo() divergiu da existência real de .git.', { severidade: 'média' });
  });

  await check(AREA, 'REPO_URL aponta para um repositório GitHub', async () => {
    assert(/github\.com\/.+\/.+/.test(updater.REPO_URL), 'REPO_URL não parece URL de repositório GitHub.', { severidade: 'baixa' });
  });

  await check(AREA, 'checkForUpdates com GitHub 200 retorna formato esperado', async () => {
    instalarHttpsStub({ statusCode: 200, body: { sha: 'a'.repeat(40) } });
    try {
      const r = await updater.checkForUpdates();
      assert(r && r.ok === true, 'checkForUpdates deveria dar ok:true com API simulada: ' + JSON.stringify(r));
      assert(typeof r.updateAvailable === 'boolean', 'updateAvailable deveria ser boolean.', { severidade: 'média' });
      assert('canApply' in r, 'Faltou canApply no retorno.', { severidade: 'baixa' });
    } finally { restaurarHttps(); }
  }, 'crítica');

  await check(AREA, 'checkForUpdates com GitHub 500 falha de forma controlada', async () => {
    instalarHttpsStub({ statusCode: 500, body: { error: 'boom' } });
    try {
      const r = await updater.checkForUpdates();
      assert(r && r.ok === false && r.error, 'GitHub 500 deveria dar { ok:false, error } sem lançar.');
    } finally { restaurarHttps(); }
  }, 'crítica');

  await checarSentinela(AREA, 'INV1 — material/ intacto ao final da bateria');
}

// ---------------------------------------------------------------------------
// Relatório + comunicação (padrão do beta-tester.js, com 'crítica')
// ---------------------------------------------------------------------------
function gerarSaida() {
  const ordem = { 'crítica': 0, alta: 1, 'média': 2, baixa: 3 };
  bugs.sort((a, b) => (ordem[a.severidade] ?? 9) - (ordem[b.severidade] ?? 9));

  const critica = bugs.filter((b) => b.severidade === 'crítica').length;
  const alta = bugs.filter((b) => b.severidade === 'alta').length;
  const media = bugs.filter((b) => b.severidade === 'média').length;
  const baixa = bugs.filter((b) => b.severidade === 'baixa').length;

  const payload = {
    gerado_em: new Date().toISOString(),
    resumo: { checks: totalChecks, passaram: passes.length, bugs: bugs.length, critica, alta, media, baixa },
    bugs,
    passes,
  };
  fs.writeFileSync(BUGS_JSON, JSON.stringify(payload, null, 2), 'utf-8');

  const emoji = { 'crítica': '🟣', alta: '🔴', 'média': '🟡', baixa: '🔵' };
  let md = `# Relatório de Teste de Estresse — CábulIA / Estudo AI\n\n`;
  md += `Gerado em: ${new Date().toLocaleString('pt-BR')}\n\n`;
  md += `Esta bateria bombardeia os serviços com entradas adversariais (das mais comuns às\n`;
  md += `mais "burras"), 100% offline e determinística, para mapear os limites reais do app.\n\n`;
  md += `**Checks:** ${totalChecks} · **Passaram:** ${passes.length} · **Bugs:** ${bugs.length} `;
  md += `(🟣 ${critica} crítica · 🔴 ${alta} alta · 🟡 ${media} média · 🔵 ${baixa} baixa)\n\n`;

  if (!bugs.length) {
    md += '✅ Nenhum bug encontrado nos checks de estresse — o app degradou com graça em todos os casos.\n\n';
  } else {
    md += `## Bugs encontrados\n\n`;
    md += `| Sev | Área | Problema | Sugestão de correção |\n|-----|------|----------|----------------------|\n`;
    for (const b of bugs) {
      const det = (b.titulo + ' — ' + b.detalhe).replace(/\n/g, ' ').replace(/\|/g, '\\|');
      md += `| ${emoji[b.severidade] || ''} | ${b.area} | ${det} | ${(b.sugestao || '').replace(/\|/g, '\\|')} |\n`;
    }
    md += '\n';
  }

  md += `## Cobertura\n\n`;
  md += `- A pasta de material adversarial vive só em \`os.tmpdir()\` e é tratada como somente leitura (sentinela de FS / INV1).\n`;
  md += `- \`updater.applyUpdate\` NÃO é exercitado (faria git pull/npm install reais — fora de escopo).\n\n`;

  md += `## Checks que passaram (${passes.length})\n\n`;
  for (const p of passes) md += `- ✅ ${p}\n`;
  md += `\n> O arquivo \`tests/estresse-bugs.json\` traz os mesmos dados em formato legível por máquina.\n`;

  fs.writeFileSync(RELATORIO, md, 'utf-8');

  return { critica, alta, media, baixa };
}

// ---------------------------------------------------------------------------
async function main() {
  console.log('🧪💥 Bateria de teste de estresse — bombardeando o app (offline)...\n');

  criarSandbox();
  try {
    semearFixtures(DIR_MATERIAL);
    snapshotMaterial = tirarSnapshot(DIR_MATERIAL);

    await testarLibrary();
    await testarIA();
    await testarClassificacao();
    await testarPlano();
    await testarExporter();
    await testarStore();
    await testarRag();
    await testarUpdater();

    const { critica, alta, media, baixa } = gerarSaida();

    console.log(`\nConcluído: ${totalChecks} checks, ${passes.length} ok, ${bugs.length} bug(s).`);
    console.log(`  🟣 ${critica} crítica · 🔴 ${alta} alta · 🟡 ${media} média · 🔵 ${baixa} baixa`);
    console.log(`Relatório: ${RELATORIO}`);
    console.log(`Bugs (JSON): ${BUGS_JSON}`);

    // Falha o processo se houver bug crítico OU alto (RF5/CA1).
    if (critica > 0 || alta > 0) process.exitCode = 1;
  } finally {
    // INV6: remove a pasta temporária mesmo em caso de erro.
    removerSandbox();
  }
}

main().catch((e) => {
  console.error('Falha na bateria de estresse:', e && e.stack ? e.stack : e);
  removerSandbox();
  process.exitCode = 2;
});
