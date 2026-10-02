'use strict';

/**
 * Núcleo PURO do agrupamento (extraído de grouping.js).
 *
 * A ÚNICA dependência de Node permitida aqui é `crypto` (randomBytes para ids).
 * Este módulo NÃO importa `fs`, `path`, `./store` nem faz rede — logo pode ser
 * importado por outros núcleos puros (classification.js, plano.js) sem arrastar
 * I/O no grafo de require. É por isso que a Fase 3 importa daqui, e não de
 * `./grouping` (que carrega `./store`, o qual toca `fs` em tempo de carga).
 *
 * `grouping.js` reexporta tudo daqui com os MESMOS nomes/assinaturas: a API
 * pública do grouping fica inalterada.
 */

const crypto = require('crypto');

// Id fixo/reservado da disciplina de arquivos não classificados.
const ID_NAO_CLASSIFICADOS = 'disc_nao_classificados';
const NOME_NAO_CLASSIFICADOS = 'Não classificados';

// ===========================================================================
// Caminhos e sinais
// ===========================================================================

// Caminho relativo à raiz, por manipulação de STRING (lida com o separador `\`
// do Windows). Regra normativa do design.
function relPathOf(abs, root) {
  // 1) normaliza root: remove barra/contrabarra final para o prefixo bater.
  const base = String(root).replace(/[\\/]+$/, '');
  // 2) corta o prefixo root quando abs começa com ele.
  const absStr = String(abs);
  let rel = absStr.startsWith(base) ? absStr.slice(base.length) : absStr;
  // 3) normaliza TODAS as contrabarras para '/' e remove barras iniciais.
  rel = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  return rel;
}

// Subpasta de 1º nível a partir de relPath; null = arquivo na raiz.
function primeiroNivel(relPath) {
  const seg = String(relPath).split('/');
  return seg.length > 1 ? seg[0] : null;
}

// Último segmento de relPath (nome do arquivo).
function basenameOf(relPath) {
  const seg = String(relPath).split('/');
  return seg[seg.length - 1];
}

// Trunca um texto nas primeiras N palavras (sem cortar palavra no meio).
function truncatePalavras(text, n) {
  return String(text || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, n)
    .join(' ');
}

// Monta o "sinal barato" de um arquivo para classificação.
// file: { name, path, mtime, size }   text: string já extraída (pode ser '')
// Retorna: { path, name, relPath, snippet }   (SEM ext)
function buildSignal(file, text, root) {
  const relPath = relPathOf(file.path, root);
  return {
    path: file.path,
    name: file.name,
    relPath,
    snippet: truncatePalavras(text, 150),
  };
}

function buildSignals(files, textsByPath, root) {
  return (files || []).map((f) => buildSignal(f, (textsByPath || {})[f.path] || '', root));
}

// Gera ids locais estáveis: prefix + 6 hex de crypto.randomBytes(3).
function genId(prefix) {
  return prefix + crypto.randomBytes(3).toString('hex');
}

// ===========================================================================
// Lotes, prompt e parse
// ===========================================================================

// Divide os sinais em lotes que cabem no contexto do modelo. Fecha o lote pelo
// teto que estourar primeiro. Arquivo cujo snippet sozinho excede o teto de
// chars é truncado para caber e vai sozinho no lote.
function chunkSignals(signals, { maxCharsPorLote = 6000, maxArquivosPorLote = 12 } = {}) {
  const lotes = [];
  let atual = [];
  let charsAtual = 0;

  for (const s of signals) {
    const custo = (s.snippet || '').length;

    // Arquivo gigante: fecha o lote corrente (se houver) e vai sozinho,
    // com snippet truncado para o teto.
    if (custo > maxCharsPorLote) {
      if (atual.length) {
        lotes.push(atual);
        atual = [];
        charsAtual = 0;
      }
      const truncado = Object.assign({}, s, { snippet: (s.snippet || '').slice(0, maxCharsPorLote) });
      lotes.push([truncado]);
      continue;
    }

    const estouraChars = atual.length > 0 && charsAtual + custo > maxCharsPorLote;
    const estouraArquivos = atual.length >= maxArquivosPorLote;
    if (estouraChars || estouraArquivos) {
      lotes.push(atual);
      atual = [];
      charsAtual = 0;
    }
    atual.push(s);
    charsAtual += custo;
  }

  if (atual.length) lotes.push(atual);
  return lotes;
}

