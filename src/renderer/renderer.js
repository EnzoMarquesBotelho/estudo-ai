'use strict';

// Estado da aplicação (só na interface).
const state = {
  root: null,
  notebooks: [],
  selectedFile: null,   // { name, path }
  scope: 'file',        // 'file' | 'all'
  lastResults: {},      // cache em memória: summary/mindmap/exercises
  model: null,          // modelo de IA escolhido pelo usuário
  idioma: 'auto',       // idioma do resultado ('auto' = igual ao material)
  grouping: null,       // mapeamento de disciplinas carregado (ou null)
  groupingView: 'pastas', // 'pastas' | 'disciplinas'
  scopeTarget: null,    // { kind:'disciplina', id } | { kind:'topico', discId, id }
  groupNovos: [],       // arquivos novos detectados (incremental)
  groupRemovidos: [],   // paths removidos detectados (incremental)
};

// ------------------------------ Helpers ------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.className = 'toast'), 3500);
}

function spinner(container, label = 'Gerando…') {
  container.innerHTML = `<div class="spinner"></div><div class="placeholder">${label}<br><small>Isso pode levar alguns segundos com a IA local.</small></div>`;
}

function placeholder(container, msg) {
  container.innerHTML = `<div class="placeholder">${msg}</div>`;
}

