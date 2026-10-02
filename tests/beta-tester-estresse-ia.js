#!/usr/bin/env node
'use strict';

/**
 * BETA TESTER DE ESTRESSE — OPÇÃO 2 (IA REAL).
 *
 * Dispara geração / RAG / classificação / plano DE VERDADE contra os modelos
 * instalados no Ollama, usando entradas "burras"/adversariais, medindo o tempo
 * de cada caso e detectando travamento (timeout sem respeitar o cancelamento) e
 * alucinação (resposta inventa fato/fonte fora do material).
 *
 * DEGRADAÇÃO SEM OLLAMA (RF10/CA2):
 *   Se o Ollama estiver ausente ou sem modelos, o teste PULA: imprime o prefixo
 *   literal 'Ollama não está rodando (ou sem modelos). Pulando os testes de IA.',
 *   grava um relatório "pulado" em os.tmpdir() e sai com process.exitCode = 0.
 *   NUNCA falha por ausência de Ollama.
 *
 * INVARIANTES:
 *   - INV1: nada é escrito/movido/apagado fora de os.tmpdir(). As fixtures vivem
 *     num diretório temporário dedicado (fs.mkdtempSync) tratado como SOMENTE
 *     LEITURA; um snapshot é reconferido ao final (sentinela de FS). A PASTA_REAL
 *     opcional é lida apenas (library.readFileText), nunca escrita.
 *   - INV6: todo índice temporário criado em os.tmpdir() é removido em finally.
 *   - INV7: nenhum teste existente é modificado.
 *
 * Segue o padrão medir()/AbortController de tests/testar-modelos.js e o mock de
 * electron de tests/beta-tester-cruzado.js.
 *
 * Uso:  node tests/beta-tester-estresse-ia.js   (ou  npm run test:stress-ia)
 */

// ---- Mock de electron ANTES de qualquer require de módulo do app ----------
// Faz store/rag/classification persistirem em os.tmpdir() (nunca em userData real).
const Module = require('module');
const orig = Module._load;
Module._load = function (req) {
  if (req === 'electron') return { app: { isPackaged: false, getPath: () => require('os').tmpdir() } };
  return orig.apply(this, arguments);
};

const fs = require('fs');
const path = require('path');
const os = require('os');

const RAIZ = path.join(__dirname, '..');
const ai = require(path.join(RAIZ, 'src', 'services', 'ai.js'));
const rag = require(path.join(RAIZ, 'src', 'services', 'rag.js'));
const library = require(path.join(RAIZ, 'src', 'services', 'library.js'));

const RELATORIO = path.join(os.tmpdir(), 'estresse-ia-relatorio.md');

// Prefixo literal exigido por RF10/CA2 (não alterar o texto).
const PREFIXO_PULADO = 'Ollama não está rodando (ou sem modelos). Pulando os testes de IA.';

// Teto de tempo por caso. Cancelamento REAL via AbortController; se o serviço
// não respeitar o signal e não retornar dentro do teto, o caso é 'crítica'.
const TIMEOUT_CASO_MS = (Number(process.env.STRESS_IA_TIMEOUT_S) || 150) * 1000;

// ---------------------------------------------------------------------------
// Coletor de resultados (padrão do beta-tester.js, severidade estendida).
// ---------------------------------------------------------------------------
const ORDEM_SEVERIDADE = { crítica: 0, alta: 1, 'média': 2, baixa: 3 };
const bugs = [];     // { severidade, area, titulo, detalhe, sugestao }
const passes = [];   // nomes dos checks que passaram
const casos = [];    // { area, nome, ms, status, iteracoes, detalhe }

function bug(severidade, area, titulo, detalhe, sugestao) {
  bugs.push({ severidade, area, titulo, detalhe, sugestao: sugestao || '' });
}

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
// medir() — AbortController + setTimeout(abort) + Promise.race (padrão
// testar-modelos.js). Devolve { res, ms, travou }. No timeout, aborta de
// verdade; se mesmo assim a fn não resolver, o Promise.race entrega __timeout.
// ---------------------------------------------------------------------------
async function medir(fnComSinal) {
  const inicio = Date.now();
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ __timeout: true });
    }, TIMEOUT_CASO_MS);
  });
  try {
    const vencedor = await Promise.race([fnComSinal(controller.signal), timeout]);
    clearTimeout(timer);
    if (vencedor && vencedor.__timeout) {
      return {
        res: { ok: false, error: `TRAVOU: sem resposta em ${TIMEOUT_CASO_MS / 1000}s (não respeitou o cancelamento)` },
        ms: Date.now() - inicio,
        travou: true,
      };
    }
    return { res: vencedor, ms: Date.now() - inicio, travou: false };
  } catch (e) {
    clearTimeout(timer);
    return { res: { ok: false, error: 'EXCEÇÃO: ' + (e && e.message) }, ms: Date.now() - inicio, travou: false };
  }
}

