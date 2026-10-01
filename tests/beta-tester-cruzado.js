#!/usr/bin/env node
'use strict';

/**
 * SEGUNDO AGENTE DE BETA TESTING — CRUZA SAÍDAS com tests/beta-tester.js.
 *
 * A ideia é rodar o MESMO TIPO de verificação do beta-tester original e
 * comparar as saídas das duas execuções, procurando por:
 *   - CONCORDÂNCIA  : o mesmo check tem o mesmo status nas duas execuções.
 *   - DIVERGÊNCIA   : o mesmo check muda de status entre execuções
 *                     (sinal de NÃO-DETERMINISMO — o pior tipo de bug).
 *   - REGRESSÃO/SUMIÇO: um check aparece numa execução e some na outra.
 *
 * COMO ELE REUSA O BETA-TESTER ORIGINAL (contrato estável):
 *   tests/beta-tester.js NÃO tem module.exports e roda main() no fim. Por isso
 *   o reuso é por SUBPROCESSO (child_process.spawnSync): rodamos o script e
 *   lemos o artefato tests/beta-bugs.json + o exit code. O beta-tester original
 *   NÃO é modificado.
 *
 * PASTA REAL — INVARIANTE INEGOCIÁVEL:
 *   A Parte B exercita o app numa pasta de estudos REAL, porém SOMENTE LEITURA:
 *   só library.scan() + library.readFileText(). NADA é escrito/movido/renomeado/
 *   apagado na pasta real. Todo índice/resultado/estado vai para os.tmpdir().
 *   Caminho configurável por env PASTA_REAL (default na Facul do usuário).
 *   Há PROGRESSO e LIMITE SENSATO (env MAX_ARQUIVOS, default 40) + timeout.
 *
 * DEGRADAÇÃO:
 *   - Sem a pasta real: a Parte B é pulada com mensagem clara (não falha).
 *   - Sem Ollama/modelo: a indexação RAG é pulada com mensagem clara
 *     (prefixo literal 'Ollama não está rodando'); a leitura segue normalmente.
 *
 * SAÍDA:
 *   Relatório no console + markdown em os.tmpdir()/beta-cruzado-relatorio.md.
 *   process.exitCode = 0 quando NÃO há divergência; != 0 se houver.
 *
 * Uso:  node tests/beta-tester-cruzado.js   (ou  npm run test:beta2)
 */

// ---- Mock de electron ANTES de qualquer require de módulo do app ----------
// Faz store/rag/ai resolverem dados em os.tmpdir() (nunca em userData real).
const Module = require('module');
const orig = Module._load;
Module._load = function (req) {
  if (req === 'electron') return { app: { isPackaged: false, getPath: () => require('os').tmpdir() } };
  return orig.apply(this, arguments);
};

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const BETA = path.join(__dirname, 'beta-tester.js');
const BUGS_JSON = path.join(__dirname, 'beta-bugs.json');
const RELATORIO = path.join(os.tmpdir(), 'beta-cruzado-relatorio.md');

// ===========================================================================
// Parte A — cruzamento lógico (sem Ollama; usa os stubs do próprio beta-tester)
// ===========================================================================

// Roda o beta-tester original como subprocesso e devolve { exitCode, payload }.
// O payload é o conteúdo de tests/beta-bugs.json gerado pela execução.
function rodarBeta(rotulo) {
  console.log(`\n▶ Execução ${rotulo} do beta-tester (subprocesso, sem Ollama)...`);
  const r = spawnSync('node', [BETA], { cwd: RAIZ, encoding: 'utf-8' });
  if (r.error) {
    console.log(`  ⚠ Não consegui rodar o beta-tester: ${r.error.message}`);
    return { exitCode: null, payload: null, erroSpawn: r.error.message };
  }
  let payload = null;
  try {
    payload = JSON.parse(fs.readFileSync(BUGS_JSON, 'utf-8'));
  } catch (e) {
    console.log(`  ⚠ Não consegui ler ${BUGS_JSON}: ${e.message}`);
  }
  const resumo = payload && payload.resumo ? payload.resumo : {};
  console.log(`  exit=${r.status} · checks=${resumo.checks ?? '?'} · ok=${resumo.passaram ?? '?'} · bugs=${resumo.bugs ?? '?'}`);
  return { exitCode: r.status, payload };
}