function escapeHtml(s) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Mini renderizador de Markdown (headers, listas, negrito, código + Mermaid).
// Blocos ```mermaid viram diagramas; outros blocos ``` viram <pre>.
let __mmSeq = 0;
function renderMarkdown(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const linhas = (md || '').split('\n');
  let html = '', inUl = false, inOl = false;
  let emBloco = false, blocoLang = '', blocoConteudo = [];
  const closeLists = () => {
    if (inUl) { html += '</ul>'; inUl = false; }
    if (inOl) { html += '</ol>'; inOl = false; }
  };

  for (let raw of linhas) {
    const fence = raw.match(/^```\s*(\w+)?/);
    if (fence) {
      if (!emBloco) { emBloco = true; blocoLang = (fence[1] || '').toLowerCase(); blocoConteudo = []; closeLists(); }
      else {
        // Fecha o bloco.
        const conteudo = blocoConteudo.join('\n');
        if (blocoLang === 'mermaid') {
          // Marcado para o mermaid renderizar depois (guardamos o código cru).
          const id = 'mm-diagram-' + (__mmSeq++);
          html += `<div class="mermaid-diagram" data-id="${id}"><pre class="mermaid">${esc(conteudo)}</pre></div>`;
        } else {
          html += `<pre class="code-block">${esc(conteudo)}</pre>`;
        }
        emBloco = false; blocoLang = ''; blocoConteudo = [];
      }
      continue;
    }
    if (emBloco) { blocoConteudo.push(raw); continue; }

    let line = esc(raw);
    line = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
               .replace(/`([^`]+)`/g, '<code>$1</code>');
    if (/^### /.test(line)) { closeLists(); html += `<h3>${line.slice(4)}</h3>`; }
    else if (/^## /.test(line)) { closeLists(); html += `<h2>${line.slice(3)}</h2>`; }
    else if (/^# /.test(line)) { closeLists(); html += `<h1>${line.slice(2)}</h1>`; }
    else if (/^\s*[-*] /.test(line)) {
      if (!inUl) { closeLists(); html += '<ul>'; inUl = true; }
      html += `<li>${line.replace(/^\s*[-*] /, '')}</li>`;
    } else if (/^\s*\d+\. /.test(line)) {
      if (!inOl) { closeLists(); html += '<ol>'; inOl = true; }
      html += `<li>${line.replace(/^\s*\d+\. /, '')}</li>`;
    } else if (line.trim() === '') { closeLists(); }
    else { closeLists(); html += `<p>${line}</p>`; }
  }
  // Bloco não fechado (resposta cortada): mostra o que veio.
  if (emBloco && blocoConteudo.length) {
    html += `<pre class="code-block">${esc(blocoConteudo.join('\n'))}</pre>`;
  }
  closeLists();
  return html;
}

// Renderiza os diagramas Mermaid presentes em um container (depois do innerHTML).
function renderizarMermaid(container) {
  if (typeof window.mermaid === 'undefined') return; // lib ausente: fica o texto
  try {
    if (!renderizarMermaid._init) {
      window.mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
      renderizarMermaid._init = true;
    }
    const blocos = container.querySelectorAll('pre.mermaid');
    blocos.forEach(async (pre, i) => {
      const code = pre.textContent;
      try {
        const { svg } = await window.mermaid.render('mmr-' + Date.now() + '-' + i, code);
        const wrap = document.createElement('div');
        wrap.className = 'mermaid-rendered';
        wrap.innerHTML = svg;
        pre.replaceWith(wrap);
      } catch {
        // Se o diagrama for inválido, mantém o texto do código (não quebra a tela).
      }
    });
  } catch {}
}

// ------------------------------ Biblioteca ------------------------------
async function loadLibrary(folder) {
  const lib = await window.api.scanLibrary(folder);
  state.root = lib.root || folder;
  state.notebooks = lib.notebooks || [];
  if (state.root) {
    $('#folderPath').textContent = state.root;
    $('#folderPath').title = state.root;
    window.api.startWatch(state.root);
  }
  await loadGrouping(state.root);
  renderSidebar();
}

function renderNotebooks() {
  const wrap = $('#notebooks');
  wrap.innerHTML = '';
  if (!state.notebooks.length) {
    placeholder(wrap, 'Nenhum arquivo de texto encontrado nesta pasta.');
    return;
  }
  for (const nb of state.notebooks) {
    const el = document.createElement('div');
    el.className = 'notebook open';
    const files = nb.files.map((f) =>
      `<div class="file-item" data-path="${encodeURIComponent(f.path)}" data-name="${encodeURIComponent(f.name)}" title="${f.name}">${f.name}</div>`
    ).join('');
    el.innerHTML = `
      <div class="notebook-header">
        <span title="${escapeHtml(nb.name)}">📓 ${escapeHtml(nb.name)}</span>
        <span class="count">${nb.files.length}</span>
      </div>
      <div class="notebook-files">${files}</div>`;
    el.querySelector('.notebook-header').addEventListener('click', () => el.classList.toggle('open'));
    wrap.appendChild(el);
  }

  $$('.file-item').forEach((item) => {
    item.addEventListener('click', () => {
      $$('.file-item').forEach((i) => i.classList.remove('active'));
      item.classList.add('active');
      state.scopeTarget = null;
      state.selectedFile = {
        path: decodeURIComponent(item.dataset.path),
        name: decodeURIComponent(item.dataset.name),
      };
      updateTitle();
    });
  });
}

function updateTitle() {
  const t = $('#currentTitle');
  if (state.scopeTarget) {
    const alvo = resolveScopeTarget();
    if (alvo) {
      t.textContent = `${alvo.nome} (${alvo.arquivos.length} arquivos)`;
      return;
    }
  }
  if (state.scope === 'all') {
    t.textContent = `Pasta inteira (${state.notebooks.reduce((s, n) => s + n.files.length, 0)} arquivos)`;
  } else if (state.selectedFile) {
    t.textContent = state.selectedFile.name;
  } else {
    t.textContent = 'Nenhum arquivo selecionado';
  }
}

// ------------------------------ Agrupamento por disciplina ------------------------------

// Decide o que a sidebar mostra: visão por pastas (notebooks) ou por disciplinas.
function renderSidebar() {
  updateGroupControls();
  if (state.grouping && state.groupingView === 'disciplinas') {
    renderDisciplinas();
  } else {
    renderNotebooks();
  }
  updateTitle();
}

// Carrega o mapeamento salvo e calcula o diff incremental localmente.
async function loadGrouping(folder) {
  state.grouping = null;
  state.scopeTarget = null;
  state.groupNovos = [];
  state.groupRemovidos = [];
  if (!folder) { state.groupingView = 'pastas'; return; }

  let mapping = null;
  try {
    mapping = await window.api.getGrouping(folder);
  } catch { mapping = null; }

  if (!mapping) {
    state.groupingView = 'pastas';
    return;
  }
  state.grouping = mapping;
  state.groupingView = 'disciplinas';

  // Diff incremental local sobre o scan atual (mtime/caminho).
  const atuais = state.notebooks.flatMap((n) => n.files);
  const sigs = mapping.fileSignatures || {};
  const vistos = new Set();
  const novos = [];
  for (const f of atuais) {
    vistos.add(f.path);
    const assinado = sigs[f.path];
    if (assinado === undefined || assinado !== (f.mtime || 0)) novos.push(f);
  }
  state.groupNovos = novos;
  state.groupRemovidos = Object.keys(sigs).filter((p) => !vistos.has(p));
}

// Atualiza os controles de agrupamento (modo sugerido, botões incrementais, visão).
async function updateGroupControls() {
  const actions = $('#groupActions');
  const newBtn = $('#groupNewBtn');
  const rescanBtn = $('#groupRescanBtn');
  const viewToggle = $('#groupViewToggle');
  const hint = $('#groupModeHint');

  if (!state.grouping) {
    actions.style.display = 'none';
    newBtn.style.display = 'none';
    rescanBtn.style.display = 'none';
    viewToggle.style.display = 'none';
    // Sugestão de modo para pastas ainda não agrupadas.
    if (state.root) {
      try {
        const s = await window.api.suggestGroupingMode(state.root);
        if (s && s.motivo) { hint.textContent = s.motivo; hint.style.display = 'block'; }
        else hint.style.display = 'none';
      } catch { hint.style.display = 'none'; }
    } else {
      hint.style.display = 'none';
    }
    return;
  }

  hint.style.display = 'none';
  actions.style.display = 'flex';
  rescanBtn.style.display = '';
  viewToggle.style.display = '';
  viewToggle.textContent = state.groupingView === 'disciplinas' ? 'Ver por pastas' : 'Ver por disciplina';
  if (state.groupNovos.length) {
    newBtn.style.display = '';
    newBtn.textContent = `Classificar ${state.groupNovos.length} novos`;
  } else {
    newBtn.style.display = 'none';
  }
}

// Resolve state.scopeTarget para { nome, arquivos:[path] } (ou null).
function resolveScopeTarget() {
  if (!state.grouping || !state.scopeTarget) return null;
  const disc = (state.grouping.disciplinas || []).find((d) => d.id === state.scopeTarget.discId || d.id === state.scopeTarget.id);
  if (!disc) return null;
  if (state.scopeTarget.kind === 'topico') {
    const t = (disc.topicos || []).find((x) => x.id === state.scopeTarget.id);
    if (!t) return null;
    return { nome: `${disc.nome} › ${t.nome}`, arquivos: t.arquivos || [] };
  }
  return { nome: disc.nome, arquivos: disc.arquivos || [] };
}

// Desenha disciplinas (com tópicos aninhados) reusando .notebook/.file-item.
function renderDisciplinas() {
  const wrap = $('#notebooks');
  wrap.innerHTML = '';
  const disciplinas = (state.grouping && state.grouping.disciplinas) || [];
  if (!disciplinas.length) {
    placeholder(wrap, 'Nenhuma disciplina ainda. Clique em "Organizar por disciplina".');
    return;
  }

  // Lista de destinos para o seletor de "mover arquivo".
  const destinos = disciplinas.map((d) => `<option value="${d.id}">${escapeHtml(d.nome)}</option>`).join('');

  for (const disc of disciplinas) {
    const el = document.createElement('div');
    el.className = 'notebook open';

    // Arquivos que já estão em algum tópico (não repetir no nível da disciplina).
    const emTopico = new Set();
    for (const t of disc.topicos || []) for (const p of t.arquivos || []) emTopico.add(p);

    const topicosHtml = (disc.topicos || []).map((t) => {
      const files = (t.arquivos || []).map((p) => fileItemHtml(p, destinos, disc.id)).join('');
      return `
        <div class="topico">
          <div class="topico-header"><span>🏷️ ${escapeHtml(t.nome)}</span><span class="count">${(t.arquivos || []).length}</span></div>
          <div class="notebook-files">${files}</div>
        </div>`;
    }).join('');

    const soltos = (disc.arquivos || []).filter((p) => !emTopico.has(p))
      .map((p) => fileItemHtml(p, destinos, disc.id)).join('');

    el.innerHTML = `
      <div class="notebook-header" data-disc="${disc.id}">
        <span title="${escapeHtml(disc.nome)}">📚 ${escapeHtml(disc.nome)}</span>
        <span class="count">${(disc.arquivos || []).length}</span>
      </div>
      <div class="disc-actions">
        <button class="ghost small" data-act="rename" data-disc="${disc.id}">Renomear</button>
        <button class="ghost small" data-act="merge" data-disc="${disc.id}">Mesclar</button>
        <button class="ghost small" data-act="create">Nova</button>
      </div>
      <div class="notebook-files">${topicosHtml}${soltos}</div>`;
    wrap.appendChild(el);
  }

  bindDisciplinaEvents(destinos);
}

// Monta o HTML de um arquivo da visão por disciplina (com seletor de mover).
function fileItemHtml(path, destinos, discId) {
  const nome = basenameFromPath(path);
  return `
    <div class="file-item" data-path="${encodeURIComponent(path)}" data-name="${encodeURIComponent(nome)}" title="${escapeHtml(nome)}">${escapeHtml(nome)}</div>
    <div class="file-move">
      <select data-move-path="${encodeURIComponent(path)}" data-from="${discId}" aria-label="Mover ${escapeHtml(nome)} para outra disciplina">
        <option value="">Mover para…</option>
        ${destinos}
      </select>
    </div>`;
}

// Nome do arquivo a partir do caminho absoluto (por string, igual ao núcleo).
function basenameFromPath(p) {
  const partes = String(p).replace(/\\/g, '/').split('/');
  return partes[partes.length - 1];
}

function bindDisciplinaEvents(destinos) {
  // Selecionar disciplina como escopo (clique no cabeçalho).
  $$('.notebook-header[data-disc]').forEach((h) => {
    h.addEventListener('click', () => {
      state.scope = 'file';
      $$('input[name="scope"]').forEach((r) => { r.checked = false; });
      state.selectedFile = null;
      state.scopeTarget = { kind: 'disciplina', id: h.dataset.disc };
      $$('.file-item').forEach((i) => i.classList.remove('active'));
      updateTitle();
      toast('Escopo: disciplina', 'success');
    });
  });

  // Selecionar tópico como escopo.
  $$('.topico-header').forEach((h) => {
    const disc = h.closest('.notebook').querySelector('.notebook-header[data-disc]');
    const discId = disc ? disc.dataset.disc : null;
    // tópicos: busca o id pelo nome dentro do mapeamento.
    h.addEventListener('click', (e) => {
      e.stopPropagation();
      const d = (state.grouping.disciplinas || []).find((x) => x.id === discId);
      if (!d) return;
      const nomeTop = h.querySelector('span').textContent.replace(/^🏷️\s*/, '');
      const t = (d.topicos || []).find((x) => x.nome === nomeTop);
      if (!t) return;
      state.scopeTarget = { kind: 'topico', discId, id: t.id };
      state.selectedFile = null;
      updateTitle();
      toast('Escopo: tópico', 'success');
    });
  });

  // Ações de edição.
  $$('.disc-actions button[data-act]').forEach((b) => {
    b.addEventListener('click', (e) => { e.stopPropagation(); onDiscAction(b.dataset.act, b.dataset.disc); });
  });

  // Seletor de mover arquivo.
  $$('select[data-move-path]').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const toDiscId = sel.value;
      if (!toDiscId) return;
      const path = decodeURIComponent(sel.dataset.movePath);
      await applyEdit('move', { path, toDiscId });
    });
    sel.addEventListener('click', (e) => e.stopPropagation());
  });

  // Clique num arquivo da visão por disciplina seleciona-o (escopo arquivo).
  $$('#notebooks .file-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      $$('.file-item').forEach((i) => i.classList.remove('active'));
      item.classList.add('active');
      state.scopeTarget = null;
      state.selectedFile = {
        path: decodeURIComponent(item.dataset.path),
        name: decodeURIComponent(item.dataset.name),
      };
      updateTitle();
    });
  });
}

