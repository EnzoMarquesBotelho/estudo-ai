'use strict';

/**
 * RAG local (Fase 2) — "Perguntar sobre o acervo".
 *
 * Mesma separação de camadas de grouping.js:
 *   - NÚCLEO PURO: funções determinísticas que operam só sobre argumentos
 *     explícitos. A ÚNICA dependência de Node permitida aqui é `crypto`
 *     (createHash para ids/chaves). O núcleo NÃO importa `fs`/`path`/`os` nem
 *     faz rede — logo é incapaz, por construção, de tocar o material de estudo
 *     do usuário no disco.
 *   - Camada de PERSISTÊNCIA (`ragStore`): usa `fs`/`path`/`os` e replica
 *     `store.resolveDataDir` (userData do Electron, com fallback na temp). SÓ
 *     escreve/apaga arquivos dentro de `<userData>/rag/`.
 *
 * As chamadas ao Ollama (`embed`, `generate`) são sempre INJETADAS de fora, para
 * que o núcleo e a orquestração sejam testáveis sem rede (ver tests/testar-rag.js).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ===========================================================================
// Constantes do núcleo (design §2.4)
// ===========================================================================
const MAX_CHARS = 1000;        // tamanho máximo (chars) de um chunk
const OVERLAP = 200;           // sobreposição (chars) entre chunks adjacentes
const K_DEFAULT = 5;           // top-K padrão
const EMBED_BATCH = 16;        // nº de trechos por lote de embedding
const MAX_PROMPT_CHARS = 6000; // teto da soma dos trechos no prompt
const MAX_PERGUNTA_CHARS = 2000;
const TRECHO_CURTO_CHARS = 160;

// ===========================================================================
// NÚCLEO — chunking
// ===========================================================================

// Normaliza espaços como o cleanup de library.js faz na extração.
function normalizarEspacos(texto) {
  return String(texto || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Procura, dentro de [de, ate), a última fronteira de parágrafo/sentença para
// cortar sem partir uma ideia. Retorna o índice de corte (exclusivo) ou -1.
function fronteiraDeCorte(texto, de, ate) {
  const janela = texto.slice(de, ate);
  // Preferência: quebra de parágrafo, depois fim de sentença, depois espaço.
  const candidatos = [
    janela.lastIndexOf('\n\n'),
    janela.lastIndexOf('\n'),
    janela.lastIndexOf('. '),
    janela.lastIndexOf('! '),
    janela.lastIndexOf('? '),
    janela.lastIndexOf('; '),
  ];
  let melhor = -1;
  for (const c of candidatos) {
    if (c > melhor) melhor = c;
  }
  if (melhor < 0) return -1;
  // +1 para incluir o próprio delimitador no chunk atual.
  return de + melhor + 1;
}

// Divide o texto em chunks de até maxChars com sobreposição de overlap chars.
// Quebra preferencialmente em fronteira de parágrafo/sentença dentro de uma
// janela de tolerância; se não houver, corta no limite de chars. Nenhum texto
// é perdido (os chunks cobrem todo o conteúdo, com sobreposição).
// texto vazio/whitespace -> [].
function chunkText(texto, { maxChars = MAX_CHARS, overlap = OVERLAP } = {}) {
  const limpo = normalizarEspacos(texto);
  if (!limpo) return [];

  const max = Math.max(1, Number(maxChars) || MAX_CHARS);
  const ov = Math.min(Math.max(0, Number(overlap) || 0), max - 1);

  const chunks = [];
  let inicio = 0;
  let ordem = 0;

  while (inicio < limpo.length) {
    let fim = Math.min(inicio + max, limpo.length);

    // Se não chegamos ao fim do texto, tenta cortar numa fronteira "bonita"
    // dentro de uma janela de tolerância perto do fim do chunk.
    if (fim < limpo.length) {
      const janelaInicio = inicio + Math.floor(max * 0.6); // só na parte final
      const corte = fronteiraDeCorte(limpo, Math.max(inicio + 1, janelaInicio), fim);
      if (corte > inicio) fim = corte;
    }

    const trecho = limpo.slice(inicio, fim).trim();
    if (trecho) {
      chunks.push({ ordem, trecho });
      ordem += 1;
    }

    if (fim >= limpo.length) break;
    // Avança recuando o overlap, garantindo progresso (>= 1 char).
    const proximo = fim - ov;
    inicio = proximo > inicio ? proximo : fim;
  }

  return chunks;
}

// ===========================================================================
// NÚCLEO — similaridade / recuperação
// ===========================================================================

// Produto escalar normalizado. Vetores de tamanhos diferentes ou norma zero -> 0.
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]);
    const y = Number(b[i]);
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Ranqueia os chunks por similaridade de cosseno com queryVec (desc). Ignora
// chunks sem vetor válido. Retorna [{ chunk, score }].
function topK(queryVec, chunks, k = K_DEFAULT) {
  const kk = Math.max(1, Number.isFinite(k) ? Math.floor(k) : K_DEFAULT);
  const ranqueados = [];
  for (const chunk of chunks || []) {
    if (!chunk || !Array.isArray(chunk.vetor) || !chunk.vetor.length) continue;
    const score = cosineSimilarity(queryVec, chunk.vetor);
    ranqueados.push({ chunk, score });
  }
  ranqueados.sort((x, y) => y.score - x.score);
  return ranqueados.slice(0, kk);
}

// ===========================================================================
// NÚCLEO — normalização defensiva da resposta de embedding
// ===========================================================================

// Converte respostas de /api/embed e /api/embeddings (e estilo OpenAI) em
// number[][]. Preserva a ordem entrada->saída e valida dim consistente.
// Nenhum formato casar / vetor não-numérico / dim divergente -> throw.
function normalizeEmbedResponse(data) {
  const ERRO = 'Resposta de embedding em formato inesperado.';
  if (!data || typeof data !== 'object') throw new Error(ERRO);

  let vetores = null;

  if (Array.isArray(data.embeddings)) {
    // /api/embed com input array: array de arrays.
    vetores = data.embeddings;
  } else if (Array.isArray(data.embedding)) {
    // /api/embeddings (item a item): um vetor -> embrulha em [[...]].
    vetores = [data.embedding];
  } else if (Array.isArray(data.data)) {
    // Estilo OpenAI: data[].embedding.
    vetores = data.data.map((d) => (d && d.embedding));
  }

  if (!Array.isArray(vetores) || !vetores.length) throw new Error(ERRO);

  let dim = null;
  const out = [];
  for (const v of vetores) {
    if (!Array.isArray(v) || !v.length) throw new Error(ERRO);
    for (const n of v) {
      if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(ERRO);
    }
    if (dim === null) dim = v.length;
    else if (v.length !== dim) throw new Error(ERRO);
    out.push(v);
  }
  return out;
}

// ===========================================================================
// NÚCLEO — montagem do prompt (anti-alucinação + citação)
// ===========================================================================

// Seleciona trechos (já ranqueados por score desc) até somar MAX_PROMPT_CHARS;
// descarta o excedente (os de menor score). A moldura + a pergunta ficam fora
// desse teto. ranqueados = [{ chunk:{ path, trecho, ... }, score }].
// Retorna [{ path, trecho }].
function selecionarTrechos(ranqueados, { maxPromptChars = MAX_PROMPT_CHARS } = {}) {
  const teto = Math.max(1, Number(maxPromptChars) || MAX_PROMPT_CHARS);
  const selecionados = [];
  let soma = 0;
  for (const r of ranqueados || []) {
    const chunk = r && r.chunk ? r.chunk : r;
    if (!chunk || typeof chunk.trecho !== 'string') continue;
    const custo = chunk.trecho.length;
    if (selecionados.length && soma + custo > teto) break;
    selecionados.push({ path: chunk.path, trecho: chunk.trecho });
    soma += custo;
  }
  return selecionados;
}

// Nome do arquivo a partir do caminho absoluto (por string, igual ao núcleo de
// grouping/renderer). Mantém o prompt legível sem depender de `path`.
function nomeArquivo(p) {
  const partes = String(p || '').replace(/\\/g, '/').split('/');
  return partes[partes.length - 1] || String(p || '');
}

// Monta o prompt PT-BR com instrução anti-alucinação e pedido de citação.
// trechos = [{ path, trecho }] já selecionados e cortados pelo teto.
function buildAnswerPrompt(pergunta, trechos) {
  const lista = (trechos || []).map((t, i) => {
    const nome = nomeArquivo(t.path);
    return `[${i + 1}] (arquivo: ${nome})\n"""${t.trecho}"""`;
  }).join('\n');

  return `Você é um assistente de estudos. Responda à pergunta do aluno USANDO SOMENTE os
trechos do material abaixo. Se a resposta não estiver nos trechos, diga
claramente: "Não encontrei isso no material indexado." Não invente fatos,
datas, fórmulas ou nomes que não estejam nos trechos.
Ao usar uma informação, cite a fonte entre colchetes com o número do trecho (ex.: [1]).
Responda em português do Brasil, de forma clara e organizada (Markdown).

TRECHOS DO MATERIAL:
${lista}

PERGUNTA: ${pergunta}`;
}

// ===========================================================================
// NÚCLEO — disponibilidade do modelo de embedding
// ===========================================================================

// true se `embedModel` está entre os modelos instalados. Casa a tag exata
// (nomic-embed-text) ou versionada (nomic-embed-text:latest), SEM casar por
// engano nomic-embed-text-v2.
function hasEmbedModel(models, embedModel) {
  if (!Array.isArray(models) || !embedModel) return false;
  return models.some((m) => m === embedModel || m.startsWith(embedModel + ':'));
}

// ===========================================================================
// NÚCLEO — ids / chaves
// ===========================================================================

// Id determinístico de um chunk (rótulo interno; a dedup usa path+ordem).
function genChunkId(filePath, ordem) {
  const hash = crypto.createHash('sha1').update(String(filePath) + ':' + ordem).digest('hex').slice(0, 12);
  return 'c_' + hash;
}

// Chave de arquivo do índice (igual grouping.storeKey SEM o prefixo grouping::).
function indexKey(rootFolder) {
  return crypto.createHash('sha1').update(String(rootFolder)).digest('hex').slice(0, 12);
}

// ===========================================================================
// NÚCLEO — incremental (assinatura mtime+size)
// ===========================================================================

// ÚNICA fonte da assinatura de um arquivo. mtime é arredondado para ms inteiro
// (library.fileMeta usa st.mtimeMs, que é float em alguns SOs) para que a
// assinatura gravada e a comparada sejam byte-a-byte iguais.
function fileSig(file) {
  const mtime = Math.round(Number(file && file.mtime) || 0);
  const size = Number(file && file.size) || 0;
  return `${mtime}::${size}`;
}

// Compara o índice salvo com o scan atual.
//   scannedPaths: todos os arquivos no disco [{ path, mtime, size }] -> removidos.
//   files: os arquivos com texto a reprocessar [{ path, text, mtime, size }]
//          (text:'' quando a extração falhou; nunca omitido) -> novos/alterados.
// Retorna { novos:[file], alterados:[file], removidos:[path], inalterados:[path] }.
function diffForIndex(indice, { scannedPaths = [], files = [] } = {}) {
  const sigs = (indice && indice.fileSignatures) || {};

  const novos = [];
  const alterados = [];
  const inalterados = [];

  for (const file of files) {
    if (!file || typeof file.path !== 'string') continue;
    const assinaturaAtual = fileSig(file);
    const assinaturaSalva = sigs[file.path];
    if (assinaturaSalva === undefined) {
      novos.push(file);
    } else if (assinaturaSalva !== assinaturaAtual) {
      alterados.push(file);
    } else {
      inalterados.push(file.path);
    }
  }

  // removidos: paths conhecidos no índice que não existem mais no disco.
  const noDisco = new Set((scannedPaths || []).map((s) => s && s.path).filter(Boolean));
  const removidos = Object.keys(sigs).filter((p) => !noDisco.has(p));

  return { novos, alterados, removidos, inalterados };
}

// Remove (imutável) todos os chunks dos paths informados.
function pruneChunks(indice, removidosPaths) {
  const set = new Set(removidosPaths || []);
  const chunks = (indice.chunks || []).filter((c) => !set.has(c.path));
  return Object.assign({}, indice, { chunks });
}

// Remove os chunks antigos de `filePath` e insere os novos (imutável).
function upsertChunks(indice, filePath, novosChunks) {
  const chunks = (indice.chunks || []).filter((c) => c.path !== filePath);
  for (const c of novosChunks || []) chunks.push(c);
  return Object.assign({}, indice, { chunks });
}

// Reescreve fileSignatures APENAS com os arquivos efetivamente processados e
// seta generatedAt. ÚNICA função que seta generatedAt. A assinatura é SEMPRE
// produzida por fileSig (nunca montada à mão).
function refreshSignatures(indice, arquivosProcessados) {
  const sigs = {};
  for (const f of arquivosProcessados || []) {
    if (!f || typeof f.path !== 'string') continue;
    sigs[f.path] = fileSig(f);
  }
  return Object.assign({}, indice, { fileSignatures: sigs, generatedAt: Date.now() });
}

// ===========================================================================
// Camada de PERSISTÊNCIA (ragStore) — usa fs/path/os/electron com fallback.
// SÓ escreve/apaga dentro de <userData>/rag/. Nunca importada pelo núcleo puro.
// ===========================================================================

// Replica store.resolveDataDir: userData do Electron quando disponível, senão
// uma pasta na temp do sistema (permite teste fora do Electron).
function resolveDataDir() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') return app.getPath('userData');
  } catch {}
  const dir = path.join(os.tmpdir(), 'estudo-ai-data');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function ragDir() {
  return path.join(resolveDataDir(), 'rag');
}

function indexPath(rootFolder) {
  return path.join(ragDir(), indexKey(rootFolder) + '.json');
}

function metaPath(rootFolder) {
  return path.join(ragDir(), indexKey(rootFolder) + '.meta.json');
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

// Lê o índice COMPLETO (<key>.json). Só usado por indexFiles/ask.
function loadIndex(rootFolder) {
  return readJson(indexPath(rootFolder), null);
}

// Lê SÓ o cabeçalho leve (<key>.meta.json). Usado por status/openSource.
function loadMeta(rootFolder) {
  return readJson(metaPath(rootFolder), null);
}

// Deriva o cabeçalho leve a partir do índice completo.
function buildMeta(indice) {
  const paths = [];
  const vistos = new Set();
  for (const c of indice.chunks || []) {
    if (!vistos.has(c.path)) { vistos.add(c.path); paths.push(c.path); }
  }
  return {
    version: indice.version || 1,
    rootFolder: indice.rootFolder,
    modeloEmbedding: indice.modeloEmbedding || null,
    dim: indice.dim || null,
    generatedAt: indice.generatedAt || null,
    arquivos: paths.length,
    chunks: (indice.chunks || []).length,
    paths,
    fileSignatures: Object.assign({}, indice.fileSignatures || {}),
  };
}

// Grava o índice completo E o cabeçalho leve. Grava o .json primeiro; se o meta
// falhar, retorna false. ÚNICA função que produz o meta -> meta e índice nunca
// divergem.
function saveIndex(indice) {
  try {
    fs.mkdirSync(ragDir(), { recursive: true });
    fs.writeFileSync(indexPath(indice.rootFolder), JSON.stringify(indice), 'utf-8');
  } catch (e) {
    console.error('[rag] falha ao gravar índice', e && e.message);
    return false;
  }
  try {
    const meta = buildMeta(indice);
    fs.writeFileSync(metaPath(indice.rootFolder), JSON.stringify(meta), 'utf-8');
    return true;
  } catch (e) {
    console.error('[rag] falha ao gravar meta', e && e.message);
    return false;
  }
}

// Apaga ambos os arquivos ("reindexar do zero").
function clearIndex(rootFolder) {
  let ok = true;
  for (const f of [indexPath(rootFolder), metaPath(rootFolder)]) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { ok = false; }
  }
  return ok;
}

// Status do índice a partir do .meta.json. exists:false -> campos zerados/null.
function indexStatus(rootFolder) {
  const meta = loadMeta(rootFolder);
  if (!meta) {
    return { exists: false, arquivos: 0, chunks: 0, modeloEmbedding: null, dim: null, generatedAt: null };
  }
  return {
    exists: true,
    arquivos: meta.arquivos || 0,
    chunks: meta.chunks || 0,
    modeloEmbedding: meta.modeloEmbedding || null,
    dim: meta.dim || null,
    generatedAt: meta.generatedAt || null,
  };
}

const ragStore = {
  resolveDataDir,
  loadIndex,
  loadMeta,
  saveIndex,
  clearIndex,
  indexStatus,
};

// ===========================================================================
// ORQUESTRAÇÃO (usa núcleo + persistência + embed/generate injetados)
// ===========================================================================

// Índice vazio, pronto para receber chunks.
function indiceVazio(rootFolder, embedModel) {
  return {
    version: 1,
    rootFolder,
    modeloEmbedding: embedModel || null,
    dim: null,
    generatedAt: null,
    fileSignatures: {},
    chunks: [],
  };
}

// Detecta offline por PREFIXO de mensagem (mesmo padrão de grouping.isOllamaOffline).
function erroEhOffline(error) {
  return typeof error === 'string' && error.startsWith('Ollama não está rodando');
}

// Agrupa trechos em lotes de até EMBED_BATCH itens, com teto de chars por lote.
function montarLotes(trechos, { embedBatch = EMBED_BATCH, maxCharsLote = MAX_PROMPT_CHARS } = {}) {
  const lotes = [];
  let atual = [];
  let chars = 0;
  for (const t of trechos) {
    const custo = (t || '').length;
    const estouraItens = atual.length >= embedBatch;
    const estouraChars = atual.length > 0 && chars + custo > maxCharsLote;
    if (estouraItens || estouraChars) {
      lotes.push(atual);
      atual = [];
      chars = 0;
    }
    atual.push(t);
    chars += custo;
  }
  if (atual.length) lotes.push(atual);
  return lotes;
}

// Gera/atualiza o índice de forma incremental.
//   files: [{ name, text, path, mtime, size }] (text:'' = ilegível)
//   scannedPaths: [{ path, mtime, size }] (todos no disco; só p/ removidos)
// Retorna { ok, status, reindexados, removidos, pendentes } ou { ok:false, error }.
async function indexFiles({ rootFolder, files = [], scannedPaths = [], fromScratch = false, embed, embedModel, onProgress, signal } = {}) {
  let indice = fromScratch ? null : loadIndex(rootFolder);

  // Modelo divergente ou fromScratch -> começa do zero (vetores incomparáveis).
  const modeloDivergente = indice && embedModel && indice.modeloEmbedding && indice.modeloEmbedding !== embedModel;
  if (!indice || fromScratch || modeloDivergente) {
    indice = indiceVazio(rootFolder, embedModel);
  }

  // Assinaturas de ANTES de qualquer mutação (para preservar as dos inalterados).
  const sigsOriginais = Object.assign({}, indice.fileSignatures || {});

  const { novos, alterados, removidos } = diffForIndex(indice, { scannedPaths, files });
  const aReindexar = novos.concat(alterados);

  // Remove chunks dos removidos E dos alterados (serão regerados).
  const pathsAremover = removidos.concat(alterados.map((f) => f.path));
  indice = pruneChunks(indice, pathsAremover);

  const processados = []; // arquivos efetivamente indexados (>=1 chunk)
  const total = aReindexar.length;

  for (let i = 0; i < aReindexar.length; i++) {
    if (signal && signal.aborted) break;
    const file = aReindexar[i];
    if (onProgress) {
      onProgress({ phase: 'embed', current: i + 1, total, name: file.name || nomeArquivo(file.path) });
    }

    const pedacos = chunkText(file.text || '');
    if (!pedacos.length) {
      // Texto vazio/ilegível -> 0 chunks -> fica pendente (fora de processados).
      // Chunks antigos já foram removidos no prune acima (se era alterado).
      continue;
    }

    const trechos = pedacos.map((p) => p.trecho);
    const lotes = montarLotes(trechos);

    let vetores = [];
    let falhouArquivo = false;
    let indiceTrecho = 0;
    for (const lote of lotes) {
      let res;
      try {
        res = await embed(lote);
      } catch (e) {
        res = { ok: false, error: (e && e.message) || 'falha de embedding' };
      }
      if (!res || res.ok === false) {
        // Offline no 1º lote do 1º arquivo processado -> fatal (nada salvo).
        if (res && erroEhOffline(res.error) && !processados.length && indiceTrecho === 0) {
          console.warn('[rag] indexFiles offline no 1º lote:', res.error);
          return { ok: false, error: res.error };
        }
        // Falha de embedding de 1 arquivo -> recuperável: pula o arquivo.
        console.warn('[rag] indexFiles falha de embedding em', file.path, res && res.error);
        falhouArquivo = true;
        break;
      }
      vetores = vetores.concat(res.vetores || []);
      indiceTrecho += lote.length;
    }

    if (falhouArquivo || vetores.length !== pedacos.length) {
      // Não atualiza a signature -> arquivo fica pendente p/ próxima indexação.
      if (!falhouArquivo) console.warn('[rag] indexFiles contagem de vetores inesperada em', file.path);
      continue;
    }

    // Registra a dimensão a partir do 1º vetor conhecido.
    if (!indice.dim && vetores.length && Array.isArray(vetores[0])) {
      indice = Object.assign({}, indice, { dim: vetores[0].length });
    }

    const novosChunks = pedacos.map((p, idx) => ({
      id: genChunkId(file.path, p.ordem),
      path: file.path,
      ordem: p.ordem,
      trecho: p.trecho,
      vetor: vetores[idx],
    }));
    indice = upsertChunks(indice, file.path, novosChunks);
    processados.push(file);
  }

  // Preserva as assinaturas dos arquivos inalterados (as de antes da mutação) e
  // adiciona as dos arquivos efetivamente processados. refreshSignatures grava
  // SEMPRE via fileSig, então reconstruímos {path, mtime, size} a partir da
  // assinatura antiga "mtime::size".
  const inalteradosPreservados = [];
  const removidosSet = new Set(removidos);
  const reprocessadosSet = new Set(aReindexar.map((f) => f.path));
  for (const p of Object.keys(sigsOriginais)) {
    if (removidosSet.has(p)) continue;      // sumiu do disco
    if (reprocessadosSet.has(p)) continue;  // novo/alterado: tratado em processados
    inalteradosPreservados.push({ path: p, mtime: parseMtime(sigsOriginais[p]), size: parseSize(sigsOriginais[p]) });
  }

  const conjuntoFinal = inalteradosPreservados.concat(processados);
  indice = refreshSignatures(indice, conjuntoFinal);

  const salvou = saveIndex(indice);
  if (!salvou) return { ok: false, error: 'Não consegui salvar o índice.' };

  // Pendentes: arquivos no disco ainda não refletidos no índice salvo.
  const diffFinal = diffForIndex(indice, { scannedPaths, files });
  const pendentes = diffFinal.novos.length + diffFinal.alterados.length;

  const status = indexStatus(rootFolder);
  return { ok: true, status, reindexados: processados.length, removidos: removidos.length, pendentes };
}

// Extrai mtime/size de uma assinatura "mtime::size" (para reconstruir fileSig).
function parseMtime(sig) {
  const [m] = String(sig || '').split('::');
  return Number(m) || 0;
}
function parseSize(sig) {
  const partes = String(sig || '').split('::');
  return Number(partes[1]) || 0;
}

// Responde a uma pergunta sobre o acervo indexado.
//   scopePaths: null -> pasta inteira; array -> só chunks desses paths.
// Retorna { ok, resposta, fontes:[{path, trechoCurto}] } ou { ok:false, error }.
async function ask({ rootFolder, pergunta, scopePaths = null, embed, generate, k = K_DEFAULT } = {}) {
  const indice = loadIndex(rootFolder);
  if (!indice) return { ok: false, error: 'SEM_INDICE' };

  let chunks = indice.chunks || [];
  if (Array.isArray(scopePaths)) {
    const set = new Set(scopePaths);
    chunks = chunks.filter((c) => set.has(c.path));
  }

  if (!chunks.length) {
    return { ok: true, resposta: 'Não há material indexado nesse escopo.', fontes: [] };
  }

  let resEmbed;
  try {
    resEmbed = await embed([pergunta]);
  } catch (e) {
    resEmbed = { ok: false, error: (e && e.message) || 'falha de embedding' };
  }
  if (!resEmbed || resEmbed.ok === false) {
    return { ok: false, error: (resEmbed && resEmbed.error) || 'Falha ao gerar o embedding da pergunta.' };
  }
  const queryVec = (resEmbed.vetores || [])[0];

  const kk = Number.isFinite(k) && k >= 1 && k <= 20 ? Math.floor(k) : K_DEFAULT;
  const ranqueados = topK(queryVec, chunks, kk);
  const trechos = selecionarTrechos(ranqueados);

  const prompt = buildAnswerPrompt(pergunta, trechos);
  let resGen;
  try {
    resGen = await generate(prompt);
  } catch (e) {
    resGen = { ok: false, error: (e && e.message) || 'falha ao gerar resposta' };
  }
  if (!resGen || resGen.ok === false) {
    return { ok: false, error: (resGen && resGen.error) || 'Falha ao gerar a resposta.' };
  }

  // Fontes SEMPRE derivadas dos chunks do topK (dedup por path), inclusive
  // quando a resposta é "não encontrei" (são os trechos consultados).
  const fontes = [];
  const vistos = new Set();
  for (const r of ranqueados) {
    const chunk = r.chunk;
    if (vistos.has(chunk.path)) continue;
    vistos.add(chunk.path);
    fontes.push({
      path: chunk.path,
      trechoCurto: String(chunk.trecho || '').slice(0, TRECHO_CURTO_CHARS),
    });
  }

  return { ok: true, resposta: resGen.text || '', fontes };
}

module.exports = {
  // constantes
  MAX_CHARS,
  OVERLAP,
  K_DEFAULT,
  EMBED_BATCH,
  MAX_PROMPT_CHARS,
  MAX_PERGUNTA_CHARS,
  TRECHO_CURTO_CHARS,
  // puras — chunking/recuperação/prompt
  chunkText,
  cosineSimilarity,
  topK,
  normalizeEmbedResponse,
  selecionarTrechos,
  buildAnswerPrompt,
  hasEmbedModel,
  // ids/chaves
  genChunkId,
  indexKey,
  // incremental
  fileSig,
  diffForIndex,
  pruneChunks,
  upsertChunks,
  refreshSignatures,
  // persistência
  ragStore,
  loadIndex,
  loadMeta,
  saveIndex,
  clearIndex,
  indexStatus,
  // orquestração
  indexFiles,
  ask,
};