// Monta um MAPA chave->status a partir de um payload do beta-tester.
// Chave estável:
//   - passes: a própria string "Area · titulo" (status 'ok').
//   - bugs:   "Area · titulo" (status = severidade do bug: alta/média/baixa).
function mapaDeChecks(payload) {
  const mapa = new Map();
  if (!payload) return mapa;
  for (const p of payload.passes || []) {
    mapa.set(p, 'ok');
  }
  for (const b of payload.bugs || []) {
    const chave = `${b.area} · ${b.titulo}`;
    mapa.set(chave, b.severidade || 'bug');
  }
  return mapa;
}

// Cruza os dois mapas e classifica cada check.
function cruzar(mapaA, mapaB) {
  const todas = new Set([...mapaA.keys(), ...mapaB.keys()]);
  const concordancias = [];
  const divergencias = [];
  const sumicos = [];
  for (const chave of todas) {
    const a = mapaA.get(chave);
    const b = mapaB.get(chave);
    if (a !== undefined && b !== undefined) {
      if (a === b) concordancias.push({ chave, status: a });
      else divergencias.push({ chave, statusA: a, statusB: b });
    } else {
      sumicos.push({ chave, statusA: a ?? '(ausente)', statusB: b ?? '(ausente)' });
    }
  }
  return { concordancias, divergencias, sumicos };
}

// ===========================================================================
// Parte B — pasta real, SOMENTE LEITURA, com limite e progresso
// ===========================================================================
async function parteB() {
  const resultado = {
    executou: false,
    pulou: false,
    motivo: '',
    pastaReal: '',
    arquivosLidos: 0,
    bytesLidos: 0,
    caracteresLidos: 0,
    falhasLeitura: 0,
    iaStatus: 'não tentada',
    degradacoes: [],
  };

  const pastaReal = process.env.PASTA_REAL || 'C:\\Users\\enzom\\OneDrive\\Desktop\\Facul';
  resultado.pastaReal = pastaReal;

  if (!fs.existsSync(pastaReal)) {
    const msg = `Pasta real não encontrada em "${pastaReal}". Pulando a Parte B (defina PASTA_REAL para apontar para a sua pasta de estudos).`;
    console.log(`\n⏭  ${msg}`);
    resultado.pulou = true;
    resultado.motivo = msg;
    resultado.degradacoes.push(msg);
    return resultado;
  }

  const library = require(path.join(RAIZ, 'src', 'services', 'library.js'));

  console.log(`\n▶ Parte B — leitura SOMENTE LEITURA da pasta real:\n    ${pastaReal}`);
  console.log('    (nada é escrito/movido/apagado nela; índices vão para os.tmpdir())');

  // Varredura (só metadados).
  const lib = library.scan(pastaReal);
  const arquivos = (lib.notebooks || []).flatMap((n) => n.files);
  const MAX = Number(process.env.MAX_ARQUIVOS) || 40;
  const TIMEOUT_MS = (Number(process.env.PARTE_B_TIMEOUT_S) || 120) * 1000;
  const alvo = arquivos.slice(0, MAX);
  const N = alvo.length;
  console.log(`    Encontrados ${arquivos.length} arquivo(s) suportado(s); lendo até ${MAX} (limite sensato).`);

  const inicio = Date.now();
  const lidosComTexto = []; // { path, name, text, mtime, size } para a IA opcional
  for (let i = 0; i < N; i++) {
    if (Date.now() - inicio > TIMEOUT_MS) {
      const msg = `Timeout de ${TIMEOUT_MS / 1000}s atingido na Parte B; interrompendo a leitura em ${i}/${N}.`;
      console.log(`    ⏱  ${msg}`);
      resultado.degradacoes.push(msg);
      break;
    }
    const f = alvo[i];
    console.log(`    [${i + 1}/${N}] ${f.name}`);
    const r = await library.readFileText(f.path); // SOMENTE LEITURA
    if (r && r.ok && typeof r.text === 'string') {
      resultado.arquivosLidos += 1;
      resultado.bytesLidos += f.size || 0;
      resultado.caracteresLidos += r.text.length;
      lidosComTexto.push({ path: f.path, name: f.name, text: r.text, mtime: f.mtime, size: f.size });
    } else {
      resultado.falhasLeitura += 1;
    }
  }
  resultado.executou = true;
  console.log(`    Lidos ${resultado.arquivosLidos} arquivo(s), ${resultado.caracteresLidos} caractere(s); ${resultado.falhasLeitura} falha(s) de leitura.`);

  // Parte B — IA opcional (indexação RAG), degradando sem Ollama.
  await parteBiA(resultado, lidosComTexto);

  return resultado;
}

