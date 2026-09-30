'use strict';

/**
 * Integração com o Ollama LOCAL (http://localhost:11434).
 * Tudo roda na máquina do usuário — nenhuma informação vai para a nuvem.
 *
 * Endpoints usados:
 *   GET  /api/tags       -> lista modelos instalados (checar disponibilidade)
 *   POST /api/generate   -> gera texto (usamos stream:false p/ resposta única)
 *
 * Se o Ollama não estiver rodando/instalado, retornamos um erro amigável
 * que a interface mostra com instruções.
 */

const store = require('./store');

const OLLAMA_URL = 'http://127.0.0.1:11434';
// Modelo padrão. Pode ser trocado pela UI. llama3.1 é um bom equilíbrio.
// Modelo padrão: qwen2.5:7b — cabe na VRAM de GPUs de 6GB (ex.: GTX 1660),
// roda rápido e estável, e é ótimo em português. Modelos 14B costumam travar
// em placas de 6GB na geração de respostas longas.
const DEFAULT_MODEL = 'qwen2.5:7b';

// Limite de caracteres do material enviado por chamada.
// Mantido conservador para o prompt + resposta caberem no contexto do modelo
// sem estourar memória (o que causava erro 500, sobretudo em modelos grandes).
const MAX_CHARS = 8000;

// Janela de contexto: calculada por chamada a partir do tamanho do prompt e da
// resposta esperada, com piso e teto. Antes era fixa (6144) e a etapa final do
// resumo DETALHADO (prompt grande + saída de 2048 tokens) estourava esse limite,
// fazendo o modelo travar no meio ("fetch failed").
const NUM_CTX_MIN = 4096;
const NUM_CTX_MAX = 8192;

// Estima grosseiramente tokens a partir de caracteres (~4 chars/token em PT).
function estimarTokens(chars) {
  return Math.ceil(chars / 4);
}

// Escolhe um num_ctx que caiba prompt + resposta, com folga, dentro dos limites.
function calcNumCtx(promptChars, numPredict) {
  const necessario = estimarTokens(promptChars) + (numPredict || 512) + 512; // +folga
  return Math.min(NUM_CTX_MAX, Math.max(NUM_CTX_MIN, necessario));
}

async function checkStatus() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { method: 'GET' });
    if (!res.ok) return { ok: false, reason: 'erro', models: [] };
    const data = await res.json();
    const models = (data.models || []).map((m) => m.name);
    return { ok: true, models, hasDefault: models.some((m) => m.startsWith(DEFAULT_MODEL)) };
  } catch {
    return { ok: false, reason: 'offline', models: [] };
  }
}

// Chamada base ao Ollama. Retorna { ok, text } ou { ok:false, error }.
// numPredict controla quantos tokens a IA pode gerar (evita cortar cedo).
async function generate(prompt, { model, json = false, temperature = 0.3, numPredict, signal } = {}) {
  const status = await checkStatus();
  if (!status.ok) {
    return {
      ok: false,
      error:
        'Ollama não está rodando. Instale em https://ollama.com, abra o app e baixe um modelo (ex.: "ollama pull llama3.1").',
    };
  }
  const chosen = model || (status.hasDefault ? DEFAULT_MODEL : status.models[0]);
  if (!chosen) {
    return {
      ok: false,
      error: 'Nenhum modelo instalado no Ollama. Rode no terminal: ollama pull llama3.1',
    };
  }

  const saida = numPredict ? Math.min(numPredict, 2048) : 512;
  const options = {
    temperature,
    num_predict: saida,
    // Contexto dimensionado para caber este prompt + a resposta esperada.
    num_ctx: calcNumCtx(prompt.length, saida),
  };

  const payload = JSON.stringify({
    model: chosen,
    prompt,
    stream: false,
    format: json ? 'json' : undefined,
    options,
  });

  // Tenta a chamada até 3 vezes. Modelos grandes podem demorar muito ou
  // derrubar a conexão (fetch failed) se o servidor ficar sem memória; entre
  // tentativas esperamos um pouco para o Ollama se recuperar.
  const MAX_TENTATIVAS = 3;
  let ultimoErro = '';
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    // Se quem chamou já cancelou (ex.: timeout do teste), para tudo.
    if (signal && signal.aborted) return { ok: false, error: 'cancelado' };
    // Timeout generoso: 8 minutos por chamada (modelo grande + PC modesto).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8 * 60 * 1000);
    // Encadeia o cancelamento externo ao controller interno.
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);

      if (!res.ok) {
        let detalhe = '';
        try {
          const body = await res.json();
          detalhe = body.error || '';
        } catch {
          try { detalhe = await res.text(); } catch {}
        }
        return { ok: false, error: traduzErro(res.status, detalhe) };
      }
      const data = await res.json();
      return { ok: true, text: (data.response || '').trim(), model: chosen };
    } catch (e) {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      // Cancelamento externo (ex.: timeout do teste): não insiste.
      if (signal && signal.aborted) return { ok: false, error: 'cancelado' };
      ultimoErro = e && e.name === 'AbortError'
        ? 'tempo esgotado (o modelo demorou demais)'
        : (e && e.message) || 'falha de conexão';

      // Se ainda há tentativas, verifica se o servidor voltou e espera.
      if (tentativa < MAX_TENTATIVAS) {
        await new Promise((r) => setTimeout(r, 3000));
        // Tenta reerguer o servidor caso tenha caído.
        if (!(await checkStatus()).ok) {
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    }
  }

  return { ok: false, error: traduzFetch(ultimoErro) };
}