// Executa um caso de IA nomeado: mede o tempo, trata travamento como 'crítica'
// e deixa a análise de qualidade/alucinação para a fn (via assert). Exceções
// inesperadas viram bug 'alta'; __assert respeita a severidade informada.
async function casoIA(area, nome, fnComSinal, analisar, iteracoes) {
  const log = (...a) => console.log(...a);
  const r = await medir(fnComSinal);
  const seg = Math.round(r.ms / 1000);
  let status = 'OK';
  try {
    if (r.travou) {
      status = 'FALHA';
      bug('crítica', area, nome, r.res.error, 'O serviço deve respeitar o AbortSignal e retornar cancelado/erro controlado dentro do timeout.');
    } else {
      analisar(r.res, r.ms);
      passes.push(`${area} · ${nome}`);
    }
  } catch (e) {
    status = 'FALHA';
    if (e && e.__assert) {
      bug(e.severidade || 'alta', area, nome, e.message, e.sugestao);
    } else {
      bug('alta', area, nome, 'Exceção inesperada: ' + (e && e.stack ? e.stack.split('\n')[0] : e), 'Investigar a exceção no serviço envolvido.');
    }
  }
  const emoji = status === 'OK' ? '✅' : '❌';
  casos.push({ area, nome, ms: r.ms, status, iteracoes: iteracoes || null });
  log(`  ${emoji} ${nome} (${seg}s${iteracoes ? `, ${iteracoes} iteração(ões)/lote(s)` : ''})`);
  return r.res;
}

// ---------------------------------------------------------------------------
// Fixtures determinísticas em os.tmpdir() (SOMENTE LEITURA), com sentinela INV1.
// ---------------------------------------------------------------------------
// Gera texto determinístico (sem aleatoriedade) para reprodutibilidade.
function textoRepetido(frase, vezes) {
  const partes = [];
  for (let i = 0; i < vezes; i++) partes.push(`${frase} (parágrafo ${i + 1}).`);
  return partes.join('\n');
}

function semearFixtures(dir) {
  // Material A — Biologia celular (assunto 1).
  const biologia = textoRepetido(
    'A célula é a unidade básica da vida. A mitocôndria produz energia (ATP). O núcleo guarda o DNA',
    40
  );
  // Material B — História do Brasil (assunto 2, para "material misturado").
  const historia = textoRepetido(
    'A Proclamação da República no Brasil ocorreu em 1889, liderada por Deodoro da Fonseca. O período imperial terminou',
    40
  );
  // Texto curto para o mapa mental.
  const curto = 'Fotossíntese é o processo pelo qual plantas convertem luz solar, água e gás carbônico em glicose e oxigênio.';
  // Texto sem sentido (ruído determinístico).
  const semSentido = textoRepetido('xkqz plrt vmbn zzqq wklp jjtt', 20);

  fs.writeFileSync(path.join(dir, 'biologia.txt'), biologia, 'utf-8');
  fs.writeFileSync(path.join(dir, 'historia.txt'), historia, 'utf-8');
  fs.writeFileSync(path.join(dir, 'curto.txt'), curto, 'utf-8');
  fs.writeFileSync(path.join(dir, 'sem-sentido.txt'), semSentido, 'utf-8');
}

// Snapshot (nome + size + mtime) de um diretório plano, para a sentinela INV1.
function snapshotDir(dir) {
  const snap = {};
  for (const nome of fs.readdirSync(dir)) {
    const p = path.join(dir, nome);
    const st = fs.statSync(p);
    snap[nome] = { size: st.size, mtime: st.mtimeMs };
  }
  return snap;
}