// Tenta indexar o que foi lido via RAG, SEMPRE em os.tmpdir(). Degrada sem Ollama.
async function parteBiA(resultado, lidosComTexto) {
  const ai = require(path.join(RAIZ, 'src', 'services', 'ai.js'));
  const rag = require(path.join(RAIZ, 'src', 'services', 'rag.js'));

  let status;
  try {
    status = await ai.checkStatus();
  } catch (e) {
    status = { ok: false, reason: 'erro: ' + (e && e.message) };
  }

  if (!status || !status.ok) {
    const msg = 'Ollama não está rodando (ou sem modelos). Pulando a indexação RAG da Parte B; a leitura da pasta real já foi exercitada.';
    console.log(`    ℹ ${msg}`);
    resultado.iaStatus = 'offline';
    resultado.degradacoes.push(msg);
    return;
  }

  if (!lidosComTexto.length) {
    resultado.iaStatus = 'online (nada para indexar)';
    return;
  }

  // Índice SEMPRE dentro de os.tmpdir() — NUNCA a pasta real.
  const rootIndice = path.join(os.tmpdir(), 'beta-cruzado-indice-' + Date.now());
  const filesMeta = lidosComTexto.map((f) => ({ path: f.path, name: f.name, mtime: f.mtime, size: f.size }));
  const scannedPaths = filesMeta.map((m) => ({ path: m.path, mtime: m.mtime, size: m.size }));
  const porPath = new Map(lidosComTexto.map((f) => [f.path, f.text]));

  // Timeout global via AbortController.
  const controller = new AbortController();
  const TIMEOUT_MS = (Number(process.env.PARTE_B_TIMEOUT_S) || 120) * 1000;
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const r = await rag.indexFilesStreaming({
      rootFolder: rootIndice, // dentro de os.tmpdir()
      filesMeta,
      scannedPaths,
      // readText reusa o texto já lido (não relê a pasta real).
      readText: async (p) => ({ ok: true, text: porPath.get(p) || '', name: path.basename(p) }),
      embed: ai.embed,
      embedModel: ai.DEFAULT_EMBED_MODEL,
      signal: controller.signal,
      onProgress: (p) => console.log(`    [RAG ${p.current}/${p.total}] ${p.name}`),
    });
    if (r && r.ok) {
      resultado.iaStatus = `online (indexados ${r.reindexados ?? '?'}; índice em os.tmpdir())`;
      console.log(`    ✅ Indexação RAG concluída em os.tmpdir(): ${rootIndice}`);
    } else {
      const msg = 'Indexação RAG não concluiu: ' + ((r && r.error) || 'motivo desconhecido');
      console.log(`    ⚠ ${msg}`);
      resultado.iaStatus = 'erro';
      resultado.degradacoes.push(msg);
    }
  } catch (e) {
    const msg = 'Exceção na indexação RAG (degradada): ' + (e && e.message);
    console.log(`    ⚠ ${msg}`);
    resultado.iaStatus = 'erro';
    resultado.degradacoes.push(msg);
  } finally {
    clearTimeout(timer);
    // Limpeza do índice temporário criado em os.tmpdir() (não suja o tmp).
    try { fs.rmSync(rootIndice, { recursive: true, force: true }); } catch {}
  }
}