// Mensagem clara para falhas de conexão com o Ollama.
function traduzFetch(motivo) {
  return `Não consegui falar com a IA (${motivo}). Isso costuma acontecer quando o modelo é pesado demais para o PC e o Ollama trava ou fica sem memória. Tente um modelo menor (gemma2:9b, qwen2.5:7b ou llama3.2:3b), ou gere de um arquivo por vez. Verifique também se o Ollama continua aberto.`;
}

// Versão em STREAMING: os tokens chegam aos poucos e são repassados por onToken,
// permitindo mostrar o texto surgindo em tempo real na interface. Também detecta
// travamento: se nenhum token novo chega por muito tempo, aborta com aviso.
async function generateStream(prompt, { model, temperature = 0.3, numPredict } = {}, onToken) {
  const status = await checkStatus();
  if (!status.ok) {
    return { ok: false, error: 'Ollama não está rodando. Abra o Ollama e tente de novo.' };
  }
  const chosen = model || (status.hasDefault ? DEFAULT_MODEL : status.models[0]);
  if (!chosen) return { ok: false, error: 'Nenhum modelo instalado no Ollama.' };

  const saida = numPredict ? Math.min(numPredict, 2048) : 512;
  const options = {
    temperature,
    num_predict: saida,
    num_ctx: calcNumCtx(prompt.length, saida),
  };
  const payload = JSON.stringify({ model: chosen, prompt, stream: true, options });

  // "Watchdog": se ficar SEM_TOKEN_MS sem receber nenhum token, considera travado.
  const SEM_TOKEN_MS = 90 * 1000;
  const controller = new AbortController();
  let watchdog;
  const armarWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => controller.abort(), SEM_TOKEN_MS);
  };

  try {
    armarWatchdog();
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      clearTimeout(watchdog);
      let detalhe = '';
      try { detalhe = (await res.json()).error || ''; } catch {}
      return { ok: false, error: traduzErro(res.status, detalhe) };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let texto = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const linhas = buffer.split('\n');
      buffer = linhas.pop() || '';
      for (const linha of linhas) {
        if (!linha.trim()) continue;
        try {
          const obj = JSON.parse(linha);
          if (obj.response) {
            texto += obj.response;
            armarWatchdog(); // recebeu token: reinicia o watchdog
            onToken && onToken(texto);
          }
          if (obj.error) throw new Error(obj.error);
        } catch (e) {
          if (e.message && !e.message.includes('JSON')) throw e;
        }
      }
    }
    clearTimeout(watchdog);
    return { ok: true, text: texto.trim(), model: chosen };
  } catch (e) {
    clearTimeout(watchdog);
    if (e && e.name === 'AbortError') {
      return { ok: false, error: `A IA parou de responder (o modelo travou). Isso acontece com modelos grandes demais para a sua GPU. Troque para um modelo menor (recomendado: qwen2.5:7b ou gemma2:9b).` };
    }
    return { ok: false, error: traduzFetch((e && e.message) || 'falha de conexão') };
  }
}

