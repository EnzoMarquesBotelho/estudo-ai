'use strict';

/**
 * Plano de estudos / Modo prova (Fase 3, Parte 2).
 *
 * Duas camadas no mesmo módulo (padrão grouping.js/rag.js/classification.js):
 *   - NÚCLEO PURO de priorização: `priorizarAssuntos` é aritmética pura sobre os
 *     argumentos recebidos. NÃO importa NADA (nem `crypto`, nem `./grouping-core`,
 *     nem `./store`/`fs`/rede). Determinístico e testável isolado. (INV3.)
 *   - ORQUESTRAÇÃO (`gerarPlano`): recebe `mapping`/`classState` e `ask` por
 *     parâmetro (injetados pelo main, que pode tocar `./store`/`fs`). Reusa a
 *     Fase 1 (grouping) e a Fase 2 (rag.ask) SEM duplicar lógica (RF15).
 */

// ===========================================================================
// Constantes de ponderação (ponto único de ajuste — D2/critério 24)
// ===========================================================================

const PESO_TIPO = { prova: 3.0, lista: 2.0, trabalho: 1.0, aula: 0.5, outro: 0.25 };
const RECENCIA_MIN = 1.0; // fator de recência mínimo
const RECENCIA_MAX = 1.2; // teto (recência nunca domina o peso por tipo)

// ===========================================================================
// NÚCLEO PURO — priorização "o que mais cai" (D2)
// ===========================================================================

// priorizarAssuntos({ assuntos, tiposPorPath }) -> [{
//   id, nome, escore, somaPesos, mtimeMaisRecente, fatorRecencia,
//   arquivos:[{ path, nome, tipo, peso, mtime }],
//   origemPriorizacao:[{ path, nome, tipo }]
// }]  ordenado por escore desc; empate -> mtimeMaisRecente desc (critério 25).
//
// assuntos: [{ id, nome, arquivos:[{ path, mtime }] }]  (montado pela orquestração)
// tiposPorPath: { path: 'prova'|... }  (de classification; ausente -> 'outro')
function priorizarAssuntos({ assuntos, tiposPorPath } = {}) {
  const tipos = tiposPorPath || {};
  const lista = Array.isArray(assuntos) ? assuntos : [];

  // Nome do arquivo a partir do path (por string, sem importar `path`).
  const nomeDe = (p) => {
    const partes = String(p).replace(/\\/g, '/').split('/');
    return partes[partes.length - 1];
  };

  // 1ª passada: janela global de mtime da disciplina inteira (todos os assuntos).
  let mtimeMinGlobal = Infinity;
  let mtimeMaxGlobal = -Infinity;
  for (const a of lista) {
    for (const arq of a.arquivos || []) {
      const m = Number(arq.mtime) || 0;
      if (m < mtimeMinGlobal) mtimeMinGlobal = m;
      if (m > mtimeMaxGlobal) mtimeMaxGlobal = m;
    }
  }
  if (!isFinite(mtimeMinGlobal)) mtimeMinGlobal = 0;
  if (!isFinite(mtimeMaxGlobal)) mtimeMaxGlobal = 0;
  const janela = mtimeMaxGlobal - mtimeMinGlobal;

  const resultado = lista.map((a) => {
    const arquivos = (a.arquivos || []).map((arq) => {
      const tipo = tipos[arq.path] || 'outro';
      const peso = typeof PESO_TIPO[tipo] === 'number' ? PESO_TIPO[tipo] : PESO_TIPO.outro;
      const mtime = Number(arq.mtime) || 0;
      return { path: arq.path, nome: nomeDe(arq.path), tipo, peso, mtime };
    });

    const somaPesos = arquivos.reduce((acc, x) => acc + x.peso, 0);
    const mtimeMaisRecente = arquivos.reduce((acc, x) => Math.max(acc, x.mtime), 0);

    // Normaliza a recência contra a janela da disciplina; sem divisão por zero.
    const norm = janela > 0 ? (mtimeMaisRecente - mtimeMinGlobal) / janela : 0;
    const fatorRecencia = RECENCIA_MIN + (RECENCIA_MAX - RECENCIA_MIN) * norm;

    const escore = somaPesos * fatorRecencia;

    // Origem da priorização: arquivos de MAIOR peso (p/ citação, RF16/critério 26).
    let pesoMax = 0;
    for (const x of arquivos) if (x.peso > pesoMax) pesoMax = x.peso;
    const origemPriorizacao = arquivos
      .filter((x) => x.peso === pesoMax && pesoMax > 0)
      .map((x) => ({ path: x.path, nome: x.nome, tipo: x.tipo }));

    return {
      id: a.id,
      nome: a.nome,
      escore,
      somaPesos,
      mtimeMaisRecente,
      fatorRecencia,
      arquivos,
      origemPriorizacao,
    };
  });

  resultado.sort((x, y) => {
    if (y.escore !== x.escore) return y.escore - x.escore;
    return y.mtimeMaisRecente - x.mtimeMaisRecente; // desempate por recência
  });

  return resultado;
}