// ===========================================================================
// Relatório
// ===========================================================================
function gerarRelatorio({ execA, execB, cruzamento, parteBres }) {
  const { concordancias, divergencias, sumicos } = cruzamento;

  let md = `# Relatório de Beta Testing Cruzado — CábulIA / Estudo AI\n\n`;
  md += `Gerado em: ${new Date().toLocaleString('pt-BR')}\n\n`;
  md += `Este relatório cruza DUAS execuções do \`tests/beta-tester.js\` (reuso por subprocesso)\n`;
  md += `e exercita o app numa pasta real **somente leitura** (Parte B).\n\n`;

  md += `## Parte A — cruzamento das execuções\n\n`;
  md += `- Execução 1: exit=${execA.exitCode} · ${execA.payload ? execA.payload.resumo.checks : '?'} checks\n`;
  md += `- Execução 2: exit=${execB.exitCode} · ${execB.payload ? execB.payload.resumo.checks : '?'} checks\n`;
  md += `- Concordâncias: ${concordancias.length}\n`;
  md += `- Divergências (não-determinismo): ${divergencias.length}\n`;
  md += `- Checks que sumiram entre execuções (regressão): ${sumicos.length}\n\n`;

  if (divergencias.length) {
    md += `### ⚠ Divergências (mesmo check, status diferente)\n\n`;
    md += `| Check | Exec 1 | Exec 2 |\n|-------|--------|--------|\n`;
    for (const d of divergencias) {
      md += `| ${d.chave.replace(/\|/g, '\\|')} | ${d.statusA} | ${d.statusB} |\n`;
    }
    md += `\n`;
  }
  if (sumicos.length) {
    md += `### ⚠ Checks presentes em só uma execução\n\n`;
    md += `| Check | Exec 1 | Exec 2 |\n|-------|--------|--------|\n`;
    for (const s of sumicos) {
      md += `| ${s.chave.replace(/\|/g, '\\|')} | ${s.statusA} | ${s.statusB} |\n`;
    }
    md += `\n`;
  }
  if (!divergencias.length && !sumicos.length) {
    md += `✅ As duas execuções concordaram em todos os ${concordancias.length} checks (determinístico).\n\n`;
  }

  md += `## Parte B — pasta real (somente leitura)\n\n`;
  md += `- Pasta: \`${parteBres.pastaReal}\`\n`;
  if (parteBres.pulou) {
    md += `- Status: pulada — ${parteBres.motivo}\n`;
  } else {
    md += `- Arquivos lidos: ${parteBres.arquivosLidos}\n`;
    md += `- Bytes (metadados): ${parteBres.bytesLidos}\n`;
    md += `- Caracteres extraídos: ${parteBres.caracteresLidos}\n`;
    md += `- Falhas de leitura: ${parteBres.falhasLeitura}\n`;
    md += `- IA / indexação RAG: ${parteBres.iaStatus}\n`;
  }
  if (parteBres.degradacoes.length) {
    md += `\n### Degradações registradas\n\n`;
    for (const d of parteBres.degradacoes) md += `- ${d}\n`;
  }
  md += `\n> Nenhum dado foi escrito na pasta real. Índices/resultados vivem em os.tmpdir().\n`;

  try {
    fs.writeFileSync(RELATORIO, md, 'utf-8');
  } catch (e) {
    console.log(`⚠ Não consegui gravar o relatório em ${RELATORIO}: ${e.message}`);
  }
  return md;
}

// ===========================================================================
async function main() {
  console.log('🧪🧪 Beta Testing Cruzado — comparando saídas e exercitando a pasta real...');

  // Parte A — duas execuções do beta-tester original.
  const execA = rodarBeta('1');
  const execB = rodarBeta('2');

  const cruzamento = cruzar(mapaDeChecks(execA.payload), mapaDeChecks(execB.payload));

  console.log('\n== Cruzamento (Parte A) ==');
  console.log(`  Concordâncias: ${cruzamento.concordancias.length}`);
  console.log(`  Divergências (não-determinismo): ${cruzamento.divergencias.length}`);
  console.log(`  Checks que sumiram entre execuções: ${cruzamento.sumicos.length}`);
  for (const d of cruzamento.divergencias) {
    console.log(`    ❌ DIVERGÊNCIA: ${d.chave} (exec1=${d.statusA} vs exec2=${d.statusB})`);
  }
  for (const s of cruzamento.sumicos) {
    console.log(`    ⚠ SUMIÇO: ${s.chave} (exec1=${s.statusA} vs exec2=${s.statusB})`);
  }

  // Parte B — pasta real, só leitura.
  const parteBres = await parteB();

  // Relatório.
  gerarRelatorio({ execA, execB, cruzamento, parteBres });
  console.log(`\nRelatório de cruzamento: ${RELATORIO}`);

  const temDivergencia = cruzamento.divergencias.length > 0 || cruzamento.sumicos.length > 0;
  if (temDivergencia) {
    console.log('\n❌ Houve DIVERGÊNCIA/não-determinismo entre execuções (exit != 0).');
    process.exitCode = 1;
  } else {
    console.log('\n✅ Sem divergência entre execuções do beta-tester (exit 0).');
  }
}

main().catch((e) => {
  console.error('Falha no beta-tester cruzado:', e && e.stack ? e.stack : e);
  process.exitCode = 2;
});