// Converte erros do Ollama em mensagens úteis em português.
function traduzErro(status, detalhe) {
  const d = (detalhe || '').toLowerCase();
  if (d.includes('memory') || d.includes('out of memory') || d.includes('vram') || d.includes('ram')) {
    return 'O modelo não coube na memória do seu PC. Tente um modelo menor (ex.: gemma2:9b, qwen2.5:7b ou llama3.2:3b) ou gere de um arquivo só em vez da pasta inteira.';
  }
  if (d.includes('context') || d.includes('too large') || d.includes('exceed')) {
    return 'O conteúdo é grande demais para o modelo. Gere de um arquivo específico, ou de menos arquivos por vez.';
  }
  if (status === 500) {
    return 'O modelo falhou (erro 500). Causa provável: memória insuficiente para este modelo ou conteúdo grande demais. Tente um modelo menor ou resuma um arquivo por vez.' + (detalhe ? ` Detalhe: ${detalhe}` : '');
  }
  return `Ollama respondeu ${status}${detalhe ? ': ' + detalhe : ''}`;
}

function clamp(text) {
  if (!text) return '';
  return text.length > MAX_CHARS
    ? text.slice(0, MAX_CHARS) + '\n\n[...conteúdo truncado para caber no modelo...]'
    : text;
}

// --------------------------- Resumo ---------------------------
// Cada nível tem instruções e "orçamento" de tokens próprios, para que
// "detalhado" seja realmente mais profundo — e não só bullets curtos.
const NIVEL_RESUMO = {
  curto: {
    instrucao:
      'Faça um resumo ENXUTO: uma visão geral em 2-3 frases e no máximo 4 pontos principais bem objetivos. Vá direto ao essencial.',
    numPredict: 500,
    temp: 0.3,
  },
  'médio': {
    instrucao:
      'Faça um resumo EQUILIBRADO: visão geral em 3-4 frases e 5 a 7 pontos principais, cada um com uma frase de explicação.',
    numPredict: 900,
    temp: 0.35,
  },
  detalhado: {
    instrucao:
      `Faça um resumo DETALHADO e APROFUNDADO, como material de estudo para prova. Exigências:
- Visão geral em um parágrafo (4-6 frases) contextualizando o tema.
- Uma seção "## Conceitos" onde CADA conceito importante vira "### Nome do conceito" seguido de 2 a 4 frases explicando o que é, COMO funciona e QUANDO/POR QUE se usa. Quando fizer sentido, dê um exemplo concreto ou a fórmula.
- Inclua fórmulas, passos e exemplos que estejam no material, e explique cada um.
- Uma seção "## Relações" mostrando como os conceitos se conectam e se diferenciam.
- Uma seção "## Conclusão" com no MÁXIMO 3 frases que apontem o que é mais importante lembrar e uma dica de aplicação. PROIBIDO repetir frases já ditas na visão geral — traga uma síntese nova, com outras palavras.
Escreva parágrafos de verdade, não só listas soltas. Prefira explicar demais a explicar de menos.`,
    numPredict: 2600,
    temp: 0.45,
  },
};

async function generateSummary(text, options = {}) {
  const nivelKey = (options.nivel || 'médio');
  const cfg = NIVEL_RESUMO[nivelKey] || NIVEL_RESUMO['médio'];
  const prompt = `Você é um professor experiente resumindo material de estudo em português do Brasil.

${cfg.instrucao}

Formato em Markdown, começando com "# Resumo".
Use apenas informação presente no material — não invente fatos, datas ou fórmulas.
Escreva de forma clara e didática, como se explicasse para um aluno.

MATERIAL:
"""
${clamp(text)}
"""`;
  // onToken (se fornecido) faz o resumo aparecer em tempo real na interface.
  if (options.onToken) {
    return generateStream(prompt, { model: options.model, temperature: cfg.temp, numPredict: cfg.numPredict, signal: options.signal }, options.onToken);
  }
  return generate(prompt, { model: options.model, temperature: cfg.temp, numPredict: cfg.numPredict, signal: options.signal });
}