// Compara dois snapshots; devolve lista de diferenças (vazia = intacto).
function diffSnapshot(antes, depois) {
  const difs = [];
  const nomes = new Set([...Object.keys(antes), ...Object.keys(depois)]);
  for (const nome of nomes) {
    const a = antes[nome];
    const d = depois[nome];
    if (!a) { difs.push(`arquivo novo: ${nome}`); continue; }
    if (!d) { difs.push(`arquivo removido: ${nome}`); continue; }
    if (a.size !== d.size) difs.push(`tamanho mudou: ${nome} (${a.size} -> ${d.size})`);
    if (a.mtime !== d.mtime) difs.push(`mtime mudou: ${nome}`);
  }
  return difs;
}

// ---------------------------------------------------------------------------
// Heurísticas de análise de qualidade.
// ---------------------------------------------------------------------------
const STOPWORDS_PT = ['de', 'da', 'do', 'que', 'não', 'uma', 'para', 'com', 'por', 'os', 'as', 'em', 'é'];
const STOPWORDS_EN = ['the', 'of', 'and', 'to', 'in', 'is', 'that', 'for', 'with', 'are', 'this', 'it'];

function contarStopwords(texto, lista) {
  const palavras = String(texto || '').toLowerCase().split(/\W+/);
  const set = new Set(lista);
  return palavras.filter((p) => set.has(p)).length;
}

// Proporção de inglês: quanto do total de stopwords detectadas é EN.
function proporcaoIngles(texto) {
  const pt = contarStopwords(texto, STOPWORDS_PT);
  const en = contarStopwords(texto, STOPWORDS_EN);
  const total = pt + en;
  if (!total) return 0;
  return en / total;
}

// Índice temporário RAG (criado em os.tmpdir()); registrado para limpeza em finally.
const indicesTemporarios = [];
function novoIndiceTmp(sufixo) {
  const dir = path.join(os.tmpdir(), `estresse-ia-indice-${sufixo}-${Date.now()}`);
  indicesTemporarios.push(dir);
  return dir;
}