function onDiscAction(act, discId) {
  const disciplinas = (state.grouping && state.grouping.disciplinas) || [];
  if (act === 'rename') {
    const atual = disciplinas.find((d) => d.id === discId);
    const novoNome = window.prompt('Novo nome da disciplina:', atual ? atual.nome : '');
    if (novoNome && novoNome.trim()) applyEdit('rename', { discId, novoNome: novoNome.trim() });
  } else if (act === 'create') {
    const novoNome = window.prompt('Nome da nova disciplina:', '');
    if (novoNome && novoNome.trim()) applyEdit('create', { novoNome: novoNome.trim() });
  } else if (act === 'merge') {
    const outras = disciplinas.filter((d) => d.id !== discId);
    if (!outras.length) return toast('Não há outra disciplina para mesclar.', 'error');
    const lista = outras.map((d, i) => `${i + 1}) ${d.nome}`).join('\n');
    const escolha = window.prompt('Mesclar nesta disciplina (digite o número):\n' + lista, '1');
    const idx = Number(escolha) - 1;
    if (Number.isInteger(idx) && outras[idx]) {
      applyEdit('merge', { sourceId: discId, targetId: outras[idx].id });
    }
  }
}

async function applyEdit(op, params) {
  const res = await window.api.editGrouping({ folder: state.root, op, params });
  if (!res || !res.ok) return toast((res && res.error) || 'Falha na edição.', 'error');
  state.grouping = res.mapping;
  state.scopeTarget = null;
  renderSidebar();
  toast('Agrupamento atualizado', 'success');
}