// ------------------------- Mapa mental -------------------------
// Pedimos JSON estruturado para desenhar o grafo na interface.
async function generateMindmap(text, options = {}) {
  const prompt = `Você é um professor criando um MAPA MENTAL de estudo em português do Brasil.
Um bom mapa mental NÃO é só uma lista de palavras soltas: cada item precisa EXPLICAR a ideia em poucas palavras.

Responda APENAS com JSON válido, sem texto antes ou depois, exatamente neste formato:
{
  "central": "Tema central do material",
  "nodes": [
    {
      "title": "Ramo principal (um conceito grande)",
      "children": [
        { "titulo": "Subtópico", "descricao": "Explicação curta em 1 frase do que é / como funciona." }
      ]
    }
  ]
}

Regras importantes:
- 3 a 6 ramos principais, cobrindo os grandes temas do material.
- Cada ramo com 2 a 4 subtópicos.
- Cada subtópico DEVE ter "descricao": uma frase objetiva explicando a ideia (não deixe vazio, não repita o título).
- Use SOMENTE informação do material. Não invente.

MATERIAL:
"""
${clamp(text)}
"""`;
  const res = await generate(prompt, { model: options.model, json: true, temperature: 0.3, numPredict: 2000, signal: options.signal });
  if (!res.ok) return res;
  try {
    const parsed = JSON.parse(res.text);
    if (!parsed.central || !Array.isArray(parsed.nodes)) throw new Error('formato inválido');
    // Normaliza os filhos: aceita tanto string quanto {titulo, descricao}.
    parsed.nodes = parsed.nodes.map((n) => ({
      title: n.title || n.titulo || 'Tópico',
      children: (n.children || []).map((c) => {
        if (typeof c === 'string') return { titulo: c, descricao: '' };
        return { titulo: c.titulo || c.title || '', descricao: c.descricao || c.description || '' };
      }),
    }));
    return { ok: true, map: parsed, model: res.model };
  } catch (e) {
    return { ok: false, error: 'A IA não devolveu um mapa válido. Tente novamente. (' + e.message + ')' };
  }
}

// ---------------------- Lista de exercícios ----------------------
async function generateExercises(text, options = {}) {
  const qtd = options.quantidade || 5;
  const tipo = options.tipo || 'mistas'; // multipla | dissertativa | mistas
  // Orçamento de tokens proporcional à quantidade — evita cortar a lista no
  // meio (era o bug de pedir 10 e receber 6). ~230 tokens por questão + gabarito.
  const numPredict = Math.min(3500, 400 + qtd * 230);

  const prompt = `Você é um professor. Com base no material abaixo, crie uma LISTA DE EXERCÍCIOS em português do Brasil.

REGRAS OBRIGATÓRIAS:
- Gere EXATAMENTE ${qtd} questões, numeradas de 1 a ${qtd}. Não gere a menos nem a mais.
- Tipo das questões: ${tipo}.
- Coloque TODO o gabarito JUNTO, em UMA única seção "## Gabarito" no FINAL, depois de todas as questões. Nunca intercale respostas entre as questões.
- Se uma questão precisar de figura (circuito, gráfico, diagrama), inclua um diagrama em bloco Mermaid, assim:
  \`\`\`mermaid
  graph LR
    A[Fonte 12V] --> B[R1 10Ω] --> C[R2 20Ω]
  \`\`\`
  Use Mermaid só quando a figura ajudar de verdade; caso contrário, não use.
- Baseie-se somente no material. Não invente fatos.

FORMATO (Markdown):
# Lista de Exercícios
1. Enunciado...
   a) ... b) ... c) ... d)   (apenas se múltipla escolha)
2. ...
(( ... até a questão ${qtd} ... ))

## Gabarito
1. Resposta + justificativa curta.
2. ...
(( ... até ${qtd} ... ))

MATERIAL:
"""
${clamp(text)}
"""`;
  if (options.onToken) {
    return generateStream(prompt, { model: options.model, temperature: 0.4, numPredict, signal: options.signal }, options.onToken);
  }
  return generate(prompt, { model: options.model, temperature: 0.4, numPredict, signal: options.signal });
}

// ==========================================================================
// MAP-REDUCE para a PASTA INTEIRA
// Em vez de mandar todo o conteúdo de uma vez (o que estoura o modelo e só
// usa o início), resumimos CADA arquivo separadamente ("map") e depois
// combinamos esses resumos parciais numa síntese final ("reduce").
// Assim todo o material é realmente considerado.
// ==========================================================================

// Limite menor por arquivo: cada um vira um resumo parcial compacto.
const MAX_CHARS_POR_ARQUIVO = 6000;

function clampTo(text, max) {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '\n[...]' : text;
}

// "map": gera um resumo parcial e objetivo de um único arquivo.
async function summarizeOne(name, text, model, signal) {
  const prompt = `Resuma o material a seguir em português do Brasil, de forma OBJETIVA, listando os conceitos e pontos mais importantes em tópicos. Não invente nada. Máximo ~10 tópicos.

ARQUIVO: ${name}
CONTEÚDO:
"""
${clampTo(text, MAX_CHARS_POR_ARQUIVO)}
"""

Resumo em tópicos:`;
  const res = await generate(prompt, { model, temperature: 0.3, numPredict: 600, signal });
  if (!res.ok) return { ok: false, name, error: res.error };
  return { ok: true, name, text: res.text };
}