// Monta o prompt de classificação de UM lote. PT-BR. Numera os arquivos do lote
// por ÍNDICE (0..n-1), pede JSON e instrui reusar disciplinasConhecidas.
function buildBatchPrompt(signalsLote, { disciplinasConhecidas = [] } = {}) {
  const linhas = signalsLote.map((s, i) => {
    const pasta = primeiroNivel(s.relPath) || '(raiz)';
    const trecho = (s.snippet || '').replace(/\s+/g, ' ').trim();
    return `${i}) nome: ${s.name} | pasta: ${pasta} | trecho: "${trecho}"`;
  });

  const conhecidas = (disciplinasConhecidas || []).filter(Boolean);
  const blocoConhecidas = conhecidas.length
    ? `\nDisciplinas já conhecidas (reutilize EXATAMENTE um destes nomes quando couber): ${conhecidas.join(', ')}.\n`
    : '';

  return `Você é um organizador de material de estudo. Analise os arquivos abaixo e, para cada um, diga a qual DISCIPLINA ele pertence.

Cada arquivo tem um índice (id). Use nomes de disciplina curtos e canônicos (ex.: "Cálculo I", "História").
${blocoConhecidas}Quando não souber classificar um arquivo, use o rótulo "${NOME_NAO_CLASSIFICADOS}".
Não invente conteúdo. Baseie-se só no nome, na pasta e no trecho.

ARQUIVOS:
${linhas.join('\n')}

Responda SOMENTE com JSON válido, sem texto antes ou depois, exatamente neste formato:
{ "arquivos": [ { "id": 0, "disciplina": "Nome da disciplina" } ] }`;
}

// Parse defensivo da resposta de UM lote. Mapeia id -> signalsLote[id].path
// LOCALMENTE. JSON inválido / id ausente / fora de range / não-inteiro ->
// aquele arquivo cai em "Não classificados". Retorna [{ path, disciplina }].
function parseBatchResponse(rawText, signalsLote) {
  const n = signalsLote.length;
  // Rótulo default: começa todos como "Não classificados"; a resposta válida
  // sobrescreve por índice.
  const rotuloPorIndice = new Array(n).fill(NOME_NAO_CLASSIFICADOS);

  let parsed = null;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = null;
  }

  const arquivos = parsed && Array.isArray(parsed.arquivos) ? parsed.arquivos : [];
  for (const item of arquivos) {
    if (!item || typeof item !== 'object') continue;
    const id = item.id;
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || id >= n) continue;
    const disc = typeof item.disciplina === 'string' && item.disciplina.trim()
      ? item.disciplina.trim()
      : NOME_NAO_CLASSIFICADOS;
    rotuloPorIndice[id] = disc;
  }

  return signalsLote.map((s, i) => ({ path: s.path, disciplina: rotuloPorIndice[i] }));
}

// ===========================================================================
// Detecção de Ollama offline (fatal) por PREFIXO de mensagem.
// ===========================================================================

function isOllamaOffline(res) {
  return !!res && res.ok === false && typeof res.error === 'string'
    && res.error.startsWith('Ollama não está rodando');
}

module.exports = {
  // constantes
  ID_NAO_CLASSIFICADOS,
  NOME_NAO_CLASSIFICADOS,
  // caminhos/sinais
  relPathOf,
  primeiroNivel,
  basenameOf,
  truncatePalavras,
  buildSignal,
  buildSignals,
  genId,
  // lotes/prompt/parse
  chunkSignals,
  buildBatchPrompt,
  parseBatchResponse,
  // offline
  isOllamaOffline,
};
