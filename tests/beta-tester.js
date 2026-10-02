#!/usr/bin/env node
'use strict';

/**
 * AGENTE DE BETA TESTING do Estudo AI.
 *
 * Diferente dos outros agentes (que fazem análise estática ou testam a IA real),
 * este agente EXERCITA DE VERDADE a lógica dos serviços e as regras da interface,
 * procurando bugs funcionais — sem depender do Ollama nem abrir a janela.
 *
 * Para testar o módulo de IA sem rede, ele faz um "stub" do fetch global,
 * simulando as respostas do Ollama. Assim conseguimos verificar:
 *   - construção dos prompts (idioma e foco entram mesmo?),
 *   - normalização e validação do mapa mental,
 *   - orçamento de tokens dos exercícios,
 *   - tratamento de erro quando a IA falha.
 *
 * COMUNICAÇÃO COM O DESENVOLVEDOR/AGENTE:
 *   - Grava tests/beta-bugs.json (formato legível por máquina), que o
 *     desenvolvedor (ou outro agente) lê para corrigir os bugs.
 *   - Grava tests/relatorio-beta.md (relatório humano).
 *   - Sai com código != 0 se houver bug de severidade alta (útil em CI/hook).
 *
 * Uso:  node tests/beta-tester.js   (ou  npm run test:beta)
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const SRC = path.join(RAIZ, 'src');
const PASTA_TESTE = path.join(__dirname, 'pasta-teste');
const RELATORIO = path.join(__dirname, 'relatorio-beta.md');
const BUGS_JSON = path.join(__dirname, 'beta-bugs.json');

// ---------------------------------------------------------------------------
// Coletor de resultados
// ---------------------------------------------------------------------------
const bugs = [];      // { severidade, area, titulo, detalhe, sugestao }
const passes = [];    // nomes dos checks que passaram
let totalChecks = 0;

function bug(severidade, area, titulo, detalhe, sugestao) {
  bugs.push({ severidade, area, titulo, detalhe, sugestao: sugestao || '' });
}

// Executa um check nomeado, capturando exceções como bug "alta".
async function check(area, nome, fn) {
  totalChecks++;
  try {
    await fn();
    passes.push(`${area} · ${nome}`);
  } catch (e) {
    if (e && e.__assert) {
      bug(e.severidade || 'alta', area, nome, e.message, e.sugestao);
    } else {
      bug('alta', area, nome, 'Exceção inesperada: ' + (e && e.stack ? e.stack.split('\n')[0] : e), 'Investigar a exceção no serviço envolvido.');
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
// Stub de fetch para simular o Ollama (sem rede)
// ---------------------------------------------------------------------------
// Guarda o último prompt enviado para /api/generate (não-stream) para inspeção.
const capturado = { prompts: [] };

function instalarFetchStub(responder) {
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith('/api/tags')) {
      return jsonResponse({ models: [{ name: 'qwen2.5:7b' }] });
    }
    if (u.endsWith('/api/generate')) {
      const body = JSON.parse(opts.body || '{}');
      capturado.prompts.push(body.prompt || '');
      const texto = responder(body);
      // stream:false => resposta única { response }
      return jsonResponse({ response: texto });
    }
    return jsonResponse({}, 404);
  };
}

function jsonResponse(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
    body: null, // generateStream checa !res.body e cai para erro — por isso testamos o caminho não-stream
  };
}

function restaurarFetch() {
  delete global.fetch;
}

// ---------------------------------------------------------------------------
// Stub de https.get para simular a API do GitHub (o updater usa 'https', não fetch)
// ---------------------------------------------------------------------------
const https = require('https');
const { EventEmitter } = require('events');
const _httpsGetOriginal = https.get;

// Faz https.get chamar o callback com uma resposta simulada { statusCode, corpo }.
function instalarHttpsStub({ statusCode = 200, body = {} }) {
  https.get = (_options, cb) => {
    const res = new EventEmitter();
    res.statusCode = statusCode;
    // Entrega o corpo de forma assíncrona, como faria a rede real.
    setImmediate(() => {
      res.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
      res.emit('end');
    });
    if (cb) cb(res);
    const req = new EventEmitter();
    req.setTimeout = () => req; // o updater chama req.setTimeout(...)
    req.destroy = () => {};
    return req;
  };
}

function restaurarHttps() {
  https.get = _httpsGetOriginal;
}

// ---------------------------------------------------------------------------
// 1. Testes do library (varredura e leitura reais em tests/pasta-teste)
// ---------------------------------------------------------------------------
async function testarLibrary() {
  const library = require(path.join(SRC, 'services', 'library.js'));

  await check('Library', 'scan encontra arquivos da pasta de teste', async () => {
    assert(fs.existsSync(PASTA_TESTE), 'tests/pasta-teste não existe (necessária para o teste).', { severidade: 'média', sugestao: 'Manter arquivos de exemplo em tests/pasta-teste.' });
    const lib = library.scan(PASTA_TESTE);
    const arquivos = (lib.notebooks || []).flatMap((n) => n.files);
    assert(arquivos.length >= 1, 'scan() não retornou nenhum arquivo da pasta de teste.', { sugestao: 'Verificar isSupported()/collectFiles() em library.js.' });
  });

  await check('Library', 'leitura de arquivo texto retorna conteúdo', async () => {
    const lib = library.scan(PASTA_TESTE);
    const arquivos = (lib.notebooks || []).flatMap((n) => n.files);
    const txt = arquivos.find((f) => f.ext === '.txt' || f.ext === '.md');
    assert(txt, 'Nenhum .txt/.md na pasta de teste para ler.', { severidade: 'média' });
    const r = await library.readFileText(txt.path);
    assert(r.ok && r.text && r.text.trim().length > 0, 'readFileText não devolveu texto válido para ' + (txt && txt.name), { sugestao: 'Checar cleanup()/leitura utf-8 em library.js.' });
  });

  await check('Library', 'arquivo inexistente falha de forma controlada', async () => {
    const r = await library.readFileText(path.join(PASTA_TESTE, '__nao_existe__.txt'));
    assert(r && r.ok === false && r.error, 'Ler arquivo inexistente deveria retornar { ok:false, error }.', { sugestao: 'Garantir try/catch em readFileText.' });
  });

  await check('Library', 'stripHtml remove tags (via extensão .html simulada)', async () => {
    const tmp = path.join(PASTA_TESTE, '__beta_tmp__.html');
    fs.writeFileSync(tmp, '<html><body><h1>Oi</h1><script>alert(1)</script><p>Texto</p></body></html>', 'utf-8');
    try {
      const r = await library.readFileText(tmp);
      assert(r.ok, 'Falha ao ler HTML temporário.');
      assert(!/<h1>|<script>/.test(r.text), 'stripHtml não removeu as tags HTML.', { sugestao: 'Revisar stripHtml() em library.js.' });
      assert(/Oi/.test(r.text) && /Texto/.test(r.text) && !/alert\(1\)/.test(r.text), 'stripHtml perdeu texto ou manteve conteúdo de <script>.', { severidade: 'média' });
    } finally {
      fs.existsSync(tmp) && fs.unlinkSync(tmp);
    }
  });
}

// ---------------------------------------------------------------------------
// 2. Testes do exporter (markdown/html dos 3 tipos)
// ---------------------------------------------------------------------------
async function testarExporter() {
  const exporter = require(path.join(SRC, 'services', 'exporter.js'));
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'beta-exp-'));

  await check('Exporter', 'suggestFilename sanea título e usa sufixo correto', async () => {
    const nome = exporter.suggestFilename('Aula: Circuitos / RLC *2*', 'summary');
    assert(!/[\/:*]/.test(nome), 'suggestFilename deixou caracteres inválidos de nome de arquivo: ' + nome, { severidade: 'média', sugestao: 'Reforçar o regex de sanitização em suggestFilename.' });
    assert(/resumo/.test(nome), 'Sufixo "resumo" não aplicado para kind=summary.', { severidade: 'baixa' });
  });

  await check('Exporter', 'salva resumo em .md com o texto', async () => {
    const dest = path.join(tmpDir, 'r.md');
    const res = exporter.save(dest, 'summary', { text: '# Resumo\nConteúdo' });
    assert(res.ok, 'save() falhou para markdown: ' + res.error);
    const lido = fs.readFileSync(dest, 'utf-8');
    assert(/# Resumo/.test(lido), 'Markdown exportado não contém o texto esperado.');
  });

  await check('Exporter', 'mapa mental vira markdown com ramos e descrições', async () => {
    const dest = path.join(tmpDir, 'm.md');
    const map = { central: 'Tema', nodes: [{ title: 'Ramo', children: [{ titulo: 'Sub', descricao: 'Explica' }] }] };
    const res = exporter.save(dest, 'mindmap', { map });
    assert(res.ok, 'save() falhou para mapa: ' + res.error);
    const lido = fs.readFileSync(dest, 'utf-8');
    assert(/Tema/.test(lido) && /Ramo/.test(lido) && /Sub/.test(lido) && /Explica/.test(lido), 'Markdown do mapa não contém central/ramo/sub/descrição.', { sugestao: 'Revisar toMarkdown(mindmap) em exporter.js.' });
  });

  await check('Exporter', 'HTML escapa conteúdo (sem injeção)', async () => {
    const dest = path.join(tmpDir, 'x.html');
    const res = exporter.save(dest, 'summary', { text: '<script>alert(1)</script>' });
    assert(res.ok, 'save() falhou para html: ' + res.error);
    const lido = fs.readFileSync(dest, 'utf-8');
    assert(!/<script>alert\(1\)<\/script>/.test(lido), 'HTML exportado não escapou <script> — risco de conteúdo não escapado.', { sugestao: 'Confirmar escapeHtml() antes de inserir no corpo.' });
    assert(/&lt;script&gt;/.test(lido), 'HTML exportado deveria conter a versão escapada &lt;script&gt;.', { severidade: 'média' });
  });

  await check('Exporter', 'payload vazio não quebra (gera arquivo vazio controlado)', async () => {
    const dest = path.join(tmpDir, 'v.md');
    const res = exporter.save(dest, 'summary', null);
    assert(res.ok, 'save() quebrou com payload null em vez de gerar vazio controlado.', { severidade: 'média', sugestao: 'toMarkdown já trata null; manter.' });
  });

  // limpeza
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------------------
// 3. Testes do store (config + cache persistem)
// ---------------------------------------------------------------------------
async function testarStore() {
  const store = require(path.join(SRC, 'services', 'store.js'));

  await check('Store', 'set/get persiste valor', async () => {
    const chave = '__beta_cfg__';
    store.set(chave, 'valor-123');
    assert(store.get(chave) === 'valor-123', 'store.get não devolveu o valor gravado por set.');
  });

  await check('Store', 'cache set/get persiste objeto', async () => {
    const chave = '__beta_cache__';
    store.setCache(chave, { text: 'oi' });
    const v = store.getCache(chave);
    assert(v && v.text === 'oi', 'store.getCache não devolveu o objeto gravado.');
  });

  await check('Store', 'cache inexistente retorna null (não undefined)', async () => {
    const v = store.getCache('__nunca_gravei__');
    assert(v === null, 'getCache de chave inexistente deveria ser null.', { severidade: 'baixa' });
  });
}

// ---------------------------------------------------------------------------
// 4. Testes do ai.js com fetch simulado (idioma, foco, mapa, exercícios)
// ---------------------------------------------------------------------------
async function testarAi() {
  const ai = require(path.join(SRC, 'services', 'ai.js'));

  // 4a. Idioma entra no prompt do resumo.
  await check('IA / Idioma', 'idioma escolhido aparece no prompt do resumo', async () => {
    capturado.prompts = [];
    instalarFetchStub(() => '# Resumo\nok');
    try {
      const r = await ai.generateSummary('Texto de teste sobre circuitos.', { idioma: 'English', nivel: 'curto' });
      assert(r.ok, 'generateSummary retornou erro com fetch simulado: ' + r.error);
      const p = capturado.prompts.join('\n');
      assert(/English/.test(p), 'O idioma "English" não foi injetado no prompt do resumo.', { sugestao: 'Verificar instrucaoIdioma() e sua inclusão em generateSummary.' });
    } finally { restaurarFetch(); }
  });

  // 4b. Foco "prova" entra no prompt do resumo.
  await check('IA / Foco', 'foco "prova" injeta direcionamento no prompt', async () => {
    capturado.prompts = [];
    instalarFetchStub(() => '# Resumo\nok');
    try {
      await ai.generateSummary('Texto.', { foco: 'prova', nivel: 'médio' });
      const p = capturado.prompts.join('\n').toLowerCase();
      assert(/prova/.test(p), 'O foco "prova" não gerou instrução de direcionamento no prompt.', { sugestao: 'Verificar instrucaoFoco()/FOCO_RESUMO em ai.js.' });
    } finally { restaurarFetch(); }
  });

  // 4c. Foco inválido não quebra (cai para geral).
  await check('IA / Foco', 'foco desconhecido não quebra a geração', async () => {
    instalarFetchStub(() => '# Resumo\nok');
    try {
      const r = await ai.generateSummary('Texto.', { foco: 'xpto-inexistente' });
      assert(r.ok, 'Foco desconhecido quebrou generateSummary.', { severidade: 'média', sugestao: 'instrucaoFoco deve retornar "" para foco desconhecido.' });
    } finally { restaurarFetch(); }
  });

  // 4d. Mapa mental: JSON válido é normalizado (children viram {titulo,descricao}).
  await check('IA / Mapa', 'mapa mental normaliza children string e objeto', async () => {
    instalarFetchStub(() => JSON.stringify({
      central: 'Tema',
      nodes: [
        { title: 'A', children: ['so-string', { titulo: 'B', descricao: 'desc' }] },
      ],
    }));
    try {
      const r = await ai.generateMindmap('Texto.', {});
      assert(r.ok, 'generateMindmap falhou com JSON válido: ' + r.error);
      const filhos = r.map.nodes[0].children;
      assert(filhos.every((c) => typeof c === 'object' && 'titulo' in c && 'descricao' in c),
        'children do mapa não foram normalizados para {titulo, descricao}.', { sugestao: 'Revisar normalização em generateMindmap.' });
    } finally { restaurarFetch(); }
  });

  // 4e. Mapa mental: JSON inválido retorna erro amigável (não lança).
  await check('IA / Mapa', 'JSON inválido do mapa retorna erro controlado', async () => {
    instalarFetchStub(() => 'isto não é json {');
    try {
      const r = await ai.generateMindmap('Texto.', {});
      assert(r && r.ok === false && r.error, 'Mapa com JSON inválido deveria retornar { ok:false, error }.', { sugestao: 'try/catch no parse do mapa (já existe) — manter.' });
    } finally { restaurarFetch(); }
  });

  // 4f. Exercícios: idioma entra e a quantidade pedida aparece no prompt.
  await check('IA / Exercícios', 'quantidade e idioma entram no prompt dos exercícios', async () => {
    capturado.prompts = [];
    instalarFetchStub(() => '# Lista\n1. ...');
    try {
      await ai.generateExercises('Texto.', { quantidade: 8, tipo: 'multipla', idioma: 'Español' });
      const p = capturado.prompts.join('\n');
      assert(/8/.test(p), 'A quantidade (8) não apareceu no prompt dos exercícios.', { severidade: 'média' });
      assert(/Español/.test(p), 'O idioma (Español) não entrou no prompt dos exercícios.', { sugestao: 'Verificar instrucaoIdioma em generateExercises.' });
    } finally { restaurarFetch(); }
  });
}

// ---------------------------------------------------------------------------
// 4bis. Matriz determinística do resumo: nível × foco (sem rede)
// ---------------------------------------------------------------------------
// Cruza os 3 níveis com os 4 focos (12 células) + 3 bordas, afirmando que:
//   - TODAS as âncoras do nível pedido entram no prompt;
//   - NENHUMA âncora de OUTROS níveis vaza;
//   - o foco injeta exatamente seu direcionamento (ou nada, no "geral").
// Totalmente offline: reusa instalarFetchStub/restaurarFetch/capturado.
async function testarMatrizResumo() {
  const ai = require(path.join(SRC, 'services', 'ai.js'));

  // Âncoras definidas num único ponto (manter o acento em 'médio').
  const ANCORA_NIVEL = {
    curto: ['resumo ENXUTO'],
    'médio': ['resumo EQUILIBRADO'],
    detalhado: ['resumo DETALHADO', '## Conceitos', '## Relações', '## Conclusão'],
  };
  const ANCORA_FOCO = {
    prova: ['ESTUDAR PARA UMA PROVA', '## Pontos de atenção para a prova'],
    revisao: ['REVISÃO RÁPIDA'],
    aprofundado: ['ENTENDER O ASSUNTO A FUNDO'],
  };
  const NIVEIS = ['curto', 'médio', 'detalhado'];
  const FOCOS = ['geral', 'prova', 'revisao', 'aprofundado'];
  const FIXTURE = 'A Lei de Ohm relaciona tensão, corrente e resistência: V = R x I.';

  const AREA = 'IA / Matriz Resumo';

  // 12 células: cada (nível, foco) injeta as instruções certas e nada vaza.
  for (const nivel of NIVEIS) {
    for (const foco of FOCOS) {
      await check(AREA, `nível=${nivel} foco=${foco} injeta instruções certas`, async () => {
        capturado.prompts = [];
        instalarFetchStub(() => '# Resumo\nok');
        try {
          const r = await ai.generateSummary(FIXTURE, { nivel, foco });
          assert(r.ok, `generateSummary falhou (nível=${nivel}, foco=${foco}): ` + r.error);
          const p = capturado.prompts.join('\n');

          // Nível: todas as âncoras do nível pedido presentes.
          for (const anc of ANCORA_NIVEL[nivel]) {
            assert(p.includes(anc), `Âncora de nível ausente para nível=${nivel}: "${anc}".`, { sugestao: 'Verificar NIVEL_RESUMO em ai.js.' });
          }
          // Nível: nenhuma âncora de OUTROS níveis vaza.
          for (const outro of NIVEIS) {
            if (outro === nivel) continue;
            for (const anc of ANCORA_NIVEL[outro]) {
              assert(!p.includes(anc), `Âncora do nível "${outro}" vazou no prompt de nível=${nivel}: "${anc}".`, { sugestao: 'Garantir que generateSummary use só a instrução do nível escolhido.' });
            }
          }
          // Foco: 'geral' não injeta nada; os demais injetam todas as suas âncoras.
          if (foco === 'geral') {
            for (const outroFoco of Object.keys(ANCORA_FOCO)) {
              for (const anc of ANCORA_FOCO[outroFoco]) {
                assert(!p.includes(anc), `Foco "geral" não deveria injetar a âncora de "${outroFoco}": "${anc}".`, { sugestao: 'instrucaoFoco("geral") deve retornar "".' });
              }
            }
          } else {
            for (const anc of ANCORA_FOCO[foco]) {
              assert(p.includes(anc), `Âncora de foco ausente para foco=${foco}: "${anc}".`, { sugestao: 'Verificar FOCO_RESUMO em ai.js.' });
            }
          }
        } finally { restaurarFetch(); }
      });
    }
  }

  // Borda (a): foco desconhecido não quebra e não injeta nenhuma âncora de foco.
  await check(AREA, 'foco desconhecido não injeta âncora de foco', async () => {
    capturado.prompts = [];
    instalarFetchStub(() => '# Resumo\nok');
    try {
      const r = await ai.generateSummary(FIXTURE, { nivel: 'médio', foco: 'xpto-inexistente' });
      assert(r.ok, 'Foco desconhecido quebrou generateSummary.', { severidade: 'média', sugestao: 'instrucaoFoco deve retornar "" para foco desconhecido.' });
      const p = capturado.prompts.join('\n');
      for (const foco of Object.keys(ANCORA_FOCO)) {
        for (const anc of ANCORA_FOCO[foco]) {
          assert(!p.includes(anc), `Foco desconhecido injetou âncora de "${foco}": "${anc}".`, { sugestao: 'instrucaoFoco deve retornar "" para foco desconhecido.' });
        }
      }
    } finally { restaurarFetch(); }
  });

  // Borda (b): nível ausente cai no default ('médio' => 'resumo EQUILIBRADO').
  await check(AREA, 'nível ausente usa default (resumo EQUILIBRADO)', async () => {
    capturado.prompts = [];
    instalarFetchStub(() => '# Resumo\nok');
    try {
      const r = await ai.generateSummary(FIXTURE, { foco: 'geral' });
      assert(r.ok, 'generateSummary sem nível quebrou.', { sugestao: 'NIVEL_RESUMO deve cair para médio quando o nível é ausente.' });
      const p = capturado.prompts.join('\n');
      assert(p.includes('resumo EQUILIBRADO'), 'Nível ausente não caiu para o default "médio" (resumo EQUILIBRADO).', { sugestao: 'Conferir o fallback NIVEL_RESUMO[nivelKey] || NIVEL_RESUMO["médio"].' });
    } finally { restaurarFetch(); }
  });

  // Borda (c): detalhado + aprofundado injeta AMBAS as instruções.
  await check(AREA, 'detalhado + aprofundado injeta ambas as instruções', async () => {
    capturado.prompts = [];
    instalarFetchStub(() => '# Resumo\nok');
    try {
      const r = await ai.generateSummary(FIXTURE, { nivel: 'detalhado', foco: 'aprofundado' });
      assert(r.ok, 'generateSummary (detalhado+aprofundado) quebrou.');
      const p = capturado.prompts.join('\n');
      assert(p.includes('resumo DETALHADO'), 'Instrução de nível "detalhado" ("resumo DETALHADO") ausente.', { sugestao: 'Verificar NIVEL_RESUMO.detalhado.' });
      assert(p.includes('ENTENDER O ASSUNTO A FUNDO'), 'Instrução de foco "aprofundado" ("ENTENDER O ASSUNTO A FUNDO") ausente.', { sugestao: 'Verificar FOCO_RESUMO.aprofundado.' });
    } finally { restaurarFetch(); }
  });
}

// ---------------------------------------------------------------------------
// 5. Testes do updater (sem fazer git pull)
// ---------------------------------------------------------------------------
async function testarUpdater() {
  const updater = require(path.join(SRC, 'services', 'updater.js'));

  await check('Updater', 'isGitRepo detecta repositório', async () => {
    const temGit = fs.existsSync(path.join(RAIZ, '.git'));
    assert(updater.isGitRepo() === temGit, 'isGitRepo() divergiu da existência real de .git.', { severidade: 'média' });
  });

  await check('Updater', 'REPO_URL aponta para o GitHub do projeto', async () => {
    assert(/github\.com\/.+\/.+/.test(updater.REPO_URL), 'REPO_URL não parece uma URL de repositório GitHub.', { severidade: 'baixa' });
  });

  // checkForUpdates com stub de https (a API do GitHub é consultada via 'https', não fetch).
  await check('Updater', 'checkForUpdates retorna formato esperado (com GitHub simulado)', async () => {
    const sha = 'a'.repeat(40);
    instalarHttpsStub({ statusCode: 200, body: { sha } });
    try {
      const r = await updater.checkForUpdates();
      assert(r && r.ok === true, 'checkForUpdates não retornou ok:true com API simulada: ' + JSON.stringify(r));
      assert(typeof r.updateAvailable === 'boolean', 'updateAvailable deveria ser boolean.', { severidade: 'média' });
      assert('canApply' in r, 'Faltou a flag canApply no retorno de checkForUpdates.', { severidade: 'baixa' });
    } finally { restaurarHttps(); }
  });
}

// ---------------------------------------------------------------------------
// 6. Integração UI ↔ serviços: os controles do HTML existem e batem com o JS
// ---------------------------------------------------------------------------
async function testarIntegracaoUI() {
  const htmlPath = path.join(SRC, 'renderer', 'index.html');
  const rendererPath = path.join(SRC, 'renderer', 'renderer.js');
  const preloadPath = path.join(SRC, 'preload.js');
  const html = fs.readFileSync(htmlPath, 'utf-8');
  const rjs = fs.readFileSync(rendererPath, 'utf-8');
  const preload = fs.readFileSync(preloadPath, 'utf-8');

  // IDs que o renderer referencia e precisam existir no HTML.
  const idsUsados = ['#summaryFoco', '#langSelect', '#summaryLevel', '#updateBanner', '#updateApplyBtn', '#updateDismissBtn', '#updateRepoBtn'];
  for (const id of idsUsados) {
    await check('Integração UI', `elemento ${id} existe no HTML`, async () => {
      const idSemHash = id.slice(1);
      assert(new RegExp(`id="${idSemHash}"`).test(html), `renderer.js usa ${id} mas não há id="${idSemHash}" no index.html.`, { sugestao: 'Adicionar o elemento no index.html ou corrigir o seletor no renderer.js.' });
    });
  }

  // Toda chamada window.api.X do renderer precisa estar exposta no preload.
  await check('Integração UI', 'todas as window.api.* usadas existem no preload', async () => {
    const usadas = new Set([...rjs.matchAll(/window\.api\.(\w+)/g)].map((m) => m[1]));
    const expostas = new Set([...preload.matchAll(/(\w+)\s*:/g)].map((m) => m[1]));
    const faltando = [...usadas].filter((n) => !expostas.has(n));
    assert(faltando.length === 0, 'Métodos usados no renderer mas ausentes no preload: ' + faltando.join(', '), { sugestao: 'Expor os métodos faltantes em preload.js (contextBridge).' });
  });

  // Todo canal ipcRenderer.invoke do preload deve ter handler no main.
  await check('Integração UI', 'todos os canais do preload têm handler no main', async () => {
    const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf-8');
    const canaisPreload = new Set([...preload.matchAll(/invoke\(['"]([^'"]+)['"]/g)].map((m) => m[1]));
    const handlers = new Set([...main.matchAll(/ipcMain\.handle\(['"]([^'"]+)['"]/g)].map((m) => m[1]));
    const semHandler = [...canaisPreload].filter((c) => !handlers.has(c));
    assert(semHandler.length === 0, 'Canais invocados no preload sem ipcMain.handle no main: ' + semHandler.join(', '), { sugestao: 'Registrar ipcMain.handle para cada canal em main.js.' });
  });

  // As opções dos selects de idioma/foco devem bater com o que o ai.js entende.
  await check('Integração UI', 'opções de foco do HTML existem no ai.js (FOCO_RESUMO)', async () => {
    const aiSrc = fs.readFileSync(path.join(SRC, 'services', 'ai.js'), 'utf-8');
    // valores do <select id="summaryFoco">
    const bloco = (html.match(/id="summaryFoco"[\s\S]*?<\/select>/) || [''])[0];
    const valores = [...bloco.matchAll(/value="([^"]+)"/g)].map((m) => m[1]);
    assert(valores.length > 0, 'Não achei opções no select #summaryFoco.', { severidade: 'média' });
    const faltando = valores.filter((v) => !new RegExp(`\\b${v}\\b`).test(aiSrc));
    assert(faltando.length === 0, 'Focos no HTML sem tratamento no ai.js: ' + faltando.join(', ') + '. (cairiam no foco "geral" silenciosamente)', { severidade: 'média', sugestao: 'Adicionar as chaves em FOCO_RESUMO ou remover do HTML.' });
  });
}

// ---------------------------------------------------------------------------
// Relatório + comunicação
// ---------------------------------------------------------------------------
function gerarSaida() {
  const ordem = { alta: 0, 'média': 1, baixa: 2 };
  bugs.sort((a, b) => (ordem[a.severidade] ?? 9) - (ordem[b.severidade] ?? 9));

  const alta = bugs.filter((b) => b.severidade === 'alta').length;
  const media = bugs.filter((b) => b.severidade === 'média').length;
  const baixa = bugs.filter((b) => b.severidade === 'baixa').length;

  // JSON legível por máquina (comunicação com o dev/agente que corrige).
  const payload = {
    gerado_em: new Date().toISOString(),
    resumo: { checks: totalChecks, passaram: passes.length, bugs: bugs.length, alta, media, baixa },
    bugs,
    passes,
  };
  fs.writeFileSync(BUGS_JSON, JSON.stringify(payload, null, 2), 'utf-8');

  // Relatório humano.
  const emoji = { alta: '🔴', 'média': '🟡', baixa: '🔵' };
  let md = `# Relatório de Beta Testing — Estudo AI\n\n`;
  md += `Gerado em: ${new Date().toLocaleString('pt-BR')}\n\n`;
  md += `**Checks:** ${totalChecks} · **Passaram:** ${passes.length} · **Bugs:** ${bugs.length} `;
  md += `(🔴 ${alta} alta · 🟡 ${media} média · 🔵 ${baixa} baixa)\n\n`;

  if (!bugs.length) {
    md += '✅ Nenhum bug funcional encontrado nos checks automatizados.\n\n';
  } else {
    md += `## Bugs encontrados\n\n`;
    md += `| Sev | Área | Problema | Sugestão de correção |\n|-----|------|----------|----------------------|\n`;
    for (const b of bugs) {
      const det = (b.titulo + ' — ' + b.detalhe).replace(/\n/g, ' ').replace(/\|/g, '\\|');
      md += `| ${emoji[b.severidade] || ''} | ${b.area} | ${det} | ${(b.sugestao || '').replace(/\|/g, '\\|')} |\n`;
    }
    md += '\n';
  }

  md += `## Checks que passaram (${passes.length})\n\n`;
  for (const p of passes) md += `- ✅ ${p}\n`;
  md += `\n> O arquivo \`tests/beta-bugs.json\` traz os mesmos dados em formato legível por máquina, para o desenvolvedor/agente corrigir os bugs.\n`;

  fs.writeFileSync(RELATORIO, md, 'utf-8');

  return { alta, media, baixa };
}

// ---------------------------------------------------------------------------
async function main() {
  console.log('🧪 Agente de Beta Testing — exercitando o app...\n');

  await testarLibrary();
  await testarExporter();
  await testarStore();
  await testarAi();
  await testarMatrizResumo();
  await testarUpdater();
  await testarIntegracaoUI();

  const { alta, media, baixa } = gerarSaida();

  console.log(`\nConcluído: ${totalChecks} checks, ${passes.length} ok, ${bugs.length} bug(s).`);
  console.log(`  🔴 ${alta} alta · 🟡 ${media} média · 🔵 ${baixa} baixa`);
  console.log(`Relatório: ${RELATORIO}`);
  console.log(`Bugs (JSON): ${BUGS_JSON}`);

  // Falha o processo se houver bug de severidade alta (útil para hook/CI).
  if (alta > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('Falha no agente de beta testing:', e);
  process.exitCode = 2;
});