// ===========================================================================
// ORQUESTRAÇÃO — gerarPlano (reusa grouping + classification + rag.ask)
// ===========================================================================

// Quantos assuntos de topo recebem resumo prático fundamentado por RAG.
const TOP_N_PADRAO = 3;

// Deriva os assuntos de uma disciplina: um por tópico quando houver; senão a
// própria disciplina como assunto único. Monta { path, mtime } por join com as
// assinaturas da classificação (float). Path sem assinatura -> mtime 0.
function derivarAssuntos(disc, fileSignatures) {
  const sigs = fileSignatures || {};
  const comMtime = (paths) => (paths || []).map((p) => ({ path: p, mtime: sigs[p] != null ? sigs[p] : 0 }));

  const topicos = Array.isArray(disc.topicos) ? disc.topicos : [];
  if (topicos.length) {
    // Arquivos já em tópicos; os soltos da disciplina viram um assunto "Geral".
    const emTopico = new Set();
    for (const t of topicos) for (const p of t.arquivos || []) emTopico.add(p);
    const assuntos = topicos.map((t) => ({ id: t.id, nome: t.nome, arquivos: comMtime(t.arquivos) }));
    const soltos = (disc.arquivos || []).filter((p) => !emTopico.has(p));
    if (soltos.length) {
      assuntos.push({ id: disc.id + '::geral', nome: 'Geral', arquivos: comMtime(soltos) });
    }
    return assuntos;
  }
  // Sem tópicos: a disciplina inteira é um único assunto.
  return [{ id: disc.id, nome: disc.nome, arquivos: comMtime(disc.arquivos) }];
}

// Formata a citação de origem da priorização (sem tabelas nem links — critério 27).
function citacaoOrigem(origemPriorizacao) {
  if (!origemPriorizacao || !origemPriorizacao.length) return '';
  const o = origemPriorizacao[0];
  const extra = origemPriorizacao.length > 1 ? ` (e mais ${origemPriorizacao.length - 1})` : '';
  return `priorizado por aparecer em **${o.nome}** (${o.tipo})${extra}`;
}