// Progresso do agrupamento — função NOVA e separada (consome outro shape/canal).
function bindGroupingProgress(container) {
  window.api.onGroupingProgress((p) => {
    const label = p.phase === 'topicos' ? 'Separando em tópicos…' : 'Classificando disciplinas…';
    const pct = p.total ? Math.round((p.current / p.total) * 100) : 0;
    container.className = 'group-progress show';
    container.innerHTML =
      `<div class="placeholder" style="margin-top:0">${label}` +
      `<br><small>${escapeHtml(p.message || '')} (${p.current || 0}/${p.total || 0})</small>` +
      `<div class="setup-progress-bar" style="margin-top:10px"><div class="setup-progress-fill" style="width:${pct}%"></div></div></div>`;
  });
}

// Roda o agrupamento. { runMode, fromScratch }
async function runGrouping({ runMode = 'full', fromScratch = false } = {}) {
  if (!state.root) return toast('Selecione uma pasta primeiro.', 'error');
  const btn = $('#groupBtn');
  const progress = $('#groupProgress');
  const subtopics = $('#subtopicsToggle').checked;

  // Lê os arquivos a enviar: full = todos; incremental = só os novos.
  let fonte;
  if (runMode === 'incremental' && !fromScratch) {
    fonte = state.groupNovos;
  } else {
    fonte = state.notebooks.flatMap((n) => n.files);
  }
  if (!fonte.length) return toast('Nenhum arquivo para agrupar.', 'error');

  const files = [];
  for (const f of fonte) {
    const r = await window.api.readFile(f.path);
    if (r.ok && typeof r.text === 'string') {
      files.push({ name: r.name || basenameFromPath(f.path), text: r.text, path: f.path, mtime: f.mtime, size: f.size });
    }
  }
  if (!files.length) return toast('Nenhum arquivo legível para agrupar.', 'error');

  btn.disabled = true;
  progress.className = 'group-progress show';
  progress.innerHTML = '<div class="placeholder" style="margin-top:0">Preparando…</div>';
  bindGroupingProgress(progress);

  const mode = (state.grouping && !fromScratch) ? state.grouping.mode : undefined;
  const res = await window.api.runGrouping({
    folder: state.root,
    files,
    mode,
    subtopics,
    fromScratch,
    runMode,
    removidos: state.groupRemovidos,
  });

  btn.disabled = false;
  progress.className = 'group-progress';
  progress.innerHTML = '';
  progress.style.display = 'none';

  if (!res || !res.ok) {
    return toast((res && res.error) || 'Falha ao agrupar.', 'error');
  }
  state.grouping = res.mapping;
  state.groupingView = 'disciplinas';
  state.scopeTarget = null;
  // Recalcula o diff local (não há novos após uma run completa dos atuais).
  await recomputeDiff();
  renderSidebar();
  toast('Agrupamento concluído', 'success');
}

// Recalcula state.groupNovos/groupRemovidos a partir do mapeamento atual.
async function recomputeDiff() {
  const mapping = state.grouping;
  if (!mapping) { state.groupNovos = []; state.groupRemovidos = []; return; }
  const atuais = state.notebooks.flatMap((n) => n.files);
  const sigs = mapping.fileSignatures || {};
  const vistos = new Set();
  const novos = [];
  for (const f of atuais) {
    vistos.add(f.path);
    const assinado = sigs[f.path];
    if (assinado === undefined || assinado !== (f.mtime || 0)) novos.push(f);
  }
  state.groupNovos = novos;
  state.groupRemovidos = Object.keys(sigs).filter((p) => !vistos.has(p));
}

// Lê o texto de UM arquivo (escopo "arquivo selecionado").
async function gatherText() {
  if (!state.selectedFile) return { ok: false, error: 'Selecione um arquivo primeiro.' };
  const r = await window.api.readFile(state.selectedFile.path);
  if (!r.ok) return { ok: false, error: 'Não consegui ler o arquivo: ' + r.error };
  return { ok: true, text: r.text, title: state.selectedFile.name };
}

// Lê TODOS os arquivos da pasta e devolve um array {name, text, path, mtime, size}.
// Os metadados (path/mtime/size) permitem cachear o resumo parcial de cada
// arquivo e reaproveitá-lo nas próximas gerações (mapa, exercícios).
async function gatherFiles() {
  const allFiles = state.notebooks.flatMap((n) => n.files);
  if (!allFiles.length) return { ok: false, error: 'A pasta não tem arquivos.' };
  const out = [];
  for (const f of allFiles) {
    const r = await window.api.readFile(f.path);
    if (r.ok && r.text && r.text.trim()) {
      out.push({ name: r.name, text: r.text, path: f.path, mtime: f.mtime, size: f.size });
    }
  }
  if (!out.length) return { ok: false, error: 'Nenhum arquivo legível na pasta.' };
  return { ok: true, files: out };
}

// Lê os arquivos do escopo de disciplina/tópico selecionado (igual gatherFiles,
// mas a origem é a lista do mapeamento, não os notebooks).
async function gatherFilesForScope() {
  const alvo = resolveScopeTarget();
  if (!alvo || !alvo.arquivos.length) return { ok: false, error: 'Selecione uma disciplina ou tópico com arquivos.' };
  // Reusa os metadados do scan (mtime/size) quando disponíveis.
  const metaPorPath = {};
  for (const f of state.notebooks.flatMap((n) => n.files)) metaPorPath[f.path] = f;
  const out = [];
  for (const path of alvo.arquivos) {
    const r = await window.api.readFile(path);
    if (r.ok && r.text && r.text.trim()) {
      const meta = metaPorPath[path] || {};
      out.push({ name: r.name || basenameFromPath(path), text: r.text, path, mtime: meta.mtime, size: meta.size });
    }
  }
  if (!out.length) return { ok: false, error: 'Nenhum arquivo legível neste escopo.' };
  return { ok: true, files: out };
}