// Indexa um conjunto de arquivos (com texto já em memória) num índice temporário.
// Reusa o texto já lido para não reler a pasta real; retorna o resultado do RAG.
async function indexarEmTmp(indiceDir, arquivos) {
  const filesMeta = arquivos.map((f) => ({ path: f.path, name: f.name, mtime: f.mtime, size: f.size }));
  const scannedPaths = filesMeta.map((m) => ({ path: m.path, mtime: m.mtime, size: m.size }));
  const porPath = new Map(arquivos.map((f) => [f.path, f.text]));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_CASO_MS);
  try {
    return await rag.indexFilesStreaming({
      rootFolder: indiceDir,
      filesMeta,
      scannedPaths,
      readText: async (p) => ({ ok: true, text: porPath.get(p) || '', name: path.basename(p) }),
      embed: ai.embed,
      embedModel: ai.DEFAULT_EMBED_MODEL,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Relatório
// ---------------------------------------------------------------------------
function contarPorSeveridade() {
  const c = { crítica: 0, alta: 0, 'média': 0, baixa: 0 };
  for (const b of bugs) if (c[b.severidade] !== undefined) c[b.severidade] += 1;
  return c;
}

function gerarRelatorio({ pulado, motivo, statusOllama, totalMin, degradacoes }) {
  const sev = contarPorSeveridade();
  let md = `# Relatório de Estresse com IA REAL — CábulIA / Estudo AI\n\n`;
  md += `Gerado em: ${new Date().toLocaleString('pt-BR')}\n\n`;

  if (pulado) {
    md += `## Status: PULADO\n\n`;
    md += `${motivo}\n\n`;
    md += `> ${PREFIXO_PULADO}\n\n`;
    md += `Nenhum caso de IA foi executado. Saída com exitCode 0 (RF10/CA2).\n`;
    return md;
  }

  md += `Ollama: ${statusOllama}\n\n`;
  md += `Tempo total: ${totalMin} min · Casos: ${casos.length} · Passaram: ${passes.length} · Bugs: ${bugs.length}\n\n`;
  md += `Severidades — crítica: ${sev.crítica} · alta: ${sev.alta} · média: ${sev['média']} · baixa: ${sev.baixa}\n\n`;

  md += `## Tempos por caso\n\n`;
  md += `| Área | Caso | Status | Tempo | Iterações/Lotes |\n`;
  md += `|------|------|--------|-------|-----------------|\n`;
  for (const c of casos) {
    const emoji = c.status === 'OK' ? '✅' : '❌';
    md += `| ${c.area} | ${c.nome} | ${emoji} ${c.status} | ${Math.round(c.ms / 1000)}s | ${c.iteracoes ?? '-'} |\n`;
  }
  md += `\n`;

  if (bugs.length) {
    const ordenados = bugs.slice().sort((a, b) => (ORDEM_SEVERIDADE[a.severidade] ?? 9) - (ORDEM_SEVERIDADE[b.severidade] ?? 9));
    md += `## Problemas encontrados\n\n`;
    for (const b of ordenados) {
      md += `### [${b.severidade}] ${b.area} · ${b.titulo}\n\n`;
      md += `${b.detalhe}\n\n`;
      if (b.sugestao) md += `> Sugestão: ${b.sugestao}\n\n`;
    }
  } else {
    md += `Nenhum problema encontrado nos casos de IA. 🎉\n\n`;
  }

  if (degradacoes && degradacoes.length) {
    md += `## Degradações registradas\n\n`;
    for (const d of degradacoes) md += `- ${d}\n`;
    md += `\n`;
  }

  md += `> Índices de IA sempre em os.tmpdir() e removidos ao final (INV6). Nada escrito fora de os.tmpdir() (INV1).\n`;
  return md;
}

function salvarRelatorio(md) {
  try {
    fs.writeFileSync(RELATORIO, md, 'utf-8');
    console.log(`\n📄 Relatório salvo em: ${RELATORIO}`);
  } catch (e) {
    console.log(`⚠ Não consegui gravar o relatório em ${RELATORIO}: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Principal
// ---------------------------------------------------------------------------
async function main() {
  const log = (...a) => console.log(...a);
  log('🔥 Beta Tester de Estresse com IA REAL — CábulIA / Estudo AI');
  log('============================================================');

  // Checagem de Ollama: PULA e sai 0 se ausente ou sem modelos (RF10/CA2).
  let status;
  try {
    status = await ai.checkStatus();
  } catch (e) {
    status = { ok: false, reason: 'erro: ' + (e && e.message), models: [] };
  }
  if (!status || !status.ok || !(status.models && status.models.length)) {
    log(PREFIXO_PULADO);
    const motivo = !status || !status.ok
      ? 'checkStatus() indicou que o Ollama não está acessível.'
      : 'O Ollama está acessível, mas nenhum modelo está instalado.';
    salvarRelatorio(gerarRelatorio({ pulado: true, motivo }));
    process.exitCode = 0;
    return;
  }

  log(`Ollama OK · modelos: ${status.models.join(', ')}`);

  const degradacoes = [];
  const inicioTotal = Date.now();

  // Sandbox de fixtures em os.tmpdir() (somente leitura + sentinela INV1).
  const RAIZ_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'estresse-ia-'));
  const materialDir = path.join(RAIZ_TMP, 'material');
  fs.mkdirSync(materialDir, { recursive: true });
  semearFixtures(materialDir);
  const snapAntes = snapshotDir(materialDir);

  const biologiaPath = path.join(materialDir, 'biologia.txt');
  const historiaPath = path.join(materialDir, 'historia.txt');
  const curtoPath = path.join(materialDir, 'curto.txt');
  const semSentidoPath = path.join(materialDir, 'sem-sentido.txt');

  const textoBiologia = fs.readFileSync(biologiaPath, 'utf-8');
  const textoHistoria = fs.readFileSync(historiaPath, 'utf-8');
  const textoCurto = fs.readFileSync(curtoPath, 'utf-8');
  const textoSemSentido = fs.readFileSync(semSentidoPath, 'utf-8');

  try {
    // (1) Texto gigante em generateSummary (curto) — mede tempo; ok OU erro
    // controlado de memória/contexto; nunca throw/trava.
    const gigante = textoRepetido(
      'A fotossíntese transforma luz, água e CO2 em glicose. A respiração celular libera energia a partir da glicose',
      4000
    );
    log('\n== IA · casos adversariais ==');
    await casoIA('IA', 'Texto gigante (resumo curto)',
      (signal) => ai.generateSummary(gigante, { nivel: 'curto', signal }),
      (res) => {
        assert(res && typeof res === 'object', 'generateSummary não retornou objeto.', { severidade: 'alta' });
        if (!res.ok) {
          // Erro controlado é aceitável (memória/contexto); só não pode travar.
          assert(typeof res.error === 'string' && res.error.length > 0,
            'Falhou sem mensagem de erro clara.', { severidade: 'alta' });
          degradacoes.push(`Texto gigante retornou erro controlado: ${res.error}`);
        } else {
          assert(typeof res.text === 'string', 'Resumo ok sem campo text.', { severidade: 'alta' });
        }
      });

    // (2) Texto sem sentido — ok com resposta curta OU erro controlado.
    await casoIA('IA', 'Texto sem sentido (resumo)',
      (signal) => ai.generateSummary(textoSemSentido, { nivel: 'curto', signal }),
      (res) => {
        assert(res && typeof res === 'object', 'Não retornou objeto.', { severidade: 'alta' });
        if (res.ok) {
          const txt = (res.text || '').trim();
          if (!txt) bug('média', 'IA', 'Texto sem sentido (resumo)', 'Resposta vazia para entrada sem sentido.', 'Considerar mensagem padrão quando o material é ruído.');
        }
      });

    // (3) Idioma trocado — material PT, idioma English; resposta deve
    // predominar em inglês (heurística). Divergência => baixa.
    await casoIA('IA', 'Idioma trocado (English)',
      (signal) => ai.generateSummary(textoBiologia, { nivel: 'curto', idioma: 'English', signal }),
      (res) => {
        assert(res && typeof res === 'object', 'Não retornou objeto.', { severidade: 'alta' });
        if (res.ok && res.text) {
          const prop = proporcaoIngles(res.text);
          if (prop < 0.5) {
            bug('baixa', 'IA', 'Idioma trocado (English)',
              `A resposta não ficou predominantemente em inglês (proporção EN ≈ ${prop.toFixed(2)}).`,
              'Reforçar a instrução de idioma no prompt.');
          }
        }
      });

    // (4) Mapa mental de texto curto — valida shape { central, nodes }.
    await casoIA('IA', 'Mapa mental (texto curto)',
      (signal) => ai.generateMindmap(textoCurto, { signal }),
      (res) => {
        assert(res && typeof res === 'object', 'Não retornou objeto.', { severidade: 'alta' });
        if (res.ok) {
          assert(res.map && typeof res.map === 'object', 'Mapa ok sem objeto map.', { severidade: 'alta' });
          assert(res.map.central, 'Mapa sem tema central.', { severidade: 'média', sugestao: 'Garantir central no JSON do mapa.' });
          assert(Array.isArray(res.map.nodes), 'Mapa sem array de nodes.', { severidade: 'alta' });
        } else {
          assert(typeof res.error === 'string', 'Falha de mapa sem mensagem.', { severidade: 'alta' });
          degradacoes.push(`Mapa de texto curto falhou (controlado): ${res.error}`);
        }
      });

    // --- RAG: indexa biologia + historia em os.tmpdir() ---
    const indiceRag = novoIndiceTmp('rag');
    const arquivosRag = [
      { path: biologiaPath, name: 'biologia.txt', mtime: fs.statSync(biologiaPath).mtimeMs, size: fs.statSync(biologiaPath).size, text: textoBiologia },
      { path: historiaPath, name: 'historia.txt', mtime: fs.statSync(historiaPath).mtimeMs, size: fs.statSync(historiaPath).size, text: textoHistoria },
    ];
    let ragIndexado = false;
    const temEmbed = rag.hasEmbedModel(status.models, ai.DEFAULT_EMBED_MODEL);
    if (!temEmbed) {
      const msg = `Modelo de embedding "${ai.DEFAULT_EMBED_MODEL}" ausente; pulando os casos de RAG.`;
      log(`  ℹ ${msg}`);
      degradacoes.push(msg);
    } else {
      log('\n== RAG · indexação em os.tmpdir() ==');
      const idx = await casoIA('RAG', 'Indexação das fixtures',
        () => indexarEmTmp(indiceRag, arquivosRag),
        (res) => {
          assert(res && res.ok, 'Indexação RAG falhou: ' + ((res && res.error) || 'motivo desconhecido'), { severidade: 'alta' });
        },
        arquivosRag.length);
      ragIndexado = !!(idx && idx.ok);
    }

    if (ragIndexado) {
      // (5) RAG — pergunta FORA do material => deve dizer não-encontrado OU não
      // citar fonte/fato inexistente. Citar algo inventado => alucinação (alta).
      await casoIA('RAG', 'Pergunta fora do material (alucinação?)',
        () => rag.ask({ rootFolder: indiceRag, pergunta: 'Qual é a receita de bolo de cenoura com cobertura de chocolate?', embed: ai.embed, generate: ai.generate }),
        (res) => {
          assert(res && res.ok, 'ask() falhou: ' + ((res && res.error) || '?'), { severidade: 'alta' });
          const resp = (res.resposta || '').toLowerCase();
          const admitiuNaoSaber = resp.includes('não encontrei isso no material');
          const citou = /\[\d+\]/.test(res.resposta || '');
          const falouDeBolo = /bolo|cenoura|cobertura|receita/.test(resp);
          if (!admitiuNaoSaber && (citou || falouDeBolo)) {
            bug('alta', 'RAG', 'Pergunta fora do material (alucinação?)',
              'A resposta inventou conteúdo/fonte para uma pergunta ausente do material indexado.',
              'Reforçar a instrução anti-alucinação do buildAnswerPrompt.');
          }
        });

      // (6) RAG — pergunta pertinente => resposta não vazia com citação [n].
      await casoIA('RAG', 'Pergunta pertinente (citação [n])',
        () => rag.ask({ rootFolder: indiceRag, pergunta: 'O que a mitocôndria faz na célula?', embed: ai.embed, generate: ai.generate }),
        (res) => {
          assert(res && res.ok, 'ask() falhou: ' + ((res && res.error) || '?'), { severidade: 'alta' });
          const resp = (res.resposta || '').trim();
          assert(resp.length > 0, 'Resposta vazia para pergunta pertinente.', { severidade: 'média' });
          if (!/\[\d+\]/.test(resp) && !resp.toLowerCase().includes('não encontrei isso no material')) {
            bug('média', 'RAG', 'Pergunta pertinente (citação [n])',
              'A resposta não citou a fonte entre colchetes [n].',
              'Garantir o pedido de citação no prompt de resposta.');
          }
        });
    }

    // (7) Exercícios de material misturado (biologia + historia), quantidade:5
    // => confere seção ## Gabarito.
    const misturado = textoBiologia + '\n\n' + textoHistoria;
    log('\n== IA · exercícios ==');
    await casoIA('IA', 'Exercícios de material misturado (qtd 5)',
      (signal) => ai.generateExercises(misturado, { quantidade: 5, tipo: 'mistas', signal }),
      (res) => {
        assert(res && typeof res === 'object', 'Não retornou objeto.', { severidade: 'alta' });
        if (res.ok) {
          const txt = res.text || '';
          if (!/##\s*Gabarito/i.test(txt)) {
            bug('média', 'IA', 'Exercícios de material misturado (qtd 5)',
              'A lista de exercícios não trouxe a seção "## Gabarito".',
              'Reforçar no prompt a exigência de uma seção única de gabarito no final.');
          }
        } else {
          assert(typeof res.error === 'string', 'Falha de exercícios sem mensagem.', { severidade: 'alta' });
          degradacoes.push(`Exercícios misturados falharam (controlado): ${res.error}`);
        }
      });

    // (9) Opcional — PASTA_REAL somente leitura: lê até MAX_ARQUIVOS, indexa em
    // os.tmpdir() e faz 1 pergunta. NADA escrito na pasta real.
    const pastaReal = process.env.PASTA_REAL;
    if (pastaReal) {
      await parteReal(pastaReal, status, degradacoes, log);
    } else {
      log('\n⏭  PASTA_REAL não definida; pulando o caso opcional da pasta real.');
    }

  } finally {
    // Sentinela INV1: confere que o material de fixtures ficou intacto.
    try {
      const snapDepois = snapshotDir(materialDir);
      const difs = diffSnapshot(snapAntes, snapDepois);
      if (difs.length) {
        bug('crítica', 'INV1', 'Material de fixtures alterado',
          'A sentinela de FS detectou alterações no material (somente leitura): ' + difs.join('; '),
          'Nenhum caso deve escrever/mover/apagar fora de os.tmpdir() nas fixtures de leitura.');
      }
    } catch (e) {
      bug('alta', 'INV1', 'Sentinela de FS falhou', 'Não consegui reconferir o snapshot: ' + (e && e.message), '');
    }
    // INV6: remove índices temporários e o sandbox inteiro.
    for (const dir of indicesTemporarios) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
    try { fs.rmSync(RAIZ_TMP, { recursive: true, force: true }); } catch {}
  }

  const totalMin = ((Date.now() - inicioTotal) / 60000).toFixed(1);
  const md = gerarRelatorio({
    pulado: false,
    statusOllama: `OK (${status.models.length} modelo(s))`,
    totalMin,
    degradacoes,
  });
  salvarRelatorio(md);

  const sev = contarPorSeveridade();
  log(`\nConcluído em ${totalMin} min · casos: ${casos.length} · bugs: ${bugs.length} (crítica ${sev.crítica}, alta ${sev.alta}).`);
  // exitCode != 0 se houver 'crítica' ou 'alta' (a ausência de Ollama já foi
  // tratada acima com exitCode 0).
  if (sev.crítica > 0 || sev.alta > 0) {
    log('❌ Há bug(s) de severidade crítica/alta.');
    process.exitCode = 1;
  } else {
    log('✅ Sem bugs críticos/altos nos casos de IA.');
  }
}

// Parte opcional §4.9 — pasta real, SOMENTE LEITURA (padrão da Parte B do
// beta-tester-cruzado): lê até MAX_ARQUIVOS, indexa em os.tmpdir(), faz 1
// pergunta. Nada é escrito na pasta real; sentinela por snapshot da raiz.
async function parteReal(pastaReal, status, degradacoes, log) {
  if (!fs.existsSync(pastaReal)) {
    const msg = `PASTA_REAL "${pastaReal}" não existe; pulando o caso opcional.`;
    log(`\n⏭  ${msg}`);
    degradacoes.push(msg);
    return;
  }

  log(`\n▶ Caso opcional — pasta real SOMENTE LEITURA:\n    ${pastaReal}`);
  // Snapshot raso da raiz (nomes) como sentinela de "nada escrito".
  let snapRaizAntes = [];
  try { snapRaizAntes = fs.readdirSync(pastaReal).sort(); } catch {}

  const lib = library.scan(pastaReal);
  const arquivos = (lib.notebooks || []).flatMap((n) => n.files);
  const MAX = Number(process.env.MAX_ARQUIVOS) || 40;
  const alvo = arquivos.slice(0, MAX);
  log(`    Encontrados ${arquivos.length} arquivo(s); lendo até ${MAX}.`);

  const lidos = [];
  for (let i = 0; i < alvo.length; i++) {
    const f = alvo[i];
    log(`    [${i + 1}/${alvo.length}] ${f.name}`);
    const r = await library.readFileText(f.path); // SOMENTE LEITURA
    if (r && r.ok && typeof r.text === 'string' && r.text.trim()) {
      lidos.push({ path: f.path, name: f.name, text: r.text, mtime: f.mtime, size: f.size });
    }
  }

  if (!rag.hasEmbedModel(status.models, ai.DEFAULT_EMBED_MODEL)) {
    const msg = `Modelo de embedding ausente; pasta real lida (${lidos.length} arquivo(s)) mas sem indexação RAG.`;
    log(`    ℹ ${msg}`);
    degradacoes.push(msg);
  } else if (!lidos.length) {
    degradacoes.push('Pasta real sem arquivos legíveis para indexar.');
  } else {
    const indiceReal = novoIndiceTmp('real');
    await casoIA('PastaReal', 'Indexação (os.tmpdir)',
      () => indexarEmTmp(indiceReal, lidos),
      (res) => assert(res && res.ok, 'Indexação da pasta real falhou: ' + ((res && res.error) || '?'), { severidade: 'alta' }),
      lidos.length);
    await casoIA('PastaReal', '1 pergunta sobre a pasta real',
      () => rag.ask({ rootFolder: indiceReal, pergunta: 'Faça um resumo de um ponto importante deste material.', embed: ai.embed, generate: ai.generate }),
      (res) => assert(res && res.ok, 'ask() na pasta real falhou: ' + ((res && res.error) || '?'), { severidade: 'alta' }));
  }

  // Sentinela de INV1 na raiz da pasta real.
  try {
    const snapRaizDepois = fs.readdirSync(pastaReal).sort();
    if (JSON.stringify(snapRaizAntes) !== JSON.stringify(snapRaizDepois)) {
      bug('crítica', 'INV1', 'Pasta real alterada',
        'A listagem da raiz da pasta real mudou após o teste (deveria ser somente leitura).',
        'Garantir que nenhum caminho de escrita aponte para a pasta real.');
    }
  } catch {}
}

main().catch((e) => {
  console.error('Falha no beta-tester de estresse com IA:', e && e.stack ? e.stack : e);
  // Falha inesperada do próprio runner não é "ausência de Ollama".
  process.exitCode = 2;
});