// gerarPlano({ rootFolder, discId, mapping, classState, ask, embed, generate, onProgress, topN })
//   -> { ok:true, markdown, assuntos, fontes } | { ok:false, error }
async function gerarPlano({
  rootFolder,
  discId,
  mapping,
  classState,
  ask,
  embed,
  generate,
  onProgress,
  topN = TOP_N_PADRAO,
} = {}) {
  // Dependência explícita da Parte 1 (RF18/critério 30).
  if (!classState) return { ok: false, error: 'SEM_CLASSIFICACAO' };
  if (!mapping) return { ok: false, error: 'SEM_MAPEAMENTO' };

  const disciplinas = (mapping.disciplinas || []);
  const disc = disciplinas.find((d) => d.id === discId) || disciplinas[0];
  if (!disc) return { ok: false, error: 'SEM_MAPEAMENTO' };

  // tiposPorPath e mtime vêm da classificação (fileSignatures é path -> mtime float).
  const arquivosClass = classState.arquivos || {};
  const tiposPorPath = {};
  for (const p of Object.keys(arquivosClass)) {
    tiposPorPath[p] = (arquivosClass[p] && arquivosClass[p].tipo) || 'outro';
  }

  const assuntosBrutos = derivarAssuntos(disc, classState.fileSignatures);
  const priorizados = priorizarAssuntos({ assuntos: assuntosBrutos, tiposPorPath });

  // Fundamenta os top-N assuntos via RAG; agrega fontes (dedup por path).
  const fontes = [];
  const vistos = new Set();
  const total = Math.min(topN, priorizados.length);
  const corpoPorAssunto = {};

  for (let i = 0; i < total; i++) {
    const assunto = priorizados[i];
    if (onProgress) {
      onProgress({ phase: 'plano', current: i + 1, total, message: assunto.nome });
    }
    const scopePaths = (assunto.arquivos || []).map((x) => x.path);
    let r;
    try {
      r = await ask({ rootFolder, pergunta: `O que estudar sobre: ${assunto.nome}`, scopePaths });
    } catch (e) {
      r = { ok: false, error: (e && e.message) || 'falha' };
    }

    if (r && r.ok) {
      corpoPorAssunto[assunto.id] = String(r.resposta || '').trim();
      for (const f of r.fontes || []) {
        if (!vistos.has(f.path)) {
          vistos.add(f.path);
          fontes.push({ path: f.path, trechoCurto: f.trechoCurto });
        }
      }
    } else if (r && r.error === 'SEM_INDICE') {
      corpoPorAssunto[assunto.id] = '_Material não indexado para fundamentar este assunto. Indexe a pasta (aba Perguntar) para um resumo mais completo._';
    } else {
      corpoPorAssunto[assunto.id] = '_Não foi possível fundamentar este assunto agora._';
    }
  }

  const markdown = montarMarkdown(disc.nome, priorizados, corpoPorAssunto, total);
  return { ok: true, markdown, assuntos: priorizados, fontes };
}

// Monta o Markdown do plano (SEM tabelas nem links — compatível com renderMarkdown).
function montarMarkdown(nomeDisc, priorizados, corpoPorAssunto, total) {
  const linhas = [];
  linhas.push(`# Plano de estudos — ${nomeDisc}`);
  linhas.push('');
  linhas.push('## Ordem de prioridade');
  linhas.push('');
  if (!priorizados.length) {
    linhas.push('Nenhum assunto encontrado para esta disciplina.');
    return linhas.join('\n');
  }
  priorizados.forEach((a, i) => {
    const cit = citacaoOrigem(a.origemPriorizacao);
    const motivo = cit ? ` — ${cit}` : '';
    linhas.push(`${i + 1}. **${a.nome}**${motivo}`);
  });
  linhas.push('');

  linhas.push('## O que estudar primeiro');
  linhas.push('');
  for (let i = 0; i < total; i++) {
    const a = priorizados[i];
    linhas.push(`### ${a.nome}`);
    const cit = citacaoOrigem(a.origemPriorizacao);
    if (cit) linhas.push(`_${cit}._`);
    linhas.push('');
    linhas.push(corpoPorAssunto[a.id] || '_Sem conteúdo._');
    linhas.push('');
  }

  return linhas.join('\n');
}

module.exports = {
  // constantes
  PESO_TIPO,
  RECENCIA_MIN,
  RECENCIA_MAX,
  TOP_N_PADRAO,
  // núcleo puro
  priorizarAssuntos,
  // orquestração
  derivarAssuntos,
  gerarPlano,
};
