'use strict';

/**
 * Agrupamento virtual por disciplina (Fase 1).
 *
 * Este módulo tem DUAS camadas claramente separadas:
 *   - Núcleo PURO: funções determinísticas que operam só sobre argumentos
 *     explícitos. A ÚNICA dependência de Node permitida aqui é `crypto`
 *     (randomBytes para ids, createHash para storeKey). O núcleo NÃO importa
 *     `fs` nem `path` nem faz rede — logo é incapaz, por construção, de tocar
 *     o material do usuário no disco.
 *   - Camada de PERSISTÊNCIA: loadMapping/saveMapping/clearMapping dependem de
 *     `./store` (estado global) e por isso não são puras. storeKey é puro.
 *
 * A chamada ao Ollama é sempre INJETADA de fora como `callGenerate`, para que o
 * núcleo seja testável sem rede (ver tests/testar-grouping.js).
 */

const crypto = require('crypto');
const store = require('./store');
const core = require('./grouping-core');

// Núcleo PURO reaproveitado de ./grouping-core (só `crypto`). Reexportado no
// module.exports para manter a API pública do grouping inalterada.
const {
  ID_NAO_CLASSIFICADOS,
  NOME_NAO_CLASSIFICADOS,
  relPathOf,
  primeiroNivel,
  basenameOf,
  truncatePalavras,
  buildSignal,
  buildSignals,
  genId,
  chunkSignals,
  buildBatchPrompt,
  parseBatchResponse,
  isOllamaOffline,
} = core;

// ===========================================================================
// NÚCLEO — consolidação / normalização de nomes
// ===========================================================================