// Mostra progresso do map-reduce no container (arquivo X de N).
// Distingue quando está lendo do zero de quando reaproveita o cache (rápido).
function bindFolderProgress(container, label) {
  window.api.onAiProgress((p) => {
    if (p.phase === 'reduce') {
      spinner(container, p.message || 'Combinando resultados…');
    } else if (p.total) {
      const pct = Math.round((p.current / p.total) * 100);
      const acao = p.cached ? '⚡ Reaproveitando' : 'Lendo';
      container.innerHTML =
        `<div class="spinner"></div><div class="placeholder">${label}<br>` +
        `<small>${acao} arquivo ${p.current} de ${p.total}: ${escapeHtml(p.name || '')}</small>` +
        `<div class="setup-progress-bar" style="margin-top:14px"><div class="setup-progress-fill" style="width:${pct}%"></div></div></div>`;
    }
  });
}

// Mostra o texto surgindo em tempo real (streaming) no container.
function bindStreaming(container) {
  window.api.onAiToken((texto) => {
    container.innerHTML = renderMarkdown(texto);
    container.scrollTop = container.scrollHeight;
  });
}

// ------------------------------ IA: ações ------------------------------
async function doSummary() {
  const out = $('#summaryOutput');
  const opts = {
    nivel: $('#summaryLevel').value,
    foco: $('#summaryFoco').value,
    idioma: state.idioma,
    model: state.model,
  };
  let res;
  bindStreaming(out);
  if (state.scopeTarget) {
    const g = await gatherFilesForScope();
    if (!g.ok) return toast(g.error, 'error');
    spinner(out, 'Resumindo a disciplina');
    bindFolderProgress(out, 'Resumindo a disciplina');
    res = await window.api.summaryFolder(g.files, opts);
  } else if (state.scope === 'all') {
    const g = await gatherFiles();
    if (!g.ok) return toast(g.error, 'error');
    spinner(out, 'Resumindo a pasta inteira');
    bindFolderProgress(out, 'Resumindo a pasta inteira');
    res = await window.api.summaryFolder(g.files, opts);
  } else {
    const g = await gatherText();
    if (!g.ok) return toast(g.error, 'error');
    if (!g.text) return toast('O conteúdo está vazio.', 'error');
    spinner(out, 'Resumindo');
    res = await window.api.summary(g.text, opts);
  }
  if (!res.ok) { placeholder(out, '⚠️ ' + res.error); return toast(res.error, 'error'); }
  out.innerHTML = renderMarkdown(res.text);
  renderizarMermaid(out);
  state.lastResults.summary = { text: res.text };
  toast('Resumo pronto (' + res.model + ')', 'success');
}

async function doMindmap() {
  const out = $('#mindmapOutput');
  const opts = { model: state.model, idioma: state.idioma };
  let res;
  if (state.scopeTarget) {
    const g = await gatherFilesForScope();
    if (!g.ok) return toast(g.error, 'error');
    spinner(out, 'Montando o mapa da disciplina');
    bindFolderProgress(out, 'Montando o mapa da disciplina');
    res = await window.api.mindmapFolder(g.files, opts);
  } else if (state.scope === 'all') {
    const g = await gatherFiles();
    if (!g.ok) return toast(g.error, 'error');
    spinner(out, 'Montando o mapa da pasta');
    bindFolderProgress(out, 'Montando o mapa da pasta');
    res = await window.api.mindmapFolder(g.files, opts);
  } else {
    const g = await gatherText();
    if (!g.ok) return toast(g.error, 'error');
    spinner(out, 'Montando o mapa mental');
    res = await window.api.mindmap(g.text, opts);
  }
  if (!res.ok) { placeholder(out, '⚠️ ' + res.error); return toast(res.error, 'error'); }
  renderMindmap(out, res.map);
  state.lastResults.mindmap = { map: res.map };
  toast('Mapa mental pronto', 'success');
}

async function doExercises() {
  const out = $('#exercisesOutput');
  const opts = {
    quantidade: Number($('#exQtd').value),
    tipo: $('#exTipo').value,
    idioma: state.idioma,
    model: state.model,
  };
  let res;
  bindStreaming(out);
  if (state.scopeTarget) {
    const g = await gatherFilesForScope();
    if (!g.ok) return toast(g.error, 'error');
    spinner(out, 'Criando exercícios da disciplina');
    bindFolderProgress(out, 'Criando exercícios da disciplina');
    res = await window.api.exercisesFolder(g.files, opts);
  } else if (state.scope === 'all') {
    const g = await gatherFiles();
    if (!g.ok) return toast(g.error, 'error');
    spinner(out, 'Criando exercícios da pasta');
    bindFolderProgress(out, 'Criando exercícios da pasta');
    res = await window.api.exercisesFolder(g.files, opts);
  } else {
    const g = await gatherText();
    if (!g.ok) return toast(g.error, 'error');
    spinner(out, 'Criando exercícios');
    res = await window.api.exercises(g.text, opts);
  }
  if (!res.ok) { placeholder(out, '⚠️ ' + res.error); return toast(res.error, 'error'); }
  out.innerHTML = renderMarkdown(res.text);
  renderizarMermaid(out);
  state.lastResults.exercises = { text: res.text };
  toast('Exercícios prontos', 'success');
}

// Paleta suave para colorir os ramos (estilo mapa mental).
const MM_COLORS = ['#89b4fa', '#f9e2af', '#a6e3a1', '#f5c2e7', '#fab387', '#94e2d5'];