// Chave de cache de um resumo parcial. Inclui caminho, data de modificação,
// tamanho e modelo — assim, se o arquivo mudar OU o modelo mudar, o cache
// é automaticamente invalidado e o arquivo é reprocessado.
function chaveParcial(f, model) {
  const path = f.path || f.name;
  const mtime = f.mtime || 0;
  const size = f.size || (f.text ? f.text.length : 0);
  return `partial::${model || DEFAULT_MODEL}::${path}::${mtime}::${size}`;
}

// Processa todos os arquivos, emitindo progresso. Retorna os resumos parciais.
// Reaproveita do cache local os arquivos já resumidos (com o mesmo modelo e
// que não mudaram), tornando as gerações seguintes bem mais rápidas.
async function mapFiles(files, model, onProgress, signal) {
  const parciais = [];
  for (let i = 0; i < files.length; i++) {
    if (signal && signal.aborted) break; // cancelado (ex.: timeout do teste)
    const f = files[i];
    const chave = chaveParcial(f, model);
    const cacheado = store.getCache(chave);

    if (cacheado && cacheado.text) {
      // Já foi lido antes: reaproveita instantaneamente.
      onProgress && onProgress({ current: i + 1, total: files.length, name: f.name, cached: true });
      parciais.push(`### ${f.name}\n${cacheado.text}`);
      continue;
    }

    // Precisa ler de verdade (primeira vez ou arquivo alterado).
    onProgress && onProgress({ current: i + 1, total: files.length, name: f.name, cached: false });
    const r = await summarizeOne(f.name, f.text, model, signal);
    if (r.ok && r.text) {
      store.setCache(chave, { text: r.text });
      parciais.push(`### ${f.name}\n${r.text}`);
    }
    // Se um arquivo falhar (ex.: memória), seguimos com os demais.
  }
  return parciais;
}

// Junta os resumos parciais num único texto "condensado" para a etapa final.
function condensar(parciais) {
  return parciais.join('\n\n');
}

// ---- Versões de PASTA (map-reduce) ----

async function generateSummaryFolder(files, options = {}, onProgress) {
  if (!files || !files.length) return { ok: false, error: 'A pasta não tem arquivos legíveis.' };
  const parciais = await mapFiles(files, options.model, onProgress, options.signal);
  if (options.signal && options.signal.aborted) return { ok: false, error: 'cancelado' };
  if (!parciais.length) return { ok: false, error: 'Não consegui resumir nenhum arquivo (verifique memória/modelo).' };

  onProgress && onProgress({ phase: 'reduce', message: 'Combinando os resumos…' });
  // "reduce": síntese final a partir dos resumos parciais.
  const condensado = condensar(parciais);
  const res = await generateSummary(condensado, options);
  return res;
}

async function generateMindmapFolder(files, options = {}, onProgress) {
  if (!files || !files.length) return { ok: false, error: 'A pasta não tem arquivos legíveis.' };
  const parciais = await mapFiles(files, options.model, onProgress, options.signal);
  if (options.signal && options.signal.aborted) return { ok: false, error: 'cancelado' };
  if (!parciais.length) return { ok: false, error: 'Não consegui processar os arquivos.' };
  onProgress && onProgress({ phase: 'reduce', message: 'Montando o mapa geral…' });
  return generateMindmap(condensar(parciais), options);
}

async function generateExercisesFolder(files, options = {}, onProgress) {
  if (!files || !files.length) return { ok: false, error: 'A pasta não tem arquivos legíveis.' };
  const parciais = await mapFiles(files, options.model, onProgress, options.signal);
  if (options.signal && options.signal.aborted) return { ok: false, error: 'cancelado' };
  if (!parciais.length) return { ok: false, error: 'Não consegui processar os arquivos.' };
  onProgress && onProgress({ phase: 'reduce', message: 'Criando os exercícios…' });
  return generateExercises(condensar(parciais), options);
}

module.exports = {
  checkStatus,
  generateSummary,
  generateMindmap,
  generateExercises,
  generateSummaryFolder,
  generateMindmapFolder,
  generateExercisesFolder,
  DEFAULT_MODEL,
};