// Chave canônica para comparar nomes de disciplina: trim + colapsar espaços +
// case-insensitive.
function chaveNome(nome) {
  return String(nome || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Monta um objeto de disciplinas a partir de uma lista [{ path, disciplina }],
// consolidando nomes equivalentes. "Não classificados" -> id fixo.
function consolidarDisciplinas(classificados) {
  const porChave = new Map(); // chaveNome -> { id, nome, arquivos:[] }
  const ordem = [];

  for (const c of classificados) {
    const nomeBruto = c.disciplina || NOME_NAO_CLASSIFICADOS;
    const ehNaoClass = chaveNome(nomeBruto) === chaveNome(NOME_NAO_CLASSIFICADOS);
    const chave = ehNaoClass ? '__nao_classificados__' : chaveNome(nomeBruto);
    let disc = porChave.get(chave);
    if (!disc) {
      disc = {
        id: ehNaoClass ? ID_NAO_CLASSIFICADOS : genId('disc_'),
        nome: ehNaoClass ? NOME_NAO_CLASSIFICADOS : nomeBruto.trim().replace(/\s+/g, ' '),
        arquivos: [],
      };
      porChave.set(chave, disc);
      ordem.push(chave);
    }
    if (!disc.arquivos.includes(c.path)) disc.arquivos.push(c.path);
  }

  return ordem.map((k) => porChave.get(k));
}

// Garante os invariantes 1 e 2: cada path em no máximo uma disciplina e, dentro
// dela, em no máximo um tópico. Opera sobre uma CÓPIA (imutável) e remove
// disciplinas duplicadas de arquivos preservando a primeira ocorrência.
function normalize(mapping) {
  const vistosDisc = new Set();
  const disciplinas = [];

  for (const d of mapping.disciplinas || []) {
    const arquivos = [];
    for (const p of d.arquivos || []) {
      if (vistosDisc.has(p)) continue; // já em outra disciplina
      vistosDisc.add(p);
      arquivos.push(p);
    }

    let topicos;
    if (Array.isArray(d.topicos)) {
      const vistosTop = new Set();
      topicos = d.topicos.map((t) => {
        const tarq = [];
        for (const p of t.arquivos || []) {
          // Só mantém no tópico arquivos que ainda pertencem à disciplina e que
          // não estão em outro tópico desta disciplina.
          if (!arquivos.includes(p)) continue;
          if (vistosTop.has(p)) continue;
          vistosTop.add(p);
          tarq.push(p);
        }
        return Object.assign({}, t, { arquivos: tarq });
      });
    }

    const nova = { id: d.id, nome: d.nome, arquivos };
    if (topicos) nova.topicos = topicos;
    disciplinas.push(nova);
  }

  return Object.assign({}, mapping, { disciplinas });
}

// ===========================================================================
// NÚCLEO — passo 1: classificação por disciplina
// ===========================================================================

// Classifica os sinais em disciplinas chamando a IA em lotes.
// callGenerate: (prompt) => Promise<{ ok, text }>  (injetado)
// onProgress: (p) => void  (p = { phase:'disciplinas', current, total, message })
// Sucesso -> { ok:true, disciplinas:[{ id, nome, arquivos:[path] }] }
// 1º lote offline -> { ok:false, error } e nada classificado.
async function classifyIntoDisciplinas(signals, { callGenerate, onProgress, disciplinasConhecidas = [] } = {}) {
  const lotes = chunkSignals(signals);
  const total = lotes.length;
  const classificados = [];
  const conhecidas = (disciplinasConhecidas || []).slice();

  for (let i = 0; i < lotes.length; i++) {
    const lote = lotes[i];
    if (onProgress) {
      onProgress({ phase: 'disciplinas', current: i + 1, total, message: `Classificando lote ${i + 1} de ${total}…` });
    }

    const prompt = buildBatchPrompt(lote, { disciplinasConhecidas: conhecidas });
    const res = await callGenerate(prompt);

    // 1º lote offline => fatal: aborta a run inteira sem classificar nada.
    if (i === 0 && isOllamaOffline(res)) {
      return { ok: false, error: res.error };
    }

    let doLote;
    if (res && res.ok && typeof res.text === 'string') {
      doLote = parseBatchResponse(res.text, lote);
    } else {
      // Qualquer outro ok:false (500/timeout/fetch) OU offline após o 1º lote:
      // recuperável -> todo o lote vira "Não classificados" e a run continua.
      doLote = lote.map((s) => ({ path: s.path, disciplina: NOME_NAO_CLASSIFICADOS }));
    }

    for (const c of doLote) {
      classificados.push(c);
      // Acumula disciplinasConhecidas descobertas (menos "Não classificados").
      if (chaveNome(c.disciplina) !== chaveNome(NOME_NAO_CLASSIFICADOS)
        && !conhecidas.some((n) => chaveNome(n) === chaveNome(c.disciplina))) {
        conhecidas.push(c.disciplina);
      }
    }
  }

  const disciplinas = consolidarDisciplinas(classificados);
  return { ok: true, disciplinas };
}

// Atalho porPasta: rotula cada arquivo pela subpasta de 1º nível. SEM IA.
// Arquivos na raiz -> "Não classificados". Sempre { ok:true, disciplinas }.
function labelFromPorPasta(signals) {
  const classificados = (signals || []).map((s) => {
    const nome = primeiroNivel(s.relPath);
    return { path: s.path, disciplina: nome || NOME_NAO_CLASSIFICADOS };
  });
  return { ok: true, disciplinas: consolidarDisciplinas(classificados) };
}

// ===========================================================================
// NÚCLEO — passo 2: tópicos
// ===========================================================================

// Monta o sinal de um path, usando signalsByPath quando existe ou um sinal
// DEGRADADO (snippet:'') derivado do próprio path quando ausente.
function sinalDeOuDegradado(path, signalsByPath, root) {
  const existente = signalsByPath && signalsByPath[path];
  if (existente) return existente;
  const relPath = relPathOf(path, root);
  return { path, name: basenameOf(relPath), relPath, snippet: '' };
}

// Para UMA disciplina, separa seus arquivos em tópicos. < 3 arquivos -> [].
// Falha de IA/JSON -> recuperável (disciplina fica sem tópicos / só os que deram
// certo). Retorna [{ id, nome, arquivos:[path] }].
async function splitIntoTopicos(disciplina, signalsByPath, { callGenerate, onProgress, root } = {}) {
  const arquivos = disciplina.arquivos || [];
  if (arquivos.length < 3) return [];

  const signals = arquivos.map((p) => sinalDeOuDegradado(p, signalsByPath, root));
  const lotes = chunkSignals(signals);
  const classificados = [];
  const conhecidas = [];

  for (const lote of lotes) {
    const prompt = buildBatchPrompt(lote, { disciplinasConhecidas: conhecidas });
    let res;
    try {
      res = await callGenerate(prompt);
    } catch {
      res = { ok: false, error: 'falha' };
    }
    let doLote;
    if (res && res.ok && typeof res.text === 'string') {
      doLote = parseBatchResponse(res.text, lote);
    } else {
      // Falha de IA no passo 2 é recuperável: os arquivos do lote ficam sem
      // tópico (rótulo "Não classificados" é descartado abaixo).
      doLote = lote.map((s) => ({ path: s.path, disciplina: NOME_NAO_CLASSIFICADOS }));
    }
    for (const c of doLote) {
      classificados.push(c);
      if (chaveNome(c.disciplina) !== chaveNome(NOME_NAO_CLASSIFICADOS)
        && !conhecidas.some((nn) => chaveNome(nn) === chaveNome(c.disciplina))) {
        conhecidas.push(c.disciplina);
      }
    }
  }

  // Tópicos consolidados; descarta o "balde" de não-rotulados (ficam soltos no
  // nível da disciplina, o que é válido pelo invariante 2).
  const consolidados = consolidarDisciplinas(classificados)
    .filter((d) => d.id !== ID_NAO_CLASSIFICADOS)
    .map((d) => ({ id: genId('top_'), nome: d.nome, arquivos: d.arquivos }));

  return consolidados;
}

// Roda o passo 2 para um conjunto de disciplinas. Emite progresso ANTES de cada
// disciplina iterada (inclusive as puladas por < 3 arquivos), garantindo
// current === total ao fim. Retorna NOVO mapping.
async function addTopicos(mapping, signalsByPath, { callGenerate, onProgress, alvo, root } = {}) {
  const todas = (mapping.disciplinas || []).filter((d) => d.id !== ID_NAO_CLASSIFICADOS);
  const iteradas = alvo
    ? todas.filter((d) => alvo.includes(d.id))
    : todas;
  const total = iteradas.length;

  const idsIterados = new Set(iteradas.map((d) => d.id));
  const novasDisciplinas = [];
  let current = 0;

  for (const d of mapping.disciplinas || []) {
    if (!idsIterados.has(d.id)) {
      novasDisciplinas.push(d);
      continue;
    }
    current += 1;
    if (onProgress) {
      onProgress({ phase: 'topicos', current, total, message: d.nome });
    }
    const topicos = await splitIntoTopicos(d, signalsByPath, { callGenerate, onProgress, root });
    novasDisciplinas.push(Object.assign({}, d, { topicos }));
  }

  const novo = Object.assign({}, mapping, { disciplinas: novasDisciplinas });
  return normalize(novo);
}

// ===========================================================================
// NÚCLEO — edições manuais (imutáveis; revalidam via normalize; tocam editedAt)
// ===========================================================================

function clonarDisciplinas(mapping) {
  return (mapping.disciplinas || []).map((d) => {
    const nd = { id: d.id, nome: d.nome, arquivos: (d.arquivos || []).slice() };
    if (Array.isArray(d.topicos)) {
      nd.topicos = d.topicos.map((t) => ({ id: t.id, nome: t.nome, arquivos: (t.arquivos || []).slice() }));
    }
    return nd;
  });
}

function comEdicao(mapping, disciplinas) {
  const novo = Object.assign({}, mapping, { disciplinas, editedAt: Date.now() });
  return normalize(novo);
}

function renameDisciplina(mapping, discId, novoNome) {
  const nome = String(novoNome == null ? '' : novoNome).trim();
  if (!nome) return { ok: false, error: 'Nome inválido' };
  const disciplinas = clonarDisciplinas(mapping);
  const d = disciplinas.find((x) => x.id === discId);
  if (!d) return { ok: false, error: 'Disciplina inexistente' };
  d.nome = nome.replace(/\s+/g, ' ');
  return { ok: true, mapping: comEdicao(mapping, disciplinas) };
}

function mergeDisciplinas(mapping, sourceId, targetId) {
  if (sourceId === targetId) {
    return { ok: false, error: 'Não é possível mesclar uma disciplina com ela mesma' };
  }
  const disciplinas = clonarDisciplinas(mapping);
  const source = disciplinas.find((x) => x.id === sourceId);
  const target = disciplinas.find((x) => x.id === targetId);
  if (!source || !target) return { ok: false, error: 'Disciplina inexistente' };

  // Concatena arquivos (dedup por path) e tópicos.
  for (const p of source.arquivos) {
    if (!target.arquivos.includes(p)) target.arquivos.push(p);
  }
  if (Array.isArray(source.topicos) && source.topicos.length) {
    target.topicos = (target.topicos || []).concat(source.topicos.map((t) => ({
      id: t.id, nome: t.nome, arquivos: (t.arquivos || []).slice(),
    })));
  }

  const restantes = disciplinas.filter((x) => x.id !== sourceId);
  return { ok: true, mapping: comEdicao(mapping, restantes) };
}

function moveArquivo(mapping, path, toDiscId) {
  const disciplinas = clonarDisciplinas(mapping);
  const origem = disciplinas.find((d) => (d.arquivos || []).includes(path));
  if (!origem) return { ok: false, error: 'Arquivo não encontrado no mapeamento' };
  const destino = disciplinas.find((d) => d.id === toDiscId);
  if (!destino) return { ok: false, error: 'Disciplina de destino inexistente' };
  if (origem.id === destino.id) {
    // no-op sem erro.
    return { ok: true, mapping: Object.assign({}, mapping) };
  }

  // Remove da origem (e do tópico de origem, se houver).
  origem.arquivos = origem.arquivos.filter((p) => p !== path);
  if (Array.isArray(origem.topicos)) {
    origem.topicos = origem.topicos.map((t) => Object.assign({}, t, {
      arquivos: (t.arquivos || []).filter((p) => p !== path),
    }));
  }
  // Adiciona ao destino, sem tópico.
  if (!destino.arquivos.includes(path)) destino.arquivos.push(path);

  return { ok: true, mapping: comEdicao(mapping, disciplinas) };
}

function createDisciplina(mapping, nome) {
  const limpo = String(nome == null ? '' : nome).trim();
  if (!limpo) return { ok: false, error: 'Nome inválido' };
  const disciplinas = clonarDisciplinas(mapping);
  const id = genId('disc_');
  disciplinas.push({ id, nome: limpo.replace(/\s+/g, ' '), arquivos: [] });
  return { ok: true, mapping: comEdicao(mapping, disciplinas), id };
}

// ===========================================================================
// NÚCLEO — incrementais
// ===========================================================================

// Compara o mapeamento salvo com o scan atual, por mtime/caminho.
// Retorna { novos:[file], removidos:[path], inalterados:[path] }.
function diffFiles(mapping, scannedFiles) {
  const sigs = (mapping && mapping.fileSignatures) || {};
  const novos = [];
  const inalterados = [];
  const vistos = new Set();

  for (const f of scannedFiles || []) {
    vistos.add(f.path);
    const assinado = sigs[f.path];
    if (assinado === undefined || assinado !== (f.mtime || 0)) {
      novos.push(f);
    } else {
      inalterados.push(f.path);
    }
  }

  const removidos = Object.keys(sigs).filter((p) => !vistos.has(p));
  return { novos, removidos, inalterados };
}

// Anexa arquivos novos já classificados ao mapeamento existente. Match por NOME
// ATUAL do mapping normalizado (não pelo rótulo canônico da IA). Preserva o id
// quando casa; cria disciplina nova quando não casa. "Não classificados" ->
// disc_nao_classificados. Retorna { mapping, discIdsAfetados }.
function appendClassified(mapping, classificados) {
  const disciplinas = clonarDisciplinas(mapping);
  const porChaveNome = new Map();
  for (const d of disciplinas) porChaveNome.set(chaveNome(d.nome), d);
  const afetados = new Set();

  for (const c of classificados || []) {
    const nomeBruto = c.disciplina || NOME_NAO_CLASSIFICADOS;
    const ehNaoClass = chaveNome(nomeBruto) === chaveNome(NOME_NAO_CLASSIFICADOS);

    let disc;
    if (ehNaoClass) {
      disc = disciplinas.find((d) => d.id === ID_NAO_CLASSIFICADOS);
      if (!disc) {
        disc = { id: ID_NAO_CLASSIFICADOS, nome: NOME_NAO_CLASSIFICADOS, arquivos: [] };
        disciplinas.push(disc);
      }
    } else {
      disc = porChaveNome.get(chaveNome(nomeBruto));
      if (!disc) {
        disc = { id: genId('disc_'), nome: nomeBruto.trim().replace(/\s+/g, ' '), arquivos: [] };
        disciplinas.push(disc);
        porChaveNome.set(chaveNome(disc.nome), disc);
      }
    }

    if (!disc.arquivos.includes(c.path)) disc.arquivos.push(c.path);
    afetados.add(disc.id);
  }

  const novo = normalize(Object.assign({}, mapping, { disciplinas }));
  return { mapping: novo, discIdsAfetados: Array.from(afetados) };
}

// Remove do mapeamento caminhos que sumiram do disco.
function pruneRemoved(mapping, removidos) {
  const set = new Set(removidos || []);
  const disciplinas = clonarDisciplinas(mapping).map((d) => {
    const nd = Object.assign({}, d, { arquivos: d.arquivos.filter((p) => !set.has(p)) });
    if (Array.isArray(d.topicos)) {
      nd.topicos = d.topicos.map((t) => Object.assign({}, t, {
        arquivos: (t.arquivos || []).filter((p) => !set.has(p)),
      }));
    }
    return nd;
  });

  const sigs = Object.assign({}, (mapping && mapping.fileSignatures) || {});
  for (const p of set) delete sigs[p];

  return normalize(Object.assign({}, mapping, { disciplinas, fileSignatures: sigs }));
}

// Atualiza fileSignatures a partir da lista de arquivos atual e seta
// generatedAt. É a ÚNICA função que seta generatedAt.
function refreshSignatures(mapping, scannedFiles) {
  const sigs = {};
  for (const f of scannedFiles || []) {
    sigs[f.path] = f.mtime || 0;
  }
  return Object.assign({}, mapping, { fileSignatures: sigs, generatedAt: Date.now() });
}

// Deriva um palpite de modo a partir do resultado de library.scan().
function suggestMode(scanResult) {
  const notebooks = (scanResult && scanResult.notebooks) || [];
  const materia = notebooks.filter((n) => n.name !== 'Geral');
  const geral = notebooks.find((n) => n.name === 'Geral');
  const nMateria = materia.length;
  const arqFora = materia.reduce((acc, n) => acc + ((n.files && n.files.length) || 0), 0);
  const arqGeral = geral ? ((geral.files && geral.files.length) || 0) : 0;

  if (nMateria >= 2 && arqFora > arqGeral) {
    return {
      sugerido: 'porPasta',
      motivo: 'Esta pasta parece organizada por matéria (várias subpastas com a maioria dos arquivos).',
    };
  }
  return {
    sugerido: 'porConteudo',
    motivo: 'A maioria dos arquivos está solta ou há poucas subpastas; vale deixar a IA agrupar por conteúdo.',
  };
}

// ===========================================================================
// Persistência (dependem de ./store) + storeKey (puro, só crypto)
// ===========================================================================

function storeKey(rootFolder) {
  const hash = crypto.createHash('sha1').update(String(rootFolder)).digest('hex').slice(0, 12);
  return `grouping::${hash}`;
}

function loadMapping(rootFolder) {
  return store.get(storeKey(rootFolder)) || null;
}

function saveMapping(mapping) {
  return store.set(storeKey(mapping.rootFolder), mapping);
}

function clearMapping(rootFolder) {
  // store.js não tem delete; gravar null equivale a "ainda não agrupado".
  return store.set(storeKey(rootFolder), null);
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
  // passo 1
  isOllamaOffline,
  classifyIntoDisciplinas,
  labelFromPorPasta,
  // passo 2
  splitIntoTopicos,
  addTopicos,
  // edições manuais
  renameDisciplina,
  mergeDisciplinas,
  moveArquivo,
  createDisciplina,
  // incrementais
  diffFiles,
  appendClassified,
  pruneRemoved,
  refreshSignatures,
  suggestMode,
  // normalize (invariantes)
  normalize,
  // persistência
  storeKey,
  loadMapping,
  saveMapping,
  clearMapping,
};