// Desenha o mapa mental em layout RADIAL: tema central no meio e os ramos
// distribuídos em círculo ao redor, com linhas conectando cada um ao centro.
function renderMindmap(container, map) {
  container.innerHTML = '';
  const stage = document.createElement('div');
  stage.className = 'mm-stage';
  container.appendChild(stage);

  // Camada SVG para as linhas de conexão (fica atrás dos cartões).
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'mm-links');
  stage.appendChild(svg);

  // Nó central.
  const central = document.createElement('div');
  central.className = 'mm-central';
  central.textContent = map.central;
  stage.appendChild(central);

  const nodes = map.nodes || [];
  const branchEls = [];

  // Cria os cartões dos ramos posicionados em círculo.
  nodes.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2; // começa no topo
    const color = MM_COLORS[i % MM_COLORS.length];

    const branch = document.createElement('div');
    branch.className = 'mm-node';
    branch.dataset.angle = angle;

    let childrenHtml = '';
    for (const c of node.children || []) {
      const titulo = typeof c === 'string' ? c : (c.titulo || '');
      const descricao = typeof c === 'string' ? '' : (c.descricao || '');
      childrenHtml += `<div class="mm-sub"><span class="mm-sub-title">${escapeHtml(titulo)}</span>${descricao ? `<span class="mm-sub-desc">${escapeHtml(descricao)}</span>` : ''}</div>`;
    }

    branch.innerHTML =
      `<div class="mm-node-title" style="background:${color}">${escapeHtml(node.title)}</div>` +
      `<div class="mm-node-body">${childrenHtml}</div>`;
    stage.appendChild(branch);
    branchEls.push({ el: branch, angle, color });
  });

  // Posiciona os elementos depois que o layout tem tamanho conhecido.
  const layout = () => {
    // O palco é uma tela fixa e grande, maior que a área visível: assim dá para
    // navegar por barras de rolagem E por arraste (pan). O raio cresce com o
    // número de ramos para evitar sobreposição.
    const W = Math.max(container.clientWidth, 900, 260 + nodes.length * 90);
    const H = Math.max(container.clientHeight, 640, 240 + nodes.length * 70);
    stage.style.width = W + 'px';
    stage.style.height = H + 'px';
    const cx = W / 2;
    const cy = H / 2;

    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = '';

    central.style.left = cx - central.offsetWidth / 2 + 'px';
    central.style.top = cy - central.offsetHeight / 2 + 'px';

    // Raio proporcional ao palco e ao número de ramos.
    const radius = Math.min(W, H) * 0.34 + 40;

    branchEls.forEach(({ el, angle, color }) => {
      const bx = cx + radius * Math.cos(angle);
      const by = cy + radius * Math.sin(angle);
      el.style.left = bx - el.offsetWidth / 2 + 'px';
      el.style.top = by - el.offsetHeight / 2 + 'px';

      const path = document.createElementNS(svgNS, 'path');
      const mx = (cx + bx) / 2;
      path.setAttribute('d', `M ${cx} ${cy} Q ${mx} ${cy} ${bx} ${by}`);
      path.setAttribute('stroke', color);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke-width', '2.5');
      path.setAttribute('opacity', '0.6');
      svg.appendChild(path);
    });

    // Centraliza a visão inicial no nó central.
    container.scrollLeft = (W - container.clientWidth) / 2;
    container.scrollTop = (H - container.clientHeight) / 2;
  };

  requestAnimationFrame(layout);
  if (renderMindmap._resize) window.removeEventListener('resize', renderMindmap._resize);
  renderMindmap._resize = () => layout();
  window.addEventListener('resize', renderMindmap._resize);

  // ---- Navegação por arraste (pan) do mouse ----
  habilitarPan(container, stage);
}

// Permite arrastar com o mouse para navegar (pan), além das barras de rolagem.
function habilitarPan(container, stage) {
  let arrastando = false, startX = 0, startY = 0, scrollX = 0, scrollY = 0, moveu = false;

  const onDown = (e) => {
    // Não inicia arraste ao clicar num cartão clicável (deixa o clique normal).
    if (e.button !== 0) return;
    arrastando = true; moveu = false;
    startX = e.clientX; startY = e.clientY;
    scrollX = container.scrollLeft; scrollY = container.scrollTop;
    container.classList.add('grabbing');
  };
  const onMove = (e) => {
    if (!arrastando) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moveu = true;
    container.scrollLeft = scrollX - dx;
    container.scrollTop = scrollY - dy;
  };
  const onUp = () => { arrastando = false; container.classList.remove('grabbing'); };

  container.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  // Evita que um arraste vire clique acidental num nó.
  container.addEventListener('click', (e) => { if (moveu) { e.stopPropagation(); e.preventDefault(); } }, true);
}

// ------------------------------ Exportar ------------------------------
async function exportKind(kind) {
  const payload = state.lastResults[kind];
  if (!payload) return toast('Gere o conteúdo antes de exportar.', 'error');
  const title = state.scope === 'all' ? 'Pasta inteira' : (state.selectedFile?.name || 'estudo');
  const res = await window.api.exportSave(title, kind, payload);
  if (res && res.ok) toast('Exportado: ' + res.path, 'success');
  else if (res && res.error) toast('Erro ao exportar: ' + res.error, 'error');
}

// ------------------------------ IA: status ------------------------------
async function refreshAiStatus() {
  const el = $('#aiStatus');
  const st = await window.api.aiStatus();
  if (st.ok) {
    el.className = 'ai-status ok';
    el.textContent = `IA local ativa · ${st.models.length} modelo(s)`;
    populateModels(st.models);
  } else {
    el.className = 'ai-status bad';
    el.textContent = 'IA offline — abra o Ollama';
  }
}

// Preenche o dropdown de modelos instalados e mantém a seleção atual.
function populateModels(models) {
  const sel = $('#modelSelect');
  if (!models || !models.length) return;
  const atual = state.model;
  // Só recria se a lista mudou (evita resetar durante uso).
  const existentes = Array.from(sel.options).map((o) => o.value);
  const igual = existentes.length === models.length && existentes.every((v, i) => v === models[i]);
  if (igual) return;

  sel.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    sel.appendChild(opt);
  }
  // Mantém o salvo se ainda existir; senão usa o primeiro.
  if (atual && models.includes(atual)) sel.value = atual;
  else { state.model = models[0]; window.api.setModel(models[0]); sel.value = models[0]; }
}

// Baixa um novo modelo pela interface, mostrando progresso.
async function pullNewModel() {
  const model = $('#modelToPull').value;
  const wrap = $('#pullProgress');
  const fill = $('#pullFill');
  const msg = $('#pullMsg');
  const btn = $('#pullModelBtn');
  wrap.style.display = 'block';
  btn.disabled = true;
  msg.textContent = 'Iniciando download…';

  window.api.onSetupProgress((p) => {
    if (p.phase === 'model') {
      fill.style.width = (p.percent || 0) + '%';
      msg.textContent = `${p.message || 'Baixando'} ${p.percent || 0}%`;
    }
  });

  const res = await window.api.pullModel(model);
  btn.disabled = false;
  if (res.ok) {
    msg.textContent = 'Modelo baixado!';
    fill.style.width = '100%';
    toast('Modelo ' + model + ' pronto', 'success');
    await refreshAiStatus();
    state.model = model;
    await window.api.setModel(model);
    $('#modelSelect').value = model;
  } else {
    msg.textContent = '⚠️ ' + res.error;
    toast('Erro ao baixar: ' + res.error, 'error');
  }
}

// ------------------------------ Eventos ------------------------------
function bindEvents() {
  $('#pickFolderBtn').addEventListener('click', async () => {
    const folder = await window.api.pickFolder();
    if (folder) { await loadLibrary(folder); toast('Pasta carregada', 'success'); }
  });

  $$('input[name="scope"]').forEach((r) =>
    r.addEventListener('change', (e) => { state.scope = e.target.value; state.scopeTarget = null; updateTitle(); })
  );

  // Agrupamento por disciplina.
  $('#groupBtn').addEventListener('click', () => runGrouping({ runMode: 'full', fromScratch: false }));
  $('#groupNewBtn').addEventListener('click', () => runGrouping({ runMode: 'incremental', fromScratch: false }));
  $('#groupRescanBtn').addEventListener('click', () => runGrouping({ runMode: 'full', fromScratch: true }));
  $('#groupViewToggle').addEventListener('click', () => {
    state.groupingView = state.groupingView === 'disciplinas' ? 'pastas' : 'disciplinas';
    state.scopeTarget = null;
    renderSidebar();
  });

  $$('.tab').forEach((tab) =>
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
      $$('.panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      $('#panel-' + tab.dataset.tab).classList.add('active');
    })
  );

  $('#genSummary').addEventListener('click', doSummary);
  $('#genMindmap').addEventListener('click', doMindmap);
  $('#genExercises').addEventListener('click', doExercises);

  $('#exportSummary').addEventListener('click', () => exportKind('summary'));
  $('#exportMindmap').addEventListener('click', () => exportKind('mindmap'));
  $('#exportExercises').addEventListener('click', () => exportKind('exercises'));

  // Troca de modelo
  $('#modelSelect').addEventListener('change', async (e) => {
    state.model = e.target.value;
    await window.api.setModel(state.model);
    toast('Modelo: ' + state.model, 'success');
  });
  $('#pullModelBtn').addEventListener('click', pullNewModel);

  // Idioma do resultado (vale para resumo, mapa mental e exercícios).
  $('#langSelect').addEventListener('change', (e) => {
    state.idioma = e.target.value;
    window.api.cacheSet('ui:idioma', state.idioma);
    const sel = e.target;
    const label = sel.options[sel.selectedIndex].textContent;
    toast('Idioma do resultado: ' + label, 'success');
  });

  // Auto-atualização quando a pasta muda.
  window.api.onLibraryChanged(async () => {
    await loadLibrary(state.root);
    toast('Biblioteca atualizada automaticamente', 'success');
  });
}

// ------------------------------ Atualização do app ------------------------------
// Verifica o GitHub e, se houver versão nova, mostra um aviso no topo do app.
async function checkForUpdates() {
  let info;
  try {
    info = await window.api.updateCheck();
  } catch {
    return; // sem internet / falha silenciosa: não atrapalha o uso
  }
  if (!info || !info.ok) return;        // erro de rede: ignora silenciosamente
  if (!info.updateAvailable) return;    // já está atualizado

  const banner = $('#updateBanner');
  const text = $('#updateText');
  const applyBtn = $('#updateApplyBtn');
  const repoBtn = $('#updateRepoBtn');

  text.textContent = info.message || 'Há uma nova versão disponível.';

  if (info.canApply) {
    applyBtn.style.display = '';
    repoBtn.style.display = 'none';
  } else {
    // Versão empacotada (sem git): só dá para abrir o GitHub.
    applyBtn.style.display = 'none';
    repoBtn.style.display = '';
  }
  banner.style.display = 'flex';
}

// Executa a atualização (git pull + npm install) mostrando progresso no banner.
async function applyUpdate() {
  const banner = $('#updateBanner');
  const text = $('#updateText');
  const applyBtn = $('#updateApplyBtn');
  const dismissBtn = $('#updateDismissBtn');

  applyBtn.disabled = true;
  dismissBtn.disabled = true;
  banner.className = 'update-banner updating';
  text.textContent = 'Iniciando atualização…';

  window.api.onUpdateProgress((p) => {
    if (p && p.message) text.textContent = p.message;
  });

  const res = await window.api.updateApply();
  applyBtn.disabled = false;
  dismissBtn.disabled = false;

  if (res && res.ok) {
    banner.className = 'update-banner done';
    applyBtn.style.display = 'none';
    toast('Atualização concluída', 'success');

    // Reinicia sozinho para carregar a nova versão (com contagem regressiva).
    const restartBtn = $('#updateApplyBtn');
    restartBtn.textContent = 'Reiniciar agora';
    restartBtn.style.display = '';
    restartBtn.disabled = false;
    restartBtn.onclick = () => window.api.updateRestart();
    dismissBtn.textContent = 'Reiniciar depois';

    let segundos = 5;
    const atualizarTexto = () => {
      text.textContent = `Atualizado! Reiniciando em ${segundos}s para aplicar a nova versão…`;
    };
    atualizarTexto();
    const timer = setInterval(() => {
      segundos -= 1;
      if (segundos <= 0) {
        clearInterval(timer);
        window.api.updateRestart();
      } else {
        atualizarTexto();
      }
    }, 1000);

    // "Reiniciar depois" cancela a contagem e deixa o usuário continuar.
    dismissBtn.onclick = () => {
      clearInterval(timer);
      text.textContent = 'Atualizado! A nova versão será usada quando você reabrir o app.';
      restartBtn.textContent = 'Reiniciar agora';
    };
  } else {
    banner.className = 'update-banner error';
    text.textContent = '⚠️ ' + ((res && res.error) || 'Falha ao atualizar.');
    toast('Falha ao atualizar', 'error');
  }
}

function bindUpdateEvents() {
  // Usamos onclick (não addEventListener) porque applyUpdate reatribui esses
  // handlers depois de concluir — assim não ficam dois ouvintes empilhados.
  $('#updateApplyBtn').onclick = applyUpdate;
  $('#updateRepoBtn').onclick = () => window.api.updateOpenRepo();
  $('#updateDismissBtn').onclick = () => {
    $('#updateBanner').style.display = 'none';
  };
}

// ------------------------------ Auto-setup ------------------------------
function setupUI() {
  return {
    overlay: $('#setupOverlay'),
    title: $('#setupTitle'),
    message: $('#setupMessage'),
    progressWrap: $('#setupProgressWrap'),
    fill: $('#setupProgressFill'),
    percent: $('#setupPercent'),
    stepOllama: $('#step-ollama'),
    stepModel: $('#step-model'),
    startBtn: $('#setupStartBtn'),
    retryBtn: $('#setupRetryBtn'),
    note: $('#setupNote'),
  };
}

function showProgress(ui, show) {
  ui.progressWrap.style.display = show ? 'block' : 'none';
}
function setProgress(ui, percent) {
  ui.fill.style.width = (percent || 0) + '%';
  ui.percent.textContent = (percent || 0) + '%';
}

// Executa o fluxo completo de preparação. Retorna true se o app está pronto.
async function runSetup() {
  const ui = setupUI();
  ui.overlay.style.display = 'flex';
  ui.startBtn.style.display = 'none';
  ui.retryBtn.style.display = 'none';
  ui.note.className = 'setup-note';

  // Recebe progresso do processo principal.
  window.api.onSetupProgress((p) => {
    ui.message.textContent = p.message || '';
    showProgress(ui, true);
    setProgress(ui, p.percent);
    if (p.phase === 'download' || p.phase === 'install') ui.stepOllama.classList.add('active');
    if (p.phase === 'model') {
      ui.stepOllama.classList.remove('active');
      ui.stepOllama.classList.add('done');
      ui.stepModel.classList.add('active');
    }
  });

  ui.message.textContent = 'Verificando a IA local…';
  let st = await window.api.setupCheck();

  if (st.ready) {
    finishSetup(ui);
    return true;
  }

  // Precisa instalar algo: mostra o botão e espera o usuário confirmar.
  const faltando = [];
  if (!st.ollamaInstalled) faltando.push('a IA local (Ollama)');
  if (!st.hasModel) faltando.push('o modelo de linguagem');
  ui.message.textContent = 'Falta instalar: ' + faltando.join(' e ') + '.';
  ui.startBtn.style.display = 'block';

  return new Promise((resolve) => {
    const doInstall = async () => {
      ui.startBtn.style.display = 'none';
      ui.retryBtn.style.display = 'none';
      ui.note.className = 'setup-note';
      try {
        // 1. Ollama, se necessário.
        st = await window.api.setupCheck();
        if (!st.serverUp) {
          ui.stepOllama.classList.add('active');
          ui.message.textContent = 'Instalando a IA local…';
          const r = await window.api.setupInstallOllama();
          if (!r.ok) throw new Error(r.error);
        }
        ui.stepOllama.classList.remove('active');
        ui.stepOllama.classList.add('done');

        // 2. Modelo, se necessário.
        st = await window.api.setupCheck();
        if (!st.hasModel) {
          ui.stepModel.classList.add('active');
          ui.message.textContent = 'Baixando o modelo (pode demorar)…';
          const r = await window.api.setupPullModel(st.model);
          if (!r.ok) throw new Error(r.error);
        }
        ui.stepModel.classList.remove('active');
        ui.stepModel.classList.add('done');

        // 3. Confirmação final.
        st = await window.api.setupCheck();
        if (!st.ready) throw new Error('A preparação terminou, mas a IA ainda não respondeu. Tente de novo.');
        finishSetup(ui);
        resolve(true);
      } catch (e) {
        ui.message.textContent = '⚠️ ' + e.message;
        ui.note.className = 'setup-note error';
        ui.note.textContent = 'Você pode tentar de novo ou instalar o Ollama manualmente em ollama.com.';
        ui.retryBtn.style.display = 'block';
        showProgress(ui, false);
      }
    };

    ui.startBtn.onclick = doInstall;
    ui.retryBtn.onclick = doInstall;
  });
}

function finishSetup(ui) {
  ui.stepOllama.classList.add('done');
  ui.stepModel.classList.add('done');
  ui.message.textContent = 'Tudo pronto!';
  setProgress(ui, 100);
  setTimeout(() => { ui.overlay.style.display = 'none'; }, 600);
}

// ------------------------------ Init ------------------------------
(async function init() {
  bindEvents();
  bindUpdateEvents();

  // Primeiro garante que a IA local está pronta (auto-setup).
  await runSetup();

  // Carrega o modelo salvo antes de listar (para manter a escolha do usuário).
  state.model = await window.api.getModel();

  // Restaura o idioma de saída escolhido anteriormente.
  const idiomaSalvo = await window.api.cacheGet('ui:idioma');
  if (idiomaSalvo) {
    state.idioma = idiomaSalvo;
    const sel = $('#langSelect');
    if (Array.from(sel.options).some((o) => o.value === idiomaSalvo)) sel.value = idiomaSalvo;
  }

  await refreshAiStatus();
  setInterval(refreshAiStatus, 15000);

  const saved = await window.api.getSavedFolder();
  if (saved) await loadLibrary(saved);

  placeholder($('#summaryOutput'), 'Selecione um arquivo (ou a pasta inteira) e clique em "Gerar resumo".');
  placeholder($('#mindmapOutput'), 'Selecione um arquivo (ou a pasta inteira) e clique em "Gerar mapa mental".');
  placeholder($('#exercisesOutput'), 'Escolha as opções e clique em "Gerar exercícios".');

  // Verifica atualizações no GitHub em segundo plano (não bloqueia o uso).
  checkForUpdates();
})();
